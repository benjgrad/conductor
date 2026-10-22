import { BOARD_SSE_EVENT_TYPES, boardSseEventFromRow, encodeSseFrame } from '@conductor/shared';
import type { BoardBus, Queryable } from '../contracts.js';
import type { SseConnection } from './sse.js';

// GET /api/stream/board (03 §SSE, 10-contracts §Board events).
//
// Gap/duplicate-free by construction: the `event` table is the only source of frames, read in id
// order past a per-connection cursor. The BoardBus is the wake-up signal for live delivery, not
// the payload source. Board rows commit in id order (insertBoardEvents' advisory lock), and an
// event is published only after its COMMIT, so a query run after a publish sees every board row
// up to that event's id and no later row can appear below the cursor. Subscribing BEFORE the
// first query means nothing published during the replay is lost; anything the replay already
// sent is skipped because it is at or below the cursor.

const PAGE = 500;

interface EventRowLite {
  id: string;
  session_id: string | null;
  type: string;
  payload: unknown;
  ts: Date;
}

/** Highest board-event id committed so far (0 = none). Also GET /api/board's `last_event_id`. */
export async function maxBoardEventId(db: Queryable): Promise<number> {
  const res = await db.query<{ max: string | null }>(
    'SELECT max(id) AS max FROM event WHERE type = ANY($1)',
    [BOARD_SSE_EVENT_TYPES],
  );
  return Number(res.rows[0]?.max ?? 0);
}

/**
 * Parse a Last-Event-ID (header, else `?last_event_id=` for the first EventSource connect, which
 * cannot set headers). Returns null when absent or not a non-negative integer.
 */
export function parseLastEventId(value: unknown): number | null {
  const raw = Array.isArray(value) ? (value[0] as unknown) : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

export interface BoardStreamDeps {
  db: Queryable;
  boardBus: BoardBus;
  onError?: (err: unknown) => void;
}

/**
 * Serve the board stream on an open SSE connection. `lastEventId` null = live only (start at the
 * current max board id). Resolves once the initial replay has been written.
 */
export async function serveBoardStream(
  conn: SseConnection,
  deps: BoardStreamDeps,
  lastEventId: number | null,
): Promise<void> {
  let cursor: number | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const drain = async (): Promise<void> => {
    do {
      again = false;
      for (;;) {
        if (conn.closed || cursor === null) return;
        const res = await deps.db.query<EventRowLite>(
          'SELECT id, session_id, type, payload, ts FROM event ' +
            'WHERE id > $1 AND type = ANY($2) ORDER BY id LIMIT $3',
          [cursor, BOARD_SSE_EVENT_TYPES, PAGE],
        );
        for (const row of res.rows) {
          const ev = boardSseEventFromRow(row);
          if (ev !== null) conn.write(encodeSseFrame(ev.type, ev, ev.id));
          cursor = Number(row.id);
        }
        if (res.rows.length < PAGE) break;
      }
    } while (again && !conn.closed);
  };

  const kick = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = drain()
      .catch((err: unknown) => {
        deps.onError?.(err);
        conn.close();
      })
      .finally(() => {
        running = null;
        // TD-051: a publish between drain()'s last `again` check and this callback set `again`
        // on a drain that had already finished. Run another one so it is not lost.
        if (again && !conn.closed) void kick();
      });
    return running;
  };

  const unsubscribe = deps.boardBus.subscribe(() => {
    // Before the cursor is known the initial drain below covers it.
    if (cursor !== null) void kick();
  });
  conn.onClose(unsubscribe);

  try {
    cursor = lastEventId ?? (await maxBoardEventId(deps.db));
  } catch (err) {
    deps.onError?.(err);
    conn.close();
    return;
  }
  await kick();
}
