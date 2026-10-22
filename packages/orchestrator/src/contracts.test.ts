import {
  BOARD_SSE_FIXTURES,
  ORCHESTRATOR_FIXTURES,
  OUTPUT_RING_BYTES,
  SNAPSHOT_FIXTURE,
} from '@conductor/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeEngineService,
  FakeOutboxTransport,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from './contracts.js';

describe('FakeEngineService', () => {
  const sid = SNAPSHOT_FIXTURE.id;

  it('applies events to seeded sessions and returns scripted effects', async () => {
    const engine = new FakeEngineService().seed(SNAPSHOT_FIXTURE).respond('agent.ask_user', [
      {
        type: 'create_input_request',
        kind: 'agent_question',
        question: 'q?',
        return_to: 'implement',
      },
    ]);
    const r = await engine.applyEvent(
      sid,
      { type: 'agent.ask_user', question: 'q?' },
      { fencingToken: 1 },
    );
    expect(r.status).toBe('applied');
    if (r.status === 'applied') {
      expect(r.eventId).toBe(1);
      expect(r.effects).toHaveLength(1);
    }
    expect(engine.calls).toHaveLength(1);
  });

  it('rejects unknown sessions and stale fencing tokens', async () => {
    const engine = new FakeEngineService().seed({ ...SNAPSHOT_FIXTURE, fencing_token: 8 });
    expect(await engine.applyEvent('nope', { type: 'operator.cancel' })).toEqual({
      status: 'rejected',
      reason: 'unknown_session',
    });
    expect(await engine.applyEvent(sid, { type: 'operator.cancel' }, { fencingToken: 7 })).toEqual({
      status: 'rejected',
      reason: 'stale_fencing_token',
    });
  });

  it('rejects a second answer to the same input request', async () => {
    const engine = new FakeEngineService().seed(SNAPSHOT_FIXTURE);
    const ev = {
      type: 'input.provided',
      input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      answer: 'a',
    } as const;
    expect((await engine.applyEvent(sid, ev, { actor: 'ben' })).status).toBe('applied');
    expect(await engine.applyEvent(sid, ev)).toEqual({
      status: 'rejected',
      reason: 'input_already_answered',
    });
  });
});

describe('FakeOutboxTransport', () => {
  it('sends only to connected machines', async () => {
    const t = new FakeOutboxTransport();
    expect(await t.send('m1', ORCHESTRATOR_FIXTURES.run_cmd)).toBe('not_connected');
    t.connect('m1');
    expect(t.isConnected('m1')).toBe(true);
    expect(await t.send('m1', ORCHESTRATOR_FIXTURES.run_cmd)).toBe('sent');
    expect(t.sent).toEqual([{ machineId: 'm1', message: ORCHESTRATOR_FIXTURES.run_cmd }]);
    t.disconnect('m1');
    expect(t.isConnected('m1')).toBe(false);
  });
});

describe('InMemoryBoardBus', () => {
  it('fans out to subscribers until they unsubscribe', () => {
    const bus = new InMemoryBoardBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    bus.publish(BOARD_SSE_FIXTURES['card.moved']);
    off();
    bus.publish(BOARD_SSE_FIXTURES['input.answered']);
    expect(a).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
  });
});

describe('InMemoryOutputBus', () => {
  const sid = SNAPSHOT_FIXTURE.id;

  it('defaults to a 256 KB ring (U-005)', () => {
    expect(OUTPUT_RING_BYTES).toBe(256 * 1024);
    const bus = new InMemoryOutputBus();
    const kb = 'x'.repeat(1024);
    for (let i = 0; i < 300; i++) bus.append(sid, 'stdout', kb);
    expect(bus.size(sid)).toBe(256 * 1024);
    const snap = bus.snapshot(sid);
    expect(snap).toHaveLength(256);
    expect(snap[0]!.seq).toBe(44);
    expect(snap.at(-1)!.seq).toBe(299);
  });

  it('evicts oldest chunks, truncates oversize chunks to the tail, streams live', () => {
    const bus = new InMemoryOutputBus(10);
    const live = vi.fn();
    const off = bus.subscribe(sid, live);
    bus.append(sid, 'stdout', 'abcd');
    bus.append(sid, 'stderr', 'efgh');
    bus.append(sid, 'stdout', 'ijkl');
    expect(bus.snapshot(sid).map((c) => c.text)).toEqual(['efgh', 'ijkl']);
    bus.append(sid, 'stdout', '0123456789XYZ');
    expect(bus.snapshot(sid).map((c) => c.text)).toEqual(['3456789XYZ']);
    expect(live).toHaveBeenCalledTimes(4);
    off();
    bus.clear(sid);
    expect(bus.snapshot(sid)).toEqual([]);
  });

  it('keeps sessions separate', () => {
    const bus = new InMemoryOutputBus();
    bus.append('a', 'stdout', 'one');
    bus.append('b', 'stdout', 'two');
    expect(bus.snapshot('a').map((c) => c.text)).toEqual(['one']);
  });
});
