import {
  compareQueued,
  toBoardCard,
  type BoardSseEvent,
  type BoardSseEventDraft,
  type QueueOrderResponse,
} from '@conductor/shared';
import { insertBoardEvents, type Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import { cardView, withMachineFields } from '../engine/board-view.js';
import { TICKET_SELECT, type TicketCardRow } from '../engine/rows.js';
import type { Db } from '../main.js';
import { currentCard } from '../permissions/store.js';

// 06 §Queue order: PUT / DELETE /api/queue/order and the MCP `reorder_queue` tool (ADR-0014 §1:
// the tool adds no rules of its own). The queue is the account's `ready` tickets; the claim takes
// them by `queue_position ASC NULLS LAST, priority ASC, created_at, id` (gateway/claim.ts), the
// order `compareQueued` sorts by.

export interface QueueOrderResult extends QueueOrderResponse {
  /** One `card.upserted` per ticket whose place changed; publish after COMMIT. */
  events: BoardSseEvent[];
}

interface ReadyRow {
  id: string;
  queue_position: number | null;
  priority: number;
  created_at: Date;
}

/**
 * Put the listed ready tickets of the account first, in this order; every other ready ticket keeps
 * its place after them. Every ready ticket then has a position 1..N, so what the board shows is the
 * order that runs; a ticket created later is unranked and comes after them. A listed id that isn't
 * a ready ticket of the account (claimed meanwhile, another account's, unknown) is `skipped`.
 */
export function reorderQueue(
  db: Db,
  accountId: string,
  ticketIds: readonly string[],
): Promise<QueueOrderResult> {
  return rewrite(db, accountId, (current) => {
    const ready = new Set(current);
    const first = ticketIds.filter((id) => ready.has(id));
    const firstSet = new Set(first);
    const order = [...first, ...current.filter((id) => !firstSet.has(id))];
    return {
      positions: new Map(order.map((id, i) => [id, i + 1])),
      skipped: ticketIds.filter((id) => !ready.has(id)),
    };
  });
}

/** Back to priority order: every ready ticket of the account unranked. */
export function resetQueueOrder(db: Db, accountId: string): Promise<QueueOrderResult> {
  return rewrite(db, accountId, (current) => ({
    positions: new Map(current.map((id) => [id, null])),
    skipped: [],
  }));
}

async function rewrite(
  db: Db,
  accountId: string,
  plan: (current: string[]) => {
    positions: ReadonlyMap<string, number | null>;
    skipped: string[];
  },
): Promise<QueueOrderResult> {
  return withTransaction(db, async (tx) => {
    // Locked in id order, so two reorders can't deadlock; a claim skips them (SKIP LOCKED) for
    // the moment this takes. Ticket before session, as the claim and a ticket edit lock them.
    const res = await tx.query<ReadyRow>(
      `SELECT id, queue_position, priority, created_at FROM ticket
        WHERE account_id = $1 AND status = 'ready' ORDER BY id FOR UPDATE`,
      [accountId],
    );
    const current = res.rows
      .map((r) => ({
        ticket_id: r.id,
        queue_position: r.queue_position,
        priority: r.priority,
        created_at: r.created_at.toISOString(),
      }))
      .sort(compareQueued)
      .map((r) => r.ticket_id);
    const { positions, skipped } = plan(current);

    const before = new Map(res.rows.map((r) => [r.id, r.queue_position]));
    const changed = current.filter((id) => (positions.get(id) ?? null) !== before.get(id));
    if (changed.length > 0) {
      // `updated_at` is left alone: the place in the queue isn't an edit of the ticket (an open
      // edit would 409, and the "recent" sorts would move).
      await tx.query(
        `UPDATE ticket t SET queue_position = u.pos
           FROM unnest($1::uuid[], $2::int[]) AS u(id, pos) WHERE t.id = u.id`,
        [changed, changed.map((id) => positions.get(id) ?? null)],
      );
    }
    const order = await readyOrder(tx, accountId);
    const events = await upsertCards(tx, changed);
    return { ticket_ids: order, skipped, events };
  });
}

/** The account's ready tickets in pickup order. */
export async function readyOrder(tx: Queryable, accountId: string): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM ticket WHERE account_id = $1 AND status = 'ready'
      ORDER BY queue_position ASC NULLS LAST, priority ASC, created_at, id`,
    [accountId],
  );
  return r.rows.map((x) => x.id);
}

/** One `card.upserted` per ticket, in one insert (the last write of the transaction). */
async function upsertCards(tx: Queryable, ticketIds: readonly string[]): Promise<BoardSseEvent[]> {
  if (ticketIds.length === 0) return [];
  const rows = await tx.query<TicketCardRow & { session_id: string | null }>(
    TICKET_SELECT.replace(
      'SELECT t.*,',
      'SELECT t.*, (SELECT s.id FROM session s WHERE s.ticket_id = t.id ' +
        'ORDER BY s.created_at DESC LIMIT 1) AS session_id,',
    ) + 'WHERE t.id = ANY($1::uuid[])',
    [ticketIds],
  );
  const drafts: BoardSseEventDraft[] = [];
  for (const row of rows.rows) {
    const { session_id: sessionId, ...ticket } = row;
    const card =
      sessionId !== null
        ? await currentCard(tx, sessionId)
        : await withMachineFields(
            tx,
            toBoardCard(ticket, null, null, await cardView(tx, ticket.workflow_id, null)),
            ticket,
          );
    drafts.push({ type: 'card.upserted', session_id: sessionId, ticket_id: row.id, card });
  }
  return insertBoardEvents(tx, drafts);
}
