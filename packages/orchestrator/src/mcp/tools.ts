import {
  CONDUCTOR_WORKFLOW_ID,
  CreateTicketRequestSchema,
  EntryCheckSchema,
  REPO_CHECKS_MAX,
  checksGatesOf,
  TicketKindSchema,
  httpForApplyResult,
  transitionsOf,
  type EngineEvent,
  type EngineRoute,
  type SessionDetail,
  type TicketStatus,
  validateWorkflow,
  type WorkflowDefinition,
} from '@conductor/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import type { RequestAuth } from '../auth/middleware.js';
import type { BoardBus, EngineService, OutputBus } from '../contracts.js';
import type { Db } from '../main.js';
import { listMachineRows } from '../api/machines.js';
import { loadBoard, loadWorkflowDetail } from '../api/queries.js';
import {
  clearRepoChecks,
  getRepoChecks,
  listRepoChecks,
  setRepoChecks,
} from '../api/repo-checks.js';
import { loadSessionDetail } from '../api/sessions.js';
import { insertWorkflowVersion, weakenedApprovals } from '../api/workflows.js';
import { pathString } from '../api/errors.js';
import { createTicket } from '../api/tickets.js';
import { reopenSession } from '../engine/reopen.js';
import { conductorDefaultAvailable, newestShippedConductor } from '../engine/seed.js';
import { capJson, TRUNCATED } from './cap.js';

// ADR-0028: the MCP tools, one McpServer per request bound to the caller (stateless). Each tool
// is scoped to the token's account: another account's ticket is "not found", like an unknown
// one. Writes go through the same code as the board's buttons (TD: recorded as the `ui` actor).
//
// The tool set is deliberately small (Ben approved it, 2026-10-30). ADR-0030: conductor is
// MCP-first for managing workflows, so every way to change what a workflow runs has a tool: the
// per-repo checks (list/get/set/clear_repo_checks), reading the workflow (get_workflow), and
// saving it (save_workflow, adopt_default_workflow; ADR-0030 §Amendment: instance admins or local
// mode only, because workflows are instance-wide, and never weakening `requires.approvals`).
// Never exposed: approvals (`ui.approve`, a transition's `requires.approvals`), permission prompts
// (ADR-0023), fresh conversations, machine enrollment, team and admin, transcripts and output.

export interface ToolDeps {
  db: Db;
  engine: EngineService;
  boardBus: BoardBus;
  outputBus: OutputBus;
  auth: AuthConfig;
  /** The public origin, for links. */
  issuer: string;
}

export const MCP_INSTRUCTIONS =
  'conductor runs Claude Code agents on tickets that move across a board. Start with ' +
  'list_tickets (needs_input=true shows what waits on the user) or search_tickets. Ticket refs ' +
  'accept the full id or its first 8 characters. Call get_ticket before answer_input or ' +
  'take_transition: it shows the open question and the allowed transition names. Approvals and ' +
  'agent permission prompts are answered on the board, not here. A repo whose build or tests ' +
  "don't fit the workflow's default checks gets its own with set_repo_checks (get_repo_checks " +
  'shows what runs now); get_workflow shows the workflow itself, and admins change it with ' +
  'save_workflow.';

/** ADR-0030: how a repo check runs, for the tools' descriptions. */
const REPO_CHECKS_HOW =
  'Every command runs with `sh -c` at the root of a fresh checkout of the commit being shipped ' +
  '(Git Bash on Windows machines, so write bash: `cd m-one && npm ci && npm run build`, ' +
  'forward slashes, quoted Windows paths). `setup` runs once before the checks: omit it to ' +
  "auto-detect from the root lockfile, '' for none. The checks replace the workflow's on every " +
  'transition that runs checks, for tickets on this repo only.';

/** api/index.ts UI_ACTOR (not imported: index.ts registers this module). TD: an `mcp` actor. */
const UI_ACTOR = 'ui';
const TITLE_MAX = 120;
const QUESTION_MAX = 160;
const BODY_MAX = 4000;
const SNIPPET_MAX = 200;
const MACHINE_REPOS_MAX = 10;
/** save_workflow: the largest definition accepted, as JSON. */
const WORKFLOW_MAX_BYTES = 256 * 1024;
/** save_workflow: at most this many validator errors in the result. */
const WORKFLOW_ERRORS_MAX = 50;

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** list_tickets' `status` filter over ticket.status. `open` keeps failed tickets (they need a human). */
const STATUS_FILTER: Record<'open' | 'done' | 'cancelled', ReadonlySet<TicketStatus>> = {
  open: new Set(['ready', 'claimed', 'in_progress', 'failed']),
  done: new Set(['done']),
  cancelled: new Set(['cancelled']),
};

/** `s` as a literal ILIKE pattern (backslash is the escape). */
export const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** ≤ SNIPPET_MAX chars of `text` around the first case-insensitive `query`, or its start. */
export function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - 60);
  const cut = flat.slice(start, start + SNIPPET_MAX - 2);
  return ((start > 0 ? '…' : '') + cut + (start + cut.length < flat.length ? '…' : '')).slice(
    0,
    SNIPPET_MAX,
  );
}

/**
 * The names of the human transitions out of the session's state that carry `requires.approvals`
 * (ADR-0020 §5). Conservative: a transition counts whenever approvals are defined, even when the
 * PR touches none of their paths, so MCP never takes a move a human may have to approve (U-093).
 */
export function approvalGated(detail: Pick<SessionDetail, 'workflow' | 'card'>): Set<string> {
  const state = detail.card.workflow_state;
  if (state === null) return new Set();
  return new Set(
    transitionsOf(detail.workflow, state, { actor: 'human' })
      .filter((e) => (e.transition.requires?.approvals?.length ?? 0) > 0)
      .map((e) => e.name),
  );
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** A result: the JSON (capped) as one text block. */
function ok(value: unknown): ToolResult {
  const capped = capJson(value);
  const out = capped.truncated
    ? { ...(capped.value as object), truncated: true }
    : (capped.value as object);
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

/** A tool error: `{error: {code, message}}`. */
function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }],
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Resolved = { id: string; title: string } | { error: ToolResult };

/** A ticket ref (uuid, or ≥ 8 hex of it) inside the account. */
export async function resolveTicket(db: Db, accountId: string, ref: string): Promise<Resolved> {
  const r = ref.trim().toLowerCase();
  let rows: { id: string; title: string }[];
  if (UUID_RE.test(r)) {
    rows = (
      await db.query<{ id: string; title: string }>(
        'SELECT id, title FROM ticket WHERE account_id = $1 AND id = $2',
        [accountId, r],
      )
    ).rows;
  } else if (/^[0-9a-f]{8,32}$/.test(r.replace(/-/g, ''))) {
    rows = (
      await db.query<{ id: string; title: string }>(
        "SELECT id, title FROM ticket WHERE account_id = $1 AND replace(id::text, '-', '') " +
          "LIKE $2 || '%' ORDER BY created_at DESC LIMIT 6",
        [accountId, r.replace(/-/g, '')],
      )
    ).rows;
  } else {
    return {
      error: fail(
        'invalid_input',
        'A ticket ref is its id, or at least its first 8 hex characters.',
      ),
    };
  }
  if (rows.length === 0) {
    return { error: fail('not_found', `No ticket ${ref} in this account. Try list_tickets.`) };
  }
  if (rows.length > 1) {
    return {
      error: fail('ambiguous_ref', `${ref} matches several tickets; use more characters.`, {
        candidates: rows.slice(0, 5).map((t) => ({ id: t.id, title: clip(t.title, TITLE_MAX) })),
      }),
    };
  }
  return rows[0]!;
}

async function latestSessionId(
  db: Db,
  accountId: string,
  ticketId: string,
): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM session WHERE ticket_id = $1 AND account_id = $2 ORDER BY created_at DESC LIMIT 1',
    [ticketId, accountId],
  );
  return r.rows[0]?.id ?? null;
}

async function openInputRequestId(db: Db, sessionId: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM input_request WHERE session_id = $1 AND answer IS NULL ' +
      'ORDER BY created_at DESC LIMIT 1',
    [sessionId],
  );
  return r.rows[0]?.id ?? null;
}

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

export function buildMcpServer(deps: ToolDeps, who: RequestAuth): McpServer {
  const { db, engine, outputBus } = deps;
  const accountId = who.scope.account_id;
  const server = new McpServer(
    { name: 'conductor', version: '1.0.0' },
    { instructions: MCP_INSTRUCTIONS },
  );

  /** Apply one engine event and turn the outcome into a tool result. */
  const apply = async (route: EngineRoute, sessionId: string, event: EngineEvent) => {
    const result = await engine.applyEvent(sessionId, event, { actor: UI_ACTOR });
    if (result.status === 'applied') return ok({ ok: true });
    const { code } = httpForApplyResult(route, result);
    return fail(code, `${event.type}: ${result.reason}`);
  };

  /** The ticket's latest session, or a tool error when it has none yet. */
  const sessionOf = async (ref: string) => {
    const t = await resolveTicket(db, accountId, ref);
    if ('error' in t) return t;
    const sid = await latestSessionId(db, accountId, t.id);
    if (sid === null) {
      return { error: fail('wrong_state', 'The ticket is still queued: no agent has started it.') };
    }
    return { ticket: t, sessionId: sid };
  };

  server.registerTool(
    'list_tickets',
    {
      title: 'List tickets',
      description:
        'The account’s tickets, most recently updated first: id, title, board column, state, ' +
        'status, and the open question when one waits on the user. Open tickets by default.',
      inputSchema: {
        needs_input: z.boolean().optional().describe('Only tickets waiting on the user'),
        column: z.string().max(60).optional().describe('Only this board column id'),
        kind: TicketKindSchema.optional().describe('Only work or personal tickets'),
        repo: z.string().max(200).optional().describe('Only this repo (host/org/repo)'),
        status: z
          .enum(['open', 'done', 'cancelled', 'all'])
          .optional()
          .describe('Default open (includes failed)'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
      },
      annotations: readOnly,
    },
    async ({ needs_input, column, kind, repo, status, limit }) => {
      const [board, own] = await Promise.all([
        loadBoard(db),
        db.query<{ id: string; status: TicketStatus }>(
          'SELECT id, status FROM ticket WHERE account_id = $1',
          [accountId],
        ),
      ]);
      const wanted = status === 'all' ? null : STATUS_FILTER[status ?? 'open'];
      const mine = new Set(
        own.rows.filter((r) => wanted === null || wanted.has(r.status)).map((r) => r.id),
      );
      const rows = board.columns
        .flatMap((c) => c.cards)
        .filter((c) => mine.has(c.ticket_id))
        .filter((c) => needs_input === undefined || (c.input_request !== null) === needs_input)
        .filter((c) => column === undefined || c.column === column)
        .filter((c) => kind === undefined || c.kind === kind)
        .filter((c) => repo === undefined || c.repo.toLowerCase() === repo.trim().toLowerCase())
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const page = rows.slice(0, limit ?? 20).map((c) => ({
        id: c.ticket_id,
        short_id: c.ticket_id.slice(0, 8),
        title: clip(c.title, TITLE_MAX),
        column: c.column,
        state: c.workflow_state,
        status: c.status,
        kind: c.kind,
        repo: c.repo,
        needs_input: c.input_request !== null,
        ...(c.input_request ? { question: clip(c.input_request.question, QUESTION_MAX) } : {}),
        ...(c.pr_url ? { pr_url: c.pr_url } : {}),
        updated_at: c.updated_at,
      }));
      return ok({ tickets: page, total: rows.length });
    },
  );

  server.registerTool(
    'search_tickets',
    {
      title: 'Search tickets',
      description:
        'Find tickets of any status by a word or phrase in the title, external ref or body, or ' +
        'by the start of the id. Most recently updated first; call get_ticket for one.',
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(20).optional().describe('Default 10'),
      },
      annotations: readOnly,
    },
    async ({ query, limit }) => {
      const hex = query.toLowerCase().replace(/-/g, '');
      // TD-200: ILIKE is a sequential scan of the account's tickets; M3-T02's tsvector + GIN
      // index replaces it.
      const r = await db.query<{
        id: string;
        title: string;
        body: string;
        external_ref: string | null;
        status: TicketStatus;
        kind: string | null;
        repo: string;
        updated_at: Date;
      }>(
        'SELECT id, title, body, external_ref, status, kind, repo, updated_at FROM ticket ' +
          "WHERE account_id = $1 AND (title ILIKE $2 ESCAPE '\\' OR external_ref ILIKE $2 " +
          "ESCAPE '\\' OR body ILIKE $2 ESCAPE '\\' OR ($3::text IS NOT NULL AND " +
          "replace(id::text, '-', '') LIKE $3 || '%')) ORDER BY updated_at DESC, id LIMIT $4",
        [
          accountId,
          `%${likeLiteral(query)}%`,
          /^[0-9a-f]{4,32}$/.test(hex) ? hex : null,
          limit ?? 10,
        ],
      );
      return ok({
        tickets: r.rows.map((t) => ({
          id: t.id,
          short_id: t.id.slice(0, 8),
          title: clip(t.title, TITLE_MAX),
          status: t.status,
          kind: t.kind,
          repo: t.repo,
          snippet: snippetOf(t.body, query),
          updated_at: t.updated_at.toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    'list_machines',
    {
      title: 'List machines',
      description:
        'The account’s machines that run agents: name, online status, last heartbeat, running ' +
        'and maximum sessions, and some of the repos each can work on.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const [machines, repos] = await Promise.all([
        listMachineRows(db, accountId, null),
        db.query<{ machine_id: string; remote: string }>(
          'SELECT DISTINCT machine_id, remote FROM machine_repo ' +
            'WHERE account_id = $1 AND remote IS NOT NULL ORDER BY machine_id, remote',
          [accountId],
        ),
      ]);
      const byMachine = new Map<string, string[]>();
      for (const r of repos.rows) {
        const list = byMachine.get(r.machine_id) ?? [];
        list.push(r.remote);
        byMachine.set(r.machine_id, list);
      }
      return ok({
        machines: machines
          .filter((m) => m.revoked_at === null)
          .map((m) => ({
            id: m.id,
            name: m.name,
            status: m.status,
            last_seen_at: m.last_heartbeat_at,
            running_sessions: m.running_sessions,
            max_sessions: m.max_sessions,
            repo_count: m.repo_count,
            repos: (byMachine.get(m.id) ?? []).slice(0, MACHINE_REPOS_MAX),
          })),
      });
    },
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get a ticket',
      description:
        'One ticket: its body, column and state, the open question (with input_request_id), the ' +
        'transitions the user can take now, recent moves and the PR.',
      inputSchema: { ticket: z.string().max(64).describe('Ticket id or its first 8 characters') },
      annotations: readOnly,
    },
    async ({ ticket }) => {
      const t = await resolveTicket(db, accountId, ticket);
      if ('error' in t) return t.error;
      const sid = await latestSessionId(db, accountId, t.id);
      if (sid === null) {
        const r = await db.query<{
          repo: string;
          body: string;
          kind: string | null;
          status: string;
        }>('SELECT repo, body, kind, status FROM ticket WHERE id = $1', [t.id]);
        const row = r.rows[0]!;
        return ok({
          id: t.id,
          title: t.title,
          repo: row.repo,
          kind: row.kind,
          column: 'queued',
          status: row.status,
          body: clip(row.body, BODY_MAX),
        });
      }
      const d = (await loadSessionDetail(db, outputBus, sid))!;
      const gated = approvalGated(d);
      return ok({
        id: t.id,
        title: d.card.title,
        repo: d.card.repo,
        kind: d.card.kind,
        column: d.card.column,
        state: d.card.workflow_state,
        status: d.card.status,
        session_id: sid,
        open_question: d.pending_input
          ? { input_request_id: d.pending_input.id, question: d.pending_input.question }
          : null,
        transitions: d.card.human_transitions.map((h) => ({
          name: h.name,
          title: h.title,
          needs_text: h.needs_text,
          ...(gated.has(h.name) ? { requires_approval: true } : {}),
        })),
        pr_url: d.card.pr_url,
        spend_usd: d.spend_usd,
        recent_moves: (d.moves ?? []).slice(-5),
        body: clip(d.ticket_body ?? '', BODY_MAX),
      });
    },
  );

  server.registerTool(
    'create_ticket',
    {
      title: 'Create a ticket',
      description:
        'Queue a new ticket for an agent. `repo` is host/org/repo (github.com/acme/app). Write the ' +
        'body in Markdown: ## Goal, ## Context, ## Functional requirements, ## Out of scope, ' +
        '## Verification.',
      inputSchema: {
        title: z.string().min(1).max(200),
        repo: z.string().min(1).max(200),
        body: z.string().max(20_000),
        kind: TicketKindSchema.describe('work or personal'),
        workflow_id: z.string().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const body = CreateTicketRequestSchema.parse(input);
      const res = await createTicket(deps, who.scope, body);
      if (!res.ok) return fail(res.code, res.message);
      return ok({
        id: res.dto.id,
        short_id: res.dto.id.slice(0, 8),
        title: res.dto.title,
        url: `${deps.issuer}/#/?ticket=${res.dto.id}`,
        warnings: res.dto.warnings ?? [],
      });
    },
  );

  server.registerTool(
    'answer_input',
    {
      title: 'Answer a ticket’s question',
      description:
        'Answer the question an agent asked (get_ticket shows it). The agent resumes with the answer.',
      inputSchema: {
        ticket: z.string().max(64),
        answer: z.string().min(1).max(10_000),
        input_request_id: z.string().uuid().optional().describe('Default: the open question'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticket, answer, input_request_id }) => {
      const s = await sessionOf(ticket);
      if ('error' in s) return s.error;
      const irId = input_request_id ?? (await openInputRequestId(db, s.sessionId));
      if (irId === null) return fail('input_not_pending', 'The ticket has no open question.');
      return apply('input', s.sessionId, {
        type: 'input.provided',
        input_request_id: irId,
        answer,
      });
    },
  );

  server.registerTool(
    'take_transition',
    {
      title: 'Move a ticket',
      description:
        'Take one of the transitions get_ticket lists (a board button, e.g. approve or send back ' +
        'with feedback). Some need `text`. A transition marked requires_approval must be taken ' +
        'on the board.',
      inputSchema: {
        ticket: z.string().max(64),
        name: z.string().min(1).max(100),
        text: z.string().max(10_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ ticket, name, text }) => {
      const s = await sessionOf(ticket);
      if ('error' in s) return s.error;
      // Only the buttons the board shows now; never one a human must approve (ADR-0014 §5).
      const d = (await loadSessionDetail(db, outputBus, s.sessionId))!;
      const allowed = d.card.human_transitions.map((h) => h.name);
      if (!allowed.includes(name)) {
        return fail(
          'wrong_state',
          allowed.length === 0
            ? 'The ticket is not waiting on a human: no transition can be taken now.'
            : `No transition ${name} here. Allowed: ${allowed.join(', ')}.`,
          { allowed },
        );
      }
      if (approvalGated(d).has(name)) {
        return fail(
          'approval_required',
          `${name} needs an approval on the board; it can't be taken over MCP.`,
          { url: `${deps.issuer}/#/?ticket=${s.ticket.id}` },
        );
      }
      return apply('transition', s.sessionId, {
        type: 'human.transition',
        name,
        text: text ?? null,
        actor: UI_ACTOR,
        input_request_id: await openInputRequestId(db, s.sessionId),
      });
    },
  );

  server.registerTool(
    'reopen_ticket',
    {
      title: 'Reopen a ticket',
      description:
        'Send a finished (done or failed) ticket back to its agent with new instructions. The ' +
        'agent resumes the same conversation on the same branch.',
      inputSchema: {
        ticket: z.string().max(64),
        text: z.string().min(1).max(10_000).describe('What the agent should do now'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ ticket, text }) => {
      const s = await sessionOf(ticket);
      if ('error' in s) return s.error;
      // As POST /api/sessions/:id/reopen (api/index.ts).
      const res = await reopenSession(db, s.sessionId, text, UI_ACTOR);
      if (res.status === 'not_found') return fail('not_found', `No ticket ${ticket}.`);
      if (res.status === 'conflict') return fail('conflict', res.reason);
      for (const ev of res.boardEvents) deps.boardBus.publish(ev);
      outputBus.append(res.sessionId, 'user', text);
      return ok({ ok: true, session_id: res.sessionId });
    },
  );

  server.registerTool(
    'cancel_ticket',
    {
      title: 'Cancel a ticket',
      description:
        'Stop the ticket’s agent and cancel the ticket. Only reopen_ticket undoes it. Ask the ' +
        'user first.',
      inputSchema: {
        ticket: z.string().max(64),
        reason: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ ticket, reason }) => {
      const s = await sessionOf(ticket);
      if ('error' in s) return s.error;
      return apply('cancel', s.sessionId, {
        type: 'operator.cancel',
        ...(reason !== undefined ? { reason } : {}),
      });
    },
  );

  // ---------------------------------------------------------------- ADR-0030: workflows

  /** Who an MCP write is recorded as (`repo_checks.updated_by`). */
  const by = `mcp:${who.user.email}`;
  const repoArg = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('host/org/repo, e.g. github.com/acme/app');

  server.registerTool(
    'list_repo_checks',
    {
      title: 'List repo checks',
      description:
        'The repos of the account that have their own pre-PR checks (overriding the workflow’s ' +
        'default build and test checks), with their setup and checks.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => ok(await listRepoChecks(db, accountId)),
  );

  server.registerTool(
    'get_repo_checks',
    {
      title: 'Get a repo’s checks',
      description:
        'What conductor runs before a ticket on this repo opens or updates its PR: the repo’s own ' +
        'override (null when it has none) and, per workflow transition that runs checks, the ' +
        'effective setup and checks.',
      inputSchema: { repo: repoArg },
      annotations: readOnly,
    },
    async ({ repo }) => ok(await getRepoChecks(db, accountId, repo)),
  );

  server.registerTool(
    'set_repo_checks',
    {
      title: 'Set a repo’s checks',
      description:
        'Replace the pre-PR checks for one repo (e.g. a repo without a root package.json). ' +
        REPO_CHECKS_HOW +
        ' Tickets pick it up the next time they run their checks.',
      inputSchema: {
        repo: repoArg,
        setup: z.string().max(2_000).optional().describe("Omit = auto-detect, '' = none"),
        checks: z
          .array(EntryCheckSchema)
          .min(1)
          .max(REPO_CHECKS_MAX)
          .describe('[{name, cmd, timeout?: "10m"}], run in order; each must exit 0'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const res = await setRepoChecks(db, accountId, input, by);
      if (!res.ok) return fail('invalid_input', res.message, { details: res.details });
      return ok({ ok: true, ...res.dto });
    },
  );

  server.registerTool(
    'clear_repo_checks',
    {
      title: 'Clear a repo’s checks',
      description:
        'Remove the repo’s own checks: its tickets run the workflow’s default checks again.',
      inputSchema: { repo: repoArg },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ repo }) => {
      if (!(await clearRepoChecks(db, accountId, repo))) {
        return fail('not_found', `${repo} has no checks of its own.`);
      }
      return ok({ ok: true });
    },
  );

  server.registerTool(
    'get_workflow',
    {
      title: 'Get the workflow',
      description:
        'The workflow tickets run (`conductor` by default, latest version unless `version`). ' +
        'Without `state`: an outline (each state’s type, title and transition names) and every ' +
        'gate that runs checks. With `state`: that state’s full definition (prompt, transitions, ' +
        'requirements, timeouts). `default_available`: a newer shipped default not yet adopted ' +
        '(adopt_default_workflow). To edit, read each state, then send the whole definition to ' +
        'save_workflow.',
      inputSchema: {
        workflow_id: z.string().min(1).max(100).optional().describe('Default conductor'),
        version: z.number().int().min(1).optional().describe('Default the latest'),
        state: z.string().min(1).max(100).optional().describe('One state in full'),
      },
      annotations: readOnly,
    },
    async ({ workflow_id, version, state }) => {
      const id = workflow_id ?? CONDUCTOR_WORKFLOW_ID;
      const detail = await loadWorkflowDetail(db, id, version ?? null);
      if (!detail) {
        return fail('not_found', `No workflow ${id}${version ? ` version ${version}` : ''}.`);
      }
      const def = detail.definition;
      const head = {
        id: detail.id,
        version: detail.version,
        versions: detail.versions,
        default_available: await conductorDefaultAvailable(db, detail.id),
      };
      if (state !== undefined) {
        const s = def.states[state];
        if (s === undefined) {
          return fail(
            'not_found',
            `No state ${state}. States: ${Object.keys(def.states).join(', ')}.`,
          );
        }
        return ok({ ...head, state, definition: s });
      }
      return ok({
        ...head,
        start: def.start,
        columns: def.columns ?? null,
        budget: def.budget,
        states: Object.fromEntries(
          Object.entries(def.states).map(([name, s]) => [
            name,
            {
              type: s.type,
              title: s.title ?? null,
              transitions: 'on' in s && s.on !== undefined ? Object.keys(s.on) : [],
            },
          ]),
        ),
        check_gates: checksGatesOf(def),
      });
    },
  );

  /**
   * ADR-0030 §Amendment: workflows are instance-wide (until M2-T12), so a save changes every
   * account's tickets. Only an instance admin, or the single user of local mode, may save.
   */
  const mayEditWorkflows = who.mode === 'local' || who.user.is_admin;
  const notAdmin = () =>
    fail(
      'forbidden',
      'Workflows are shared by every account on this instance: only an instance admin can save ' +
        'them. Ask an admin, or use set_repo_checks for one repo’s checks.',
    );
  const baseVersionArg = z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Save only while this is still the latest version (get_workflow’s `version`)');
  const writeWorkflow = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  } as const;

  /** The approval guard, then the insert; the tool result either way. */
  const saveChecked = async (def: WorkflowDefinition, baseVersion: number | undefined) => {
    const weakened = await weakenedApprovals(db, def);
    if (weakened.length > 0) {
      return fail(
        'approval_weakened',
        `This would remove or bypass a human approval (${weakened.join(', ')}); change ` +
          'approvals on the board, not over MCP.',
        { transitions: weakened },
      );
    }
    const res = await insertWorkflowVersion(db, def, {
      createdBy: by,
      ...(baseVersion !== undefined ? { baseVersion } : {}),
    });
    if (!res.ok && res.code === 'conflict') {
      return fail(
        'conflict',
        `${def.id} changed since version ${baseVersion}: the latest is ${res.latest}. Read it ` +
          'again with get_workflow.',
        { latest: res.latest },
      );
    }
    if (!res.ok) return fail(res.code, 'workflow definition is invalid');
    return ok({
      id: res.id,
      version: res.version,
      default_available: await conductorDefaultAvailable(db, res.id),
    });
  };

  server.registerTool(
    'save_workflow',
    {
      title: 'Save a workflow',
      description:
        'Save a whole workflow definition as its next version (instance admins only: it changes ' +
        'the workflow for every account). New tickets, reopens and parked tickets follow it. An ' +
        'invalid one returns invalid_workflow with each rule and path. It may not remove a human ' +
        'approval. After a save of `conductor`, newer shipped defaults no longer install ' +
        'themselves (get_workflow shows default_available). Ask the user first.',
      inputSchema: {
        definition: z
          .record(z.string(), z.unknown())
          .describe('The full definition: {id, version, start, states, …}, as get_workflow shows'),
        base_version: baseVersionArg,
      },
      annotations: writeWorkflow,
    },
    async ({ definition, base_version }) => {
      if (!mayEditWorkflows) return notAdmin();
      const json = JSON.stringify(definition);
      if (Buffer.byteLength(json, 'utf8') > WORKFLOW_MAX_BYTES) {
        return fail('invalid_input', `The definition is over ${WORKFLOW_MAX_BYTES} bytes.`);
      }
      if (json.includes(TRUNCATED)) {
        return fail(
          'invalid_input',
          `The definition contains "${TRUNCATED}": a tool result was cut short. Read that part ` +
            'again (get_workflow with `state`) before saving.',
        );
      }
      const checked = validateWorkflow(definition);
      if (!checked.ok) {
        return fail('invalid_workflow', 'workflow definition is invalid', {
          errors: checked.errors.slice(0, WORKFLOW_ERRORS_MAX).map((e) => ({
            rule: e.rule,
            path: pathString(e.path),
            message: e.message,
          })),
          ...(checked.errors.length > WORKFLOW_ERRORS_MAX
            ? { more_errors: checked.errors.length - WORKFLOW_ERRORS_MAX }
            : {}),
        });
      }
      return saveChecked(checked.def, base_version);
    },
  );

  server.registerTool(
    'adopt_default_workflow',
    {
      title: 'Adopt the newest default workflow',
      description:
        'Save the newest shipped `conductor` workflow as its next version, replacing local edits ' +
        '(instance admins only): after an edit, or when get_workflow shows default_available. ' +
        'Later defaults still need adopting by hand. Ask the user first.',
      inputSchema: { base_version: baseVersionArg },
      annotations: writeWorkflow,
    },
    async ({ base_version }) => {
      if (!mayEditWorkflows) return notAdmin();
      return saveChecked(newestShippedConductor(), base_version);
    },
  );

  return server;
}
