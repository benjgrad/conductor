import { createServer } from 'node:http';
import {
  BOARD_SSE_FIXTURES,
  ORCHESTRATOR_FIXTURES,
  SNAPSHOT_FIXTURE,
  type BoardSseEvent,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  BOARD_EVENT_LOCK_KEY,
  commandEnvelopeForOutboxRow,
  FakeEngineService,
  FakeOutboxTransport,
  insertBoardEvents,
  type Queryable,
} from './contracts.js';
import type { OutboxRow } from './db/types.js';
import { composeOrchestrator, type Db } from './main.js';

const sid = SNAPSHOT_FIXTURE.id;

describe('FakeEngineService.respondWith', () => {
  it('scripts ignored, rejected and boardEvents results; undefined falls through', async () => {
    const card = BOARD_SSE_FIXTURES['card.upserted'];
    const engine = new FakeEngineService()
      .seed(SNAPSHOT_FIXTURE)
      .respondWith(({ event, snapshot }) => {
        if (event.type === 'session.started') {
          return {
            status: 'ignored',
            eventId: 41,
            reason: 'command_id_mismatch',
            snapshot: snapshot!,
          };
        }
        if (event.type === 'external.event') return { status: 'rejected', reason: 'invalid_goto' };
        if (event.type === 'operator.cancel') {
          return {
            status: 'applied',
            eventId: 42,
            snapshot: snapshot!,
            effects: [],
            boardEvents: [card],
          };
        }
        return undefined;
      });
    const started = await engine.applyEvent(sid, {
      type: 'session.started',
      command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
      worktree_path: '/w',
      branch: 'b',
      port_range: { base: 41000, count: 10 },
    });
    expect(started).toMatchObject({ status: 'ignored', reason: 'command_id_mismatch' });
    expect(await engine.applyEvent(sid, { type: 'external.event', name: 'x' })).toEqual({
      status: 'rejected',
      reason: 'invalid_goto',
    });
    const cancel = await engine.applyEvent(sid, { type: 'operator.cancel' });
    expect(cancel.status === 'applied' && cancel.boardEvents).toEqual([card]);
    // Fall-through keeps the default behaviour (fencing, unknown session).
    expect(
      await engine.applyEvent('nope', {
        type: 'budget.exceeded',
        dimension: 'usd',
        spent: 1,
        limit: 1,
      }),
    ).toEqual({ status: 'rejected', reason: 'unknown_session' });
    expect(engine.calls).toHaveLength(4);
  });
});

/** Records queries; answers event INSERTs like Postgres would (bigserial, now()). */
class RecordingTx implements Queryable {
  readonly queries: { text: string; values: unknown[] }[] = [];
  private id = 500;
  query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    const rows = text.startsWith('INSERT INTO event')
      ? [
          {
            id: String(this.id++),
            session_id: values[0],
            type: values[1],
            payload: JSON.parse(values[2] as string) as unknown,
            ts: new Date('2026-10-22T12:00:00.000Z'),
          },
        ]
      : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Promise.resolve({ rows, rowCount: rows.length } as any);
  }
}

describe('insertBoardEvents', () => {
  const draft = (e: BoardSseEvent) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ts, ...rest } = e;
    return rest;
  };

  it('takes the advisory xact lock first, then inserts in order and decodes', async () => {
    const tx = new RecordingTx();
    const out = await insertBoardEvents(tx, [
      draft(BOARD_SSE_FIXTURES['session.status']),
      draft(BOARD_SSE_FIXTURES['card.moved']),
    ]);
    expect(tx.queries[0]).toEqual({
      text: 'SELECT pg_advisory_xact_lock($1)',
      values: [BOARD_EVENT_LOCK_KEY],
    });
    expect(tx.queries.slice(1).map((q) => q.values[1])).toEqual(['session.status', 'card.moved']);
    expect(out.map((e) => e.id)).toEqual([500, 501]);
    expect(out[1]).toEqual({ ...BOARD_SSE_FIXTURES['card.moved'], id: 501 });
  });

  it('does nothing (no lock) for an empty list', async () => {
    const tx = new RecordingTx();
    expect(await insertBoardEvents(tx, [])).toEqual([]);
    expect(tx.queries).toEqual([]);
  });
});

describe('commandEnvelopeForOutboxRow', () => {
  const fx = ORCHESTRATOR_FIXTURES.start_session;
  const row: OutboxRow = {
    id: '1',
    command_id: fx.payload.command_id,
    target: 'machine:mbp-ben',
    kind: 'start_session',
    session_id: fx.session_id,
    payload: fx.payload as OutboxRow['payload'],
    idempotency_key: null,
    fencing_token: '3',
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date(),
    last_error: null,
    created_at: new Date(),
  };

  it('wraps the stored payload with the row fencing token', () => {
    const msg = commandEnvelopeForOutboxRow(row, fx.msg_id);
    expect(msg).toEqual({ ...fx, fencing_token: 3 });
  });

  it('refuses connector rows and bad payloads', () => {
    expect(() =>
      commandEnvelopeForOutboxRow({ ...row, kind: 'connector_call' }, fx.msg_id),
    ).toThrow();
    expect(() => commandEnvelopeForOutboxRow({ ...row, payload: {} }, fx.msg_id)).toThrow();
  });
});

describe('composeOrchestrator (skeleton wiring)', () => {
  it('wires engine → gateway → api and starts/stops in order', async () => {
    const log: string[] = [];
    const engine = new FakeEngineService();
    const transport = new FakeOutboxTransport();
    const server = createServer();
    const db = {
      end: () => (log.push('db.end'), Promise.resolve()),
      // ADR-0010: start() seeds the conductor workflow first (M1b-T09: several queries, one entry).
      query: () => (
        log.at(-1) !== 'seed' && log.push('seed'),
        Promise.resolve({ rowCount: 1, rows: [] })
      ),
    } as unknown as Db;
    const o = composeOrchestrator(
      {
        createDb: () => db,
        createEngineService: () => ({
          engine,
          startWorkers: (d) => {
            expect(d.transport).toBe(transport);
            log.push('workers');
            return { stop: () => (log.push('workers.stop'), Promise.resolve()) };
          },
        }),
        createGateway: (d) => {
          expect(d.engine).toBe(engine);
          return {
            transport,
            attach: (s) => (expect(s).toBe(server), log.push('attach')),
            close: () => (log.push('gateway.close'), Promise.resolve()),
          };
        },
        createApi: (d) => {
          expect(d.engine).toBe(engine);
          return {
            server,
            listen: (port) => (log.push(`listen:${port}`), Promise.resolve()),
            close: () => (log.push('api.close'), Promise.resolve()),
          };
        },
      },
      { databaseUrl: 'postgres://unused', port: 7401 },
    );
    await o.start();
    await o.stop();
    expect(log).toEqual([
      'attach',
      'seed',
      'workers',
      'listen:7401',
      'workers.stop',
      'gateway.close',
      'api.close',
      'db.end',
    ]);
  });
});
