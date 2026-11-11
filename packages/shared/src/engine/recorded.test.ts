import { describe, expect, it } from 'vitest';
import { engineEventFromRow, eventPayload } from './recorded.js';
import type { EngineEvent } from './types.js';

const CMD = '00000000-0000-4000-8000-000000000001';

const roundTrip = (e: EngineEvent, ignored: string | null = null) =>
  engineEventFromRow(e.type, eventPayload(e, ignored));

describe('eventPayload / engineEventFromRow', () => {
  it('round-trips an event and its ignore reason', () => {
    const e: EngineEvent = { type: 'agent.complete_state', result: { a: 1 }, transition: 'done' };
    expect(eventPayload(e, null)).toEqual({ result: { a: 1 }, transition: 'done' });
    expect(roundTrip(e)).toEqual({ event: e, ignored: null });
    expect(roundTrip(e, 'wrong_status')).toEqual({ event: e, ignored: 'wrong_status' });
  });

  it('keeps the byte count, not the output: the tail comes back empty', () => {
    const e: EngineEvent = {
      type: 'command.exited',
      command_id: CMD,
      exit_code: 1,
      timed_out: false,
      output_tail: 'héllo',
    };
    const payload = eventPayload(e, null);
    expect(payload).not.toHaveProperty('output_tail');
    expect(payload.output_tail_bytes).toBe(6);
    expect(engineEventFromRow(e.type, payload)).toEqual({
      event: { ...e, output_tail: '' },
      ignored: null,
    });
  });

  it('drops the stderr tail of an exit', () => {
    const e: EngineEvent = {
      type: 'agent.exited',
      command_id: CMD,
      code: 1,
      signal: null,
      stderr_tail: 'secret',
    };
    const payload = eventPayload(e, null);
    expect(payload.stderr_tail_bytes).toBe(6);
    const back = engineEventFromRow(e.type, payload);
    expect(back).toEqual({
      event: { type: 'agent.exited', command_id: CMD, code: 1, signal: null },
      ignored: null,
    });
  });

  it('is null for a row that is not an engine event', () => {
    expect(engineEventFromRow('state.entered', { from: null, to: 'x', visit: 1 })).toBeNull();
    expect(engineEventFromRow('operator.reopen', { text: 'again' })).toBeNull();
  });

  it('reports a row that no longer parses', () => {
    const r = engineEventFromRow('session.assigned', { machine: 'm' });
    expect(r).toMatchObject({ error: expect.stringContaining('session.assigned') as string });
  });
});
