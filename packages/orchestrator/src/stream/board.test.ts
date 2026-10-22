import {
  BOARD_SSE_FIXTURES,
  boardSseEventToRow,
  type BoardSseEvent,
  type BoardSseEventDraft,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryBoardBus, type Queryable } from '../contracts.js';
import { parseLastEventId, serveBoardStream } from './board.js';
import type { SseConnection } from './sse.js';

// Deterministic interleavings for the board stream's replay → live hand-off (no DB).

interface Row {
  id: string;
  session_id: string | null;
  type: string;
  payload: unknown;
  ts: Date;
}

/** An `event` table in memory; `gate` pauses the next SELECT until released. */
function fakeDb() {
  const rows: Row[] = [];
  let gate: Promise<void> | null = null;
  const db: Queryable = {
    async query(text: string, values?: unknown[]) {
      if (gate) {
        const g = gate;
        gate = null;
        await g;
      }
      if (text.startsWith('SELECT max(id)')) {
        const types = values?.[0] as string[];
        const ids = rows.filter((r) => types.includes(r.type)).map((r) => Number(r.id));
        return { rows: [{ max: ids.length ? String(Math.max(...ids)) : null }] } as never;
      }
      const types = values?.[1] as string[];
      const after = values?.[0] as number;
      const limit = values?.[2] as number;
      const out = rows
        .filter((r) => Number(r.id) > after && types.includes(r.type))
        .slice(0, limit);
      return { rows: out } as never;
    },
  };
  return {
    db,
    rows,
    pause: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
  };
}

function commit(rows: Row[], id: number, template: BoardSseEvent): BoardSseEvent {
  const draft: Record<string, unknown> = { ...template };
  delete draft.id;
  delete draft.ts;
  const row = boardSseEventToRow(draft as BoardSseEventDraft);
  const ts = new Date('2026-01-01T00:00:00Z');
  rows.push({
    id: String(id),
    session_id: row.session_id,
    type: row.type,
    payload: row.payload,
    ts,
  });
  return { ...template, id, ts: ts.toISOString() };
}

function fakeConn() {
  const frames: string[] = [];
  const closers: (() => void)[] = [];
  let closed = false;
  const conn: SseConnection = {
    write: (f) => {
      if (!closed) frames.push(f);
    },
    close: () => {
      closed = true;
      closers.forEach((c) => c());
    },
    get closed() {
      return closed;
    },
    onClose: (fn) => closers.push(fn),
  };
  const ids = () => frames.map((f) => Number(/^id: (\d+)/.exec(f)?.[1]));
  return { conn, ids };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const tmpl: BoardSseEvent = BOARD_SSE_FIXTURES['session.status'];

describe('serveBoardStream', () => {
  it('delivers an event committed and published during the replay query exactly once', async () => {
    const { db, rows, pause } = fakeDb();
    const bus = new InMemoryBoardBus();
    commit(rows, 1, tmpl);
    commit(rows, 2, tmpl);
    const { conn, ids } = fakeConn();

    const release = pause();
    const served = serveBoardStream(conn, { db, boardBus: bus }, 0);
    await flush();
    // While the replay SELECT is in flight: id 3 commits and is published.
    bus.publish(commit(rows, 3, tmpl));
    release();
    await served;
    await flush();
    // Live: an audit row (skipped), then 5.
    rows.push({ id: '4', session_id: null, type: 'state.entered', payload: {}, ts: new Date() });
    bus.publish(commit(rows, 5, tmpl));
    await flush();
    await flush();
    expect(ids()).toEqual([1, 2, 3, 5]);
  });

  // TD-051: a publish landing after drain()'s final `again` check but before the `.finally()`
  // clears `running` used to set `again` on a drain that had already finished, so the event
  // waited for the next publish or reconnect. The exact window is a few microtasks wide, so
  // sweep the publish across every microtask offset after the last frame is written.
  it.each(Array.from({ length: 12 }, (_, d) => d))(
    'delivers a publish %i microtasks after a drain wrote its last frame (TD-051)',
    async (depth) => {
      const { db, rows } = fakeDb();
      const bus = new InMemoryBoardBus();
      const { conn, ids } = fakeConn();
      await serveBoardStream(conn, { db, boardBus: bus }, null);

      let armed = true;
      const write = conn.write.bind(conn);
      conn.write = (frame) => {
        write(frame);
        if (!armed) return;
        armed = false;
        // Commit + publish id 2 `depth` microtasks after frame 1 is written.
        let p = Promise.resolve();
        for (let i = 0; i < depth; i++) p = p.then(() => undefined);
        void p.then(() => bus.publish(commit(rows, 2, tmpl)));
      };
      bus.publish(commit(rows, 1, tmpl));
      for (let i = 0; i < 5; i++) await flush();
      expect(ids()).toEqual([1, 2]);
    },
  );

  it('starts at the current max without Last-Event-ID and unsubscribes on close', async () => {
    const { db, rows } = fakeDb();
    const bus = new InMemoryBoardBus();
    commit(rows, 7, tmpl);
    const { conn, ids } = fakeConn();
    await serveBoardStream(conn, { db, boardBus: bus }, null);
    bus.publish(commit(rows, 8, tmpl));
    await flush();
    await flush();
    expect(ids()).toEqual([8]);
    conn.close();
    bus.publish(commit(rows, 9, tmpl));
    await flush();
    expect(ids()).toEqual([8]);
  });
});

describe('parseLastEventId', () => {
  it('accepts non-negative integers only', () => {
    expect(parseLastEventId('42')).toBe(42);
    expect(parseLastEventId(['0'])).toBe(0);
    expect(parseLastEventId(undefined)).toBeNull();
    expect(parseLastEventId('-1')).toBeNull();
    expect(parseLastEventId('abc')).toBeNull();
  });
});
