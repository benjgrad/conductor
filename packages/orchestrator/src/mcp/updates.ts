import { BOARD_SSE_EVENT_TYPES } from '@conductor/shared';
import type { BoardBus, Queryable } from '../contracts.js';
import { maxBoardEventId } from '../stream/board.js';

// ADR-0031 (FR4): MCP's wait_for_updates, a long poll over the board-event log. The stateless
// /mcp endpoint has no server-initiated stream (ADR-0028), so "tell me when something changes"
// is one call that returns as soon as a board event touches one of the caller's tickets, or at
// the timeout. Like stream/board.ts, the `event` table is the only source and the BoardBus only
// the wake-up: board rows commit in id order (insertBoardEvents' advisory lock) and are published
// after COMMIT, so reading up to `max(id)` and returning that as the next cursor never skips one.

/** At most this many changed tickets per call (the oldest changes first). */
export const UPDATES_MAX = 25;

export interface ChangedTicket {
  ticket_id: string;
  /** The newest board event for it in the window. */
  last_event_id: number;
  changed_at: string;
}

/**
 * The tickets of `accountId` (or just `ticketId`) with a board event in (`since`, `upto`], one
 * row each, oldest change first. A row without a session (a ticket create) names its ticket in
 * the payload.
 */
export async function changedTickets(
  db: Queryable,
  accountId: string,
  since: number,
  upto: number,
  ticketId: string | null,
): Promise<ChangedTicket[]> {
  if (upto <= since) return [];
  const r = await db.query<{ ticket_id: string; last_event_id: string; changed_at: Date }>(
    'SELECT t.id AS ticket_id, max(e.id) AS last_event_id, max(e.ts) AS changed_at ' +
      'FROM event e LEFT JOIN session s ON s.id = e.session_id ' +
      "JOIN ticket t ON t.id = COALESCE(s.ticket_id, (e.payload->>'ticket_id')::uuid) " +
      'WHERE e.id > $1 AND e.id <= $2 AND e.type = ANY($3) AND t.account_id = $4 ' +
      'AND ($5::uuid IS NULL OR t.id = $5) ' +
      'GROUP BY t.id ORDER BY max(e.id) LIMIT $6',
    [since, upto, BOARD_SSE_EVENT_TYPES, accountId, ticketId, UPDATES_MAX],
  );
  return r.rows.map((row) => ({
    ticket_id: row.ticket_id,
    last_event_id: Number(row.last_event_id),
    changed_at: row.changed_at.toISOString(),
  }));
}

export interface WaitDeps {
  db: Queryable;
  boardBus: BoardBus;
}

export interface WaitOptions {
  accountId: string;
  since: number;
  ticketId: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Turns the window's changed tickets into what the caller returns (the current cards, filtered
   * by needs_you_only). An empty result keeps waiting; the cursor still moves past the window.
   */
  present: (changed: ChangedTicket[]) => Promise<unknown[]>;
}

export interface WaitResult {
  cursor: number;
  changes: unknown[];
  timed_out: boolean;
}

/**
 * Wait for the first window with a change `present` keeps, or `timeoutMs`, or `signal`. The bus
 * is subscribed BEFORE the first read, so a publish during it is never missed (stream/board.ts).
 */
export async function waitForUpdates(deps: WaitDeps, o: WaitOptions): Promise<WaitResult> {
  let wake: (() => void) | null = null;
  /** A publish since the last read (set by the bus, cleared before each read). */
  let woken: boolean;
  const unsubscribe = deps.boardBus.subscribe(() => {
    woken = true;
    wake?.();
  });
  const deadline = Date.now() + o.timeoutMs;
  let cursor = o.since;
  try {
    for (;;) {
      woken = false;
      const upto = await maxBoardEventId(deps.db);
      // A cursor from another instance's log (or a reset database) is ahead of this one.
      if (upto < cursor) cursor = upto;
      const changed = await changedTickets(deps.db, o.accountId, cursor, upto, o.ticketId);
      // A full page: continue from its last change, not from `upto`, so nothing is dropped.
      const next = changed.length >= UPDATES_MAX ? changed.at(-1)!.last_event_id : upto;
      const changes = changed.length > 0 ? await o.present(changed) : [];
      cursor = next;
      if (changes.length > 0) return { cursor, changes, timed_out: false };
      const left = deadline - Date.now();
      if (left <= 0 || o.signal?.aborted) return { cursor, changes: [], timed_out: true };
      if (woken) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        o.signal?.addEventListener('abort', done, { once: true });
        function done() {
          clearTimeout(timer);
          o.signal?.removeEventListener('abort', done);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }
  } finally {
    unsubscribe();
  }
}

/** A changed ticket as wait_for_updates returns it (built from its current card). */
export interface ChangeRow {
  id: string;
  short_id: string;
  title: string;
  column: string;
  state: string | null;
  waiting_on: string;
  status_line: string;
  question?: string;
  pr_url?: string;
  changed_at: string;
}
