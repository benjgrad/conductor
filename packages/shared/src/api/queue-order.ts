import { QUEUED_COLUMN_ID } from '../workflow/conductor.js';
import type { BoardCard } from './rest.js';

// 06 §Queue order: the order queued tickets are picked up in, shared by the board (server and
// client) and MCP. The claim's SQL says the same: `queue_position ASC NULLS LAST, priority ASC,
// created_at, id` (gateway/claim.ts).

/** What `compareQueued` reads; a BoardCard has it, and so does a ticket row mapped to it. */
export interface QueuedLike {
  ticket_id: string;
  /** null / absent ≡ not reordered by hand. */
  queue_position?: number | null | undefined;
  priority: number;
  /** ISO timestamp (sorts as time). */
  created_at: string;
}

/**
 * Hand-ranked tickets first (lowest position first), then the rest by priority (the lower P first:
 * P0 is the most urgent, ADR-0036),
 * then age (oldest first), then id, so the order is total.
 */
export function compareQueued(a: QueuedLike, b: QueuedLike): number {
  const pa = a.queue_position ?? null;
  const pb = b.queue_position ?? null;
  if (pa !== null || pb !== null) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return pa - pb;
  }
  return (
    a.priority - b.priority ||
    Date.parse(a.created_at) - Date.parse(b.created_at) ||
    (a.ticket_id < b.ticket_id ? -1 : a.ticket_id > b.ticket_id ? 1 : 0)
  );
}

/**
 * May a person move this card in the queue: a Queued card whose ticket is still waiting for a
 * machine (no session yet, or a queued one). A claimed card in Queued is already being picked up.
 */
export function isReorderable(card: Pick<BoardCard, 'column' | 'status'>): boolean {
  return card.column === QUEUED_COLUMN_ID && (card.status === null || card.status === 'queued');
}

/**
 * `ids` with `id` moved to index `to` (clamped to the list). An id not in `ids` returns `ids`
 * unchanged (the same array).
 */
export function moveInOrder(ids: readonly string[], id: string, to: number): readonly string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  if (at === from) return ids;
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
