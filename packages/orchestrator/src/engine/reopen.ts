import { randomUUID } from 'node:crypto';
import {
  columnFor,
  sessionBranch,
  toBoardCard,
  type BoardSseEvent,
  type PendingAnswer,
  type SessionStatus,
} from '@conductor/shared';
import { insertBoardEvents } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { SessionRow, TicketRow } from '../db/types.js';
import { LEASE_INTERVAL } from '../gateway/claim.js';
import type { Db } from '../main.js';
import { readSession } from './rows.js';

// ADR-0008: reopen a finished ticket by resuming the same agent. One transaction:
//   lock ticket → lock the old session → checks (terminal, latest) → INSERT the new session
//   (queued, carrying branch, context, Claude session id, the human's text as pending answer)
//   → ticket `ready` → `operator.reopen` event row → board rows (card.moved, card.upserted)
//   → COMMIT. The claim (T11) then picks the ticket up on the old session's machine (the branch
// pin in claim.ts) and its `session.assigned` enters the workflow's start state, resuming the
// Claude conversation with the text as prompt (apply's onAssigned + §Pending answer). No outbox
// row is written here: the first command comes from the claim, through the usual path.

/** The statuses a session can be reopened from. `lost` is not one (see ADR-0008). */
export const REOPENABLE_STATUSES: ReadonlySet<SessionStatus> = new Set(['done', 'failed']);

export type ReopenResult =
  | { status: 'reopened'; sessionId: string; boardEvents: BoardSseEvent[] }
  | { status: 'not_found' }
  | { status: 'conflict'; reason: string };

export async function reopenSession(
  db: Db,
  oldSessionId: string,
  text: string,
  actor: string | null = null,
): Promise<ReopenResult> {
  return withTransaction(db, async (tx) => {
    const peek = await tx.query<{ ticket_id: string }>(
      'SELECT ticket_id FROM session WHERE id = $1',
      [oldSessionId],
    );
    if (!peek.rows[0]) return { status: 'not_found' } as const;
    // Ticket first: serializes two reopens (and a reopen against a claim) of the same ticket.
    const t = await tx.query<TicketRow>('SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [
      peek.rows[0].ticket_id,
    ]);
    const ticket = t.rows[0]!;
    const s = await tx.query<SessionRow>('SELECT * FROM session WHERE id = $1 FOR UPDATE', [
      oldSessionId,
    ]);
    const old = s.rows[0]!;
    if (!REOPENABLE_STATUSES.has(old.status)) {
      return { status: 'conflict', reason: `the session is ${old.status}, not done or failed` };
    }
    const latest = await tx.query<{ id: string }>(
      'SELECT id FROM session WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [ticket.id],
    );
    if (latest.rows[0]?.id !== oldSessionId) {
      return { status: 'conflict', reason: 'not the ticket’s latest session' };
    }

    const sessionId = randomUUID();
    const pending: PendingAnswer = { input_request_id: null, answer: text };
    // Carried: the branch (same worktree contents on the same machine), the context (earlier
    // state results), the Claude session id (resume the same conversation) and the per-Claude-
    // session spend totals (Claude's cost is cumulative across --resume, so only new spend counts).
    // Fresh: status, state, retry counters, visits, spend, wall time, deadline.
    await tx.query(
      `INSERT INTO session (id, ticket_id, workflow_id, workflow_version, status, workflow_state,
                            machine_id, agent_command_id, agent_process_live, lease_expires_at,
                            branch, claude_session_id, pending_answer, context,
                            claude_spend_totals)
       VALUES ($1, $2, $3, $4, 'queued', NULL, NULL, NULL, false, now() + ${LEASE_INTERVAL},
               $5, $6, $7, $8, $9)`,
      [
        sessionId,
        ticket.id,
        old.workflow_id,
        old.workflow_version,
        old.branch ?? sessionBranch(ticket.id, old.id),
        old.claude_session_id,
        JSON.stringify(pending),
        JSON.stringify(old.context),
        JSON.stringify(old.claude_spend_totals),
      ],
    );
    await tx.query(`UPDATE ticket SET status = 'ready', updated_at = now() WHERE id = $1`, [
      ticket.id,
    ]);
    // The durable record of what the human asked (the output ring is in memory, U-005).
    await tx.query(
      "INSERT INTO event (session_id, type, payload) VALUES ($1, 'operator.reopen', $2)",
      [sessionId, JSON.stringify({ text, reopened_from: oldSessionId, actor })],
    );
    const fresh = await readSession(tx, sessionId);
    const t2 = await tx.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticket.id]);
    const boardEvents = await insertBoardEvents(tx, [
      {
        type: 'card.moved',
        session_id: sessionId,
        ticket_id: ticket.id,
        from: columnFor(old.status),
        to: columnFor(fresh.status),
      },
      {
        type: 'card.upserted',
        session_id: sessionId,
        ticket_id: ticket.id,
        card: toBoardCard(t2.rows[0]!, fresh, null),
      },
    ]);
    return { status: 'reopened', sessionId, boardEvents } as const;
  });
}
