import {
  CONDUCTOR_WORKFLOW_ID,
  QUEUED_COLUMN_ID,
  ROUTINE_WORKFLOW_ID,
  canonicalRepo,
  sessionBaseOf,
  ticketBaseProblems,
  ticketEditable,
  toBoardCard,
  type AccountScope,
  type ApiErrorCode,
  type BoardSseEvent,
  type CreateTicketRequestSchema,
  type TicketDetail,
  type TicketBase,
  type TicketDto,
  type TicketKind,
  type TicketSize,
  type UpdateTicketRequest,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import { insertBoardEvents, type BoardBus, type Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { SessionRow, TicketRow } from '../db/types.js';
import { cardView, withMachineFields } from '../engine/board-view.js';
import { loadProposals } from '../engine/proposals.js';
import { sessionPages } from '../engine/pages.js';
import { seedConductorWorkflow, seedRoutineWorkflow } from '../engine/seed.js';
import { DefinitionCache, TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';
import {
  AttachmentLinkError,
  linkAttachments,
  loadTicketAttachments,
  removeAttachments,
  toAttachmentDto,
} from './attachments.js';
import type { ErrorDetail } from './errors.js';
import { toTicketDto } from './queries.js';

// POST /api/tickets is shared by the REST route and MCP `create_ticket` tool (ADR-0028;
// ADR-0014 §1: tools add no rules of their own). GET / PATCH read and edit tickets in any column.

const defs = new DefinitionCache();

/** The ticket's latest session (the board card's: the same rule as loadBoard), or null. */
export async function latestSession(q: Queryable, ticketId: string, lock = false) {
  const r = await q.query<SessionRow>(
    'SELECT * FROM session WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1' +
      (lock ? ' FOR UPDATE' : ''),
    [ticketId],
  );
  return r.rows[0] ?? null;
}

/**
 * The definition the card's column comes from: the session's pinned version, else the ticket's,
 * else the latest of the ticket's workflow (a queued ticket isn't pinned yet). null = none.
 */
async function definitionOf(
  q: Queryable,
  ticket: TicketCardRow,
  session: SessionRow | null,
): Promise<WorkflowDefinition | null> {
  const id = session?.workflow_id ?? ticket.workflow_id;
  let version = session?.workflow_version ?? ticket.workflow_version;
  if (version === null) {
    const r = await q.query<{ v: number | null }>(
      'SELECT max(version) AS v FROM workflow_definition WHERE id = $1',
      [id],
    );
    version = r.rows[0]?.v ?? null;
  }
  return version === null ? null : defs.get(q, id, version).catch(() => null);
}

async function toDetail(
  q: Queryable,
  ticket: TicketCardRow,
  session: SessionRow | null,
): Promise<TicketDetail> {
  const def = await definitionOf(q, ticket, session);
  const view = await cardView(q, session?.workflow_id ?? ticket.workflow_id, def?.version ?? null);
  const column = toBoardCard(ticket, session, null, view).column;
  const state = session?.workflow_state ?? null;
  return {
    ...toTicketDto(ticket, ticket.agent_name),
    updated_at: ticket.updated_at.toISOString(),
    session_id: session?.id ?? null,
    workflow_state: state,
    column,
    column_title: view.columns.find((c) => c.id === column)?.title ?? column,
    editable: ticketEditable(def, state),
    base_ref: sessionBaseOf(session?.base_ref),
    proposals: await loadProposals(q, ticket.id, session),
    ...(await pagesField(q, session)),
    attachments: (await loadTicketAttachments(q, ticket.id)).map(toAttachmentDto),
    // ADR-0039: the ticket's own setting, and the default of the machine its session runs on.
    skip_permissions: ticket.skip_permissions ?? null,
    machine_skip_permissions_default: await machineSkipDefault(q, session),
  };
}

/** ADR-0039: the session's machine's `skip_permissions_default`; null = no machine yet. */
async function machineSkipDefault(q: Queryable, session: SessionRow | null) {
  if (session?.machine_id == null) return null;
  const r = await q.query<{ d: boolean }>(
    'SELECT skip_permissions_default AS d FROM machine WHERE id = $1',
    [session.machine_id],
  );
  return r.rows[0]?.d ?? null;
}

/** ADR-0038: `{pages}` when the session's agent states attached any, else nothing. */
async function pagesField(q: Queryable, session: SessionRow | null) {
  const pages = await sessionPages(q, session);
  return pages.length > 0 ? { pages } : {};
}

/** null = no such ticket in the account. */
export async function loadTicketDetail(
  db: Queryable,
  id: string,
  accountId: string,
): Promise<TicketDetail | null> {
  const t = await db.query<TicketCardRow>(TICKET_SELECT + 'WHERE t.id = $1 AND t.account_id = $2', [
    id,
    accountId,
  ]);
  const ticket = t.rows[0];
  if (!ticket) return null;
  return toDetail(db, ticket, await latestSession(db, id));
}

export type UpdateTicketResult =
  | { status: 'updated'; detail: TicketDetail; events: BoardSseEvent[] }
  | { status: 'not_found' }
  | { status: 'not_editable'; detail: TicketDetail }
  | { status: 'conflict' }
  | { status: 'attachment_error'; error: AttachmentLinkError }
  /** ADR-0039: the `base` is refused (not available yet, or not in the workflow's bases). */
  | { status: 'bad_base'; error: Extract<CreateTicketResult, { ok: false }> };

/** Columns a session holds before any state runs: a claim, not the engine, locks them. */
const PRE_CLAIM = new Set(['queued', 'assigned']);

/**
 * Edit the ticket where its column allows it. The rows are locked in the order their other
 * writers lock them (a claim: ticket, then session; an engine apply: session, then ticket) and
 * editability is decided under the locks, so a claim or move between GET and PATCH is seen.
 */
export async function updateTicket(
  db: Db,
  id: string,
  accountId: string,
  patch: UpdateTicketRequest,
): Promise<UpdateTicketResult> {
  try {
    return await updateTicketTx(db, id, accountId, patch);
  } catch (err) {
    // Thrown inside the transaction, so nothing was written.
    if (err instanceof AttachmentLinkError) return { status: 'attachment_error', error: err };
    throw err;
  }
}

async function updateTicketTx(
  db: Db,
  id: string,
  accountId: string,
  patch: UpdateTicketRequest,
): Promise<UpdateTicketResult> {
  return withTransaction(db, async (tx) => {
    const lockTicket = async () =>
      (
        await tx.query<TicketCardRow>(
          TICKET_SELECT + 'WHERE t.id = $1 AND t.account_id = $2 FOR UPDATE OF t',
          [id, accountId],
        )
      ).rows[0] ?? null;
    const peek = await latestSession(tx, id);
    let ticket: TicketCardRow | null;
    let session: SessionRow | null;
    if (peek === null || PRE_CLAIM.has(peek.status)) {
      ticket = await lockTicket();
      session = ticket ? await latestSession(tx, id, true) : null;
    } else {
      session = await latestSession(tx, id, true);
      ticket = await lockTicket();
    }
    if (!ticket) return { status: 'not_found' };
    // A reopen or claim made a newer session after the peek: the edit started from a stale view.
    if ((session?.id ?? null) !== (peek?.id ?? null)) return { status: 'conflict' };

    const before = await toDetail(tx, ticket, session);
    if (!before.editable) return { status: 'not_editable', detail: before };
    // ADR-0039: the base is fixed once a session starts (B2 resolves it then).
    if (patch.base !== undefined && before.column !== QUEUED_COLUMN_ID) {
      return { status: 'not_editable', detail: before };
    }
    if (patch.base != null) {
      const bad = await baseProblem(tx, ticket.workflow_id, patch.base);
      if (bad !== null) return { status: 'bad_base', error: bad };
    }
    if (Date.parse(patch.expected_updated_at) !== ticket.updated_at.getTime()) {
      return { status: 'conflict' };
    }

    const res = await tx.query<TicketCardRow>(
      'UPDATE ticket SET title = coalesce($2, title), body = coalesce($3, body), ' +
        'priority = coalesce($4, priority), kind = coalesce($5, kind), ' +
        'base = CASE WHEN $6 THEN $7::jsonb ELSE base END, updated_at = now() ' +
        'WHERE id = $1 RETURNING *',
      [
        id,
        patch.title ?? null,
        patch.body ?? null,
        patch.priority ?? null,
        patch.kind ?? null,
        patch.base !== undefined,
        patch.base == null ? null : JSON.stringify(patch.base),
      ],
    );
    // 06 §Attachments: removals first, so a swap within the limits passes.
    await removeAttachments(tx, id, patch.remove_attachment_ids ?? []);
    await linkAttachments(tx, accountId, id, patch.add_attachment_ids ?? []);
    const row: TicketCardRow = { ...res.rows[0]!, agent_name: ticket.agent_name };
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
    const events = session
      ? await cardUpserted(tx, session.id)
      : await sessionlessCardUpserted(tx, row);
    return { status: 'updated', detail: await toDetail(tx, row, session), events };
  });
}

/**
 * ADR-0039: a ticket `base` checked against the latest definition of its workflow (the one a
 * queued ticket will be pinned to), as the 400 to return; null = fine.
 */
async function baseProblem(
  q: Queryable,
  workflowId: string,
  base: TicketBase,
): Promise<Extract<CreateTicketResult, { ok: false }> | null> {
  const r = await q.query<{ v: number | null }>(
    'SELECT max(version) AS v FROM workflow_definition WHERE id = $1',
    [workflowId],
  );
  const version = r.rows[0]?.v ?? null;
  const def = version === null ? null : await defs.get(q, workflowId, version).catch(() => null);
  const problems = ticketBaseProblems(def, base);
  if (problems.length === 0) return null;
  return {
    ok: false,
    status: 400,
    code: 'bad_request',
    message: problems[0]!.message,
    details: problems.map((p) => ({ path: p.path.join('.'), message: p.message })),
  };
}

/** The `card.upserted` of a ticket with no session yet (a new or edited queued ticket). */
export async function sessionlessCardUpserted(
  tx: Queryable,
  row: TicketCardRow,
): Promise<BoardSseEvent[]> {
  return insertBoardEvents(tx, [
    {
      type: 'card.upserted',
      session_id: null,
      ticket_id: row.id,
      card: await withMachineFields(
        tx,
        toBoardCard(row, null, null, await cardView(tx, row.workflow_id, null)),
        row,
      ),
    },
  ]);
}

export type CreateTicketResult =
  | { ok: true; dto: TicketDto }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode;
      message: string;
      details?: ErrorDetail[];
    };

/** The checks every new ticket passes before its insert (POST /api/tickets, an approved proposal). */
export type PreparedTicket =
  { ok: true; repo: string } | Extract<CreateTicketResult, { ok: false }>;

/**
 * The repo as stored (M2-T17, U-048: canonical host/org/repo in `password` mode) and a known
 * workflow (seeding the built-in ones), or the 400 to return. Nothing is inserted.
 */
export async function prepareNewTicket(
  deps: { db: Db; auth: AuthConfig },
  body: { repo: string; workflow_id: string },
): Promise<PreparedTicket> {
  const { db, auth } = deps;
  // M2-T17 (U-048, ADR-0013 §Routing): in `password` mode the repo must be host/org/repo and is
  // stored canonical; `local` mode keeps M1's rule (the e2e's local fixture repos).
  let repo = body.repo;
  if (auth.mode === 'password') {
    const canonical = canonicalRepo(body.repo);
    if (canonical === null) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'repo must be host/org/repo',
        details: [
          { path: 'repo', message: 'expected host/org/repo (or an https / ssh git URL of one)' },
        ],
      };
    }
    repo = canonical;
  }
  // ADR-0010: `conductor` is seeded on startup; seeding here too keeps a bare database (tests,
  // a start that raced a migration) working. Idempotent.
  // Silent: the "newer default" notice is the start's (M1b-T09).
  if (body.workflow_id === CONDUCTOR_WORKFLOW_ID) await seedConductorWorkflow(db, { log: null });
  if (body.workflow_id === ROUTINE_WORKFLOW_ID) await seedRoutineWorkflow(db);
  const known = await db.query('SELECT 1 FROM workflow_definition WHERE id = $1 LIMIT 1', [
    body.workflow_id,
  ]);
  if (known.rowCount === 0) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: `unknown workflow ${body.workflow_id}`,
      details: [{ path: 'workflow_id', message: 'no workflow with this id' }],
    };
  }
  return { ok: true, repo };
}

export async function createTicket(
  deps: { db: Db; boardBus: BoardBus; auth: AuthConfig },
  scope: AccountScope,
  body: z.output<typeof CreateTicketRequestSchema>,
): Promise<CreateTicketResult> {
  const { db, boardBus } = deps;
  const prepared = await prepareNewTicket(deps, body);
  if (!prepared.ok) return prepared;
  const { repo } = prepared;
  if (body.base !== undefined) {
    const bad = await baseProblem(db, body.workflow_id, body.base);
    if (bad !== null) return bad;
  }
  // WF-T03: an explicit kind wins; else the repo's last ticket's; else the caller must say.
  const kind = body.kind ?? (await lastTicketKind(db, scope.account_id, repo));
  if (kind === null) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'kind is required: no earlier ticket on this repo to take it from',
      details: [{ path: 'kind', message: 'work or personal (no earlier ticket on this repo)' }],
    };
  }
  let created: { ticket: TicketRow; events: BoardSseEvent[] };
  try {
    created = await insertNewTicket(db, scope, body, repo, kind);
  } catch (err) {
    if (!(err instanceof AttachmentLinkError)) throw err;
    return { ok: false, status: err.status, code: err.code, message: err.message };
  }
  const { ticket, events } = created;
  for (const ev of events) boardBus.publish(ev);
  const dto: TicketDto = toTicketDto(ticket);
  if (!(await accountHasRepo(db, scope.account_id, ticket.repo))) {
    dto.warnings = ['no_machine_has_repo'];
  }
  return { ok: true, dto };
}

/** The insert, its attachments and its card event, in one transaction. */
async function insertNewTicket(
  db: Db,
  scope: AccountScope,
  body: z.output<typeof CreateTicketRequestSchema>,
  repo: string,
  kind: TicketKind,
): Promise<{ ticket: TicketRow; events: BoardSseEvent[] }> {
  return withTransaction(db, async (tx) => {
    const row = (await insertTicketRow(tx, {
      account_id: scope.account_id,
      external_ref: body.external_ref,
      repo,
      title: body.title,
      body: body.body,
      workflow_id: body.workflow_id,
      required_tags: body.required_tags,
      repo_allow_machines: body.repo_allow_machines,
      priority: body.priority,
      kind,
      size: body.size,
      base: body.base ?? null,
    }))!;
    // 06 §Attachments: linked before the commit, so no claim sees the ticket without its files.
    await linkAttachments(tx, scope.account_id, row.id, body.attachment_ids ?? []);
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
    const evs = await sessionlessCardUpserted(tx, { ...row, agent_name: null });
    return { ticket: row, events: evs };
  });
}

/**
 * WF-T03: the kind of the account's most recent ticket on `repo` (as stored: canonical in
 * `password` mode), or null when it has none. Tickets from before M1b have no kind and are skipped.
 */
export async function lastTicketKind(
  q: Queryable,
  accountId: string,
  repo: string,
): Promise<TicketKind | null> {
  const res = await q.query<{ kind: TicketKind }>(
    'SELECT kind FROM ticket WHERE account_id = $1 AND repo = $2 AND kind IS NOT NULL ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1',
    [accountId, repo],
  );
  return res.rows[0]?.kind ?? null;
}

/**
 * U-048: whether some unrevoked machine of the account (online or not) has the repo. github.com
 * org/repo compares case-insensitively; `r.repo` keeps M1 local-mode rows matching.
 */
export async function accountHasRepo(
  q: Queryable,
  accountId: string,
  repo: string,
): Promise<boolean> {
  const has = await q.query(
    'SELECT 1 FROM machine_repo r JOIN machine m ON m.id = r.machine_id ' +
      'WHERE r.account_id = $1 AND m.revoked_at IS NULL ' +
      'AND (lower(r.remote) = lower($2) OR r.repo = $3) LIMIT 1',
    [accountId, canonicalRepo(repo) ?? repo, repo],
  );
  return (has.rowCount ?? 0) > 0;
}

/** The columns a new ticket is inserted with (the rest take their defaults). */
export interface NewTicket {
  account_id: string;
  external_ref: string | null;
  repo: string;
  title: string;
  body: string;
  workflow_id: string;
  required_tags: string[];
  repo_allow_machines: string[] | null;
  priority: number;
  kind: TicketKind;
  /** ADR-0037 §4 (C2): S / M / L; absent ≡ null (schedule runs, approved proposals). */
  size?: TicketSize | null;
  /** ADR-0039: the ticket's own base; absent ≡ null (the workflow's `base_default`). */
  base?: TicketBase | null;
  /** ADR-0032: the schedule run it comes from; both or neither. */
  schedule_id?: string | null;
  scheduled_for?: Date | null;
}

/**
 * Insert one ticket (POST /api/tickets and a schedule's run, ADR-0032). null = a schedule run that
 * already has its ticket (`ticket_schedule_run_key`: the run's idempotency key).
 */
export async function insertTicketRow(tx: Queryable, t: NewTicket): Promise<TicketRow | null> {
  const res = await tx.query<TicketRow>(
    'INSERT INTO ticket (external_ref, repo, title, body, workflow_id, required_tags, ' +
      'repo_allow_machines, priority, kind, account_id, schedule_id, scheduled_for, size, base) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ' +
      'ON CONFLICT (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL DO NOTHING ' +
      'RETURNING *',
    [
      t.external_ref,
      t.repo,
      t.title,
      t.body,
      t.workflow_id,
      t.required_tags,
      t.repo_allow_machines,
      t.priority,
      t.kind,
      t.account_id,
      t.schedule_id ?? null,
      t.scheduled_for ?? null,
      t.size ?? null,
      t.base == null ? null : JSON.stringify(t.base),
    ],
  );
  return res.rows[0] ?? null;
}
