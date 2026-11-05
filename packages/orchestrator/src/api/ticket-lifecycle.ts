import type { BoardSseEvent, EngineEvent } from '@conductor/shared';
import type { ApplyEventResult, EngineService, Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import { reopenSession } from '../engine/reopen.js';
import { TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { latestSession, sessionlessCardUpserted } from './tickets.js';

// UXR-86: cancel and reopen at the ticket level, shared by POST /api/tickets/:id/cancel and
// /reopen and MCP's cancel_ticket / reopen_ticket. A ticket with a session goes through the
// session's own path (the engine's operator.cancel, reopenSession); a queued one with none is
// only a ticket row, so its status flips here: `cancelled` (the claim takes only `ready`) and
// back. Its event row has no session (event.session_id is nullable); the ticket is in the payload.

export type CancelTicketResult =
  | { status: 'applied'; events: BoardSseEvent[] }
  | { status: 'engine'; result: Exclude<ApplyEventResult, { status: 'applied' }> }
  | { status: 'not_found' }
  | { status: 'conflict'; reason: string };

/** Is the ticket in the account? */
async function inAccount(q: Queryable, ticketId: string, accountId: string): Promise<boolean> {
  const r = await q.query('SELECT 1 FROM ticket WHERE id = $1 AND account_id = $2', [
    ticketId,
    accountId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** The ticket locked (ticket first: the claim's lock order), or null. */
async function lockTicket(tx: Queryable, ticketId: string): Promise<TicketCardRow | null> {
  const r = await tx.query<TicketCardRow>(TICKET_SELECT + 'WHERE t.id = $1 FOR UPDATE OF t', [
    ticketId,
  ]);
  return r.rows[0] ?? null;
}

type Sessionless<T> = { status: 'has_session'; sessionId: string } | T;

/**
 * Set a session-less ticket's status `from` → `to` under the ticket lock, with its event row and
 * card. `has_session` when a claim (or reopen) made a session since the caller looked.
 */
async function flipSessionless(
  db: Db,
  ticketId: string,
  from: 'ready' | 'cancelled',
  to: 'ready' | 'cancelled',
  type: 'operator.cancel' | 'operator.reopen',
  payload: Record<string, unknown>,
): Promise<
  Sessionless<
    { status: 'applied'; events: BoardSseEvent[] } | { status: 'conflict'; reason: string }
  >
> {
  return withTransaction(db, async (tx) => {
    const ticket = await lockTicket(tx, ticketId);
    if (!ticket) return { status: 'conflict', reason: 'the ticket is gone' } as const;
    const session = await latestSession(tx, ticketId);
    if (session) return { status: 'has_session', sessionId: session.id } as const;
    if (ticket.status !== from) {
      return { status: 'conflict', reason: `the ticket is ${ticket.status}, not ${from}` } as const;
    }
    // 06 §Queue order: leaving the queue (or coming back to it) drops any hand-set place, so a
    // reopened ticket queues by priority, not at a stale rank.
    const res = await tx.query<TicketCardRow>(
      'UPDATE ticket SET status = $2, queue_position = NULL, updated_at = now() WHERE id = $1 ' +
        'RETURNING *',
      [ticketId, to],
    );
    await tx.query('INSERT INTO event (session_id, type, payload) VALUES (NULL, $1, $2)', [
      type,
      JSON.stringify({ ticket_id: ticketId, ...payload }),
    ]);
    const row: TicketCardRow = {
      ...res.rows[0]!,
      agent_name: ticket.agent_name,
      schedule_name: ticket.schedule_name ?? null,
    };
    // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
    return { status: 'applied', events: await sessionlessCardUpserted(tx, row) } as const;
  });
}

/** Cancel the ticket: through its latest session's engine, or directly while it has none. */
export async function cancelTicket(
  deps: { db: Db; engine: EngineService },
  accountId: string,
  ticketId: string,
  reason: string | undefined,
  actor: string,
): Promise<CancelTicketResult> {
  const { db, engine } = deps;
  if (!(await inAccount(db, ticketId, accountId))) return { status: 'not_found' };
  const viaEngine = async (sessionId: string): Promise<CancelTicketResult> => {
    const event: EngineEvent = {
      type: 'operator.cancel',
      ...(reason !== undefined ? { reason } : {}),
    };
    const result = await engine.applyEvent(sessionId, event, { actor });
    // The wrapper owned the transaction, so its board events are already published.
    if (result.status === 'applied') return { status: 'applied', events: [] };
    return { status: 'engine', result };
  };
  const peek = await latestSession(db, ticketId);
  if (peek) return viaEngine(peek.id);
  const res = await flipSessionless(db, ticketId, 'ready', 'cancelled', 'operator.cancel', {
    ...(reason !== undefined ? { reason } : {}),
    actor,
  });
  // A claim made the session between the peek and the lock: cancel that (once; bounded).
  if (res.status === 'has_session') return viaEngine(res.sessionId);
  return res;
}

export type ReopenTicketResult =
  | { status: 'applied'; events: BoardSseEvent[]; sessionId: string | null; text: string | null }
  | { status: 'not_found' }
  | { status: 'conflict'; reason: string };

/** The prompt a reopened session gets when the human gave none. */
export const DEFAULT_REOPEN_TEXT = 'Reopened from the board: carry on with the ticket.';

/** Reopen the ticket: its latest session (reopenSession), or a cancelled queued one → `ready`. */
export async function reopenTicket(
  db: Db,
  accountId: string,
  ticketId: string,
  text: string | undefined,
  actor: string,
): Promise<ReopenTicketResult> {
  if (!(await inAccount(db, ticketId, accountId))) return { status: 'not_found' };
  const viaSession = async (sessionId: string): Promise<ReopenTicketResult> => {
    const prompt = text ?? DEFAULT_REOPEN_TEXT;
    const res = await reopenSession(db, sessionId, prompt, actor);
    if (res.status === 'not_found') return { status: 'not_found' };
    if (res.status === 'conflict') return res;
    return { status: 'applied', events: res.boardEvents, sessionId: res.sessionId, text: prompt };
  };
  const peek = await latestSession(db, ticketId);
  if (peek) return viaSession(peek.id);
  const res = await flipSessionless(db, ticketId, 'cancelled', 'ready', 'operator.reopen', {
    actor,
  });
  if (res.status === 'has_session') return viaSession(res.sessionId);
  if (res.status === 'conflict') return res;
  return { status: 'applied', events: res.events, sessionId: null, text: null };
}
