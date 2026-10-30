import {
  CONDUCTOR_WORKFLOW_ID,
  canonicalRepo,
  ticketEditable,
  toBoardCard,
  type AccountScope,
  type ApiErrorCode,
  type BoardSseEvent,
  type CreateTicketRequestSchema,
  type TicketDetail,
  type TicketDto,
  type UpdateTicketRequest,
  type WorkflowDefinition,
} from '@conductor/shared';
import type { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import { insertBoardEvents, type BoardBus, type Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { SessionRow, TicketRow } from '../db/types.js';
import { cardView, withMachineFields } from '../engine/board-view.js';
import { seedConductorWorkflow } from '../engine/seed.js';
import { DefinitionCache, TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';
import type { ErrorDetail } from './errors.js';
import { toTicketDto } from './queries.js';

// POST /api/tickets is shared by the REST route and MCP `create_ticket` tool (ADR-0028;
// ADR-0014 §1: tools add no rules of their own). GET / PATCH read and edit tickets in any column.

const defs = new DefinitionCache();

/** The ticket's latest session (the board card's: the same rule as loadBoard), or null. */
async function latestSession(q: Queryable, ticketId: string, lock = false) {
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
  };
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
  | { status: 'conflict' };

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
    if (Date.parse(patch.expected_updated_at) !== ticket.updated_at.getTime()) {
      return { status: 'conflict' };
    }

    const res = await tx.query<TicketCardRow>(
      'UPDATE ticket SET title = coalesce($2, title), body = coalesce($3, body), ' +
        'priority = coalesce($4, priority), kind = coalesce($5, kind), updated_at = now() ' +
        'WHERE id = $1 RETURNING *',
      [id, patch.title ?? null, patch.body ?? null, patch.priority ?? null, patch.kind ?? null],
    );
    const row: TicketCardRow = { ...res.rows[0]!, agent_name: ticket.agent_name };
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
    const events = session
      ? await cardUpserted(tx, session.id)
      : await sessionlessCardUpserted(tx, row);
    return { status: 'updated', detail: await toDetail(tx, row, session), events };
  });
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

export async function createTicket(
  deps: { db: Db; boardBus: BoardBus; auth: AuthConfig },
  scope: AccountScope,
  body: z.output<typeof CreateTicketRequestSchema>,
): Promise<CreateTicketResult> {
  const { db, boardBus, auth } = deps;
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
  const { ticket, events } = await withTransaction(db, async (tx) => {
    const res = await tx.query<TicketRow>(
      'INSERT INTO ticket (external_ref, repo, title, body, workflow_id, required_tags, ' +
        'repo_allow_machines, priority, kind, account_id) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [
        body.external_ref,
        repo,
        body.title,
        body.body,
        body.workflow_id,
        body.required_tags,
        body.repo_allow_machines,
        body.priority,
        body.kind,
        scope.account_id,
      ],
    );
    const row = res.rows[0]!;
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
    const evs = await sessionlessCardUpserted(tx, { ...row, agent_name: null });
    return { ticket: row, events: evs };
  });
  for (const ev of events) boardBus.publish(ev);
  // U-048: a ticket for a repo no machine of the account has is created, and flagged. Offline
  // machines count (routing per online machine is the card's, M2-T16); revoked ones don't.
  // github.com org/repo compares case-insensitively; `r.repo` keeps M1 local-mode rows matching.
  const has = await db.query(
    'SELECT 1 FROM machine_repo r JOIN machine m ON m.id = r.machine_id ' +
      'WHERE r.account_id = $1 AND m.revoked_at IS NULL ' +
      'AND (lower(r.remote) = lower($2) OR r.repo = $3) LIMIT 1',
    [scope.account_id, canonicalRepo(ticket.repo) ?? ticket.repo, ticket.repo],
  );
  const dto: TicketDto = toTicketDto(ticket);
  if (has.rowCount === 0) dto.warnings = ['no_machine_has_repo'];
  return { ok: true, dto };
}
