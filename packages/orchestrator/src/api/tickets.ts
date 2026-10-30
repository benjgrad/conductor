import {
  ticketEditable,
  toBoardCard,
  type BoardSseEvent,
  type TicketDetail,
  type UpdateTicketRequest,
  type WorkflowDefinition,
} from '@conductor/shared';
import { insertBoardEvents, type Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { SessionRow } from '../db/types.js';
import { cardView, withMachineFields } from '../engine/board-view.js';
import { DefinitionCache, TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';
import { toTicketDto } from './queries.js';

// GET / PATCH /api/tickets/:id: read a ticket in any column, edit it where its column allows
// (`ticket_editable` per state, `queued_ticket_editable` for Queued; `ticketEditable`).

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
