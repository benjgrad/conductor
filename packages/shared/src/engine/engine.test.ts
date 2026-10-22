import { describe, expect, it } from 'vitest';
import { OutboxKindSchema } from '../domain.js';
import { ORCHESTRATOR_MESSAGE_TYPES } from '../protocol/ws.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { applySpend, spendDelta } from './spend.js';
import {
  apply,
  EffectSchema,
  EngineEventSchema,
  isOutboxEffect,
  OUTBOX_EFFECT_TYPES,
  SessionSnapshotSchema,
} from './types.js';
import { SNAPSHOT_FIXTURE } from './fixtures.js';

describe('engine contract', () => {
  it('snapshot fixture is schema-valid', () => {
    expect(SessionSnapshotSchema.parse(SNAPSHOT_FIXTURE)).toEqual(SNAPSHOT_FIXTURE);
  });

  it('apply is a stub until M1-T04', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'x',
      version: 1,
      start: 'done',
      budget: { usd: 1, minutes: 1, max_loop_retries: 0 },
      states: { done: { type: 'terminal' } },
    });
    expect(() => apply(def, SNAPSHOT_FIXTURE, { type: 'operator.cancel' }, new Date())).toThrow(
      'not implemented (M1-T04)',
    );
  });

  it('has an Effect for every outbox kind', () => {
    expect([...OUTBOX_EFFECT_TYPES].sort()).toEqual([...OutboxKindSchema.options].sort());
    const effectTypes = EffectSchema.options.map((o) => o.shape.type.value);
    for (const k of OutboxKindSchema.options) expect(effectTypes).toContain(k);
  });

  it('every outbox effect except connector_call has a same-named WS message', () => {
    for (const k of OUTBOX_EFFECT_TYPES.filter((t) => t !== 'connector_call')) {
      expect(ORCHESTRATOR_MESSAGE_TYPES).toContain(k);
    }
    expect(isOutboxEffect({ type: 'kill', reason: 'x' })).toBe(true);
    expect(isOutboxEffect({ type: 'ticket_status', to: 'done' })).toBe(false);
  });

  it('includes budget.exceeded and input.provided{input_request_id, answer, goto?}', () => {
    const types = EngineEventSchema.options.map((o) => o.shape.type.value);
    expect(types).toContain('budget.exceeded');
    expect(
      EngineEventSchema.parse({
        type: 'input.provided',
        input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        answer: 'yes',
        goto: 'build',
      }),
    ).toMatchObject({ goto: 'build' });
  });
});

describe('process correlation and refusals', () => {
  const cmd = '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170';

  it('command.refused carries command_id, command_kind and reason (replaces start_refused)', () => {
    const types = EngineEventSchema.options.map((o) => o.shape.type.value);
    expect(types).not.toContain('session.start_refused');
    expect(
      EngineEventSchema.parse({
        type: 'command.refused',
        command_id: cmd,
        command_kind: 'send_input',
        reason: 'no_live_process',
      }),
    ).toMatchObject({ command_kind: 'send_input' });
    expect(
      EngineEventSchema.safeParse({ type: 'command.refused', command_id: cmd, reason: 'x' })
        .success,
    ).toBe(false);
  });

  it('session.started and agent.exited require the start_session command_id', () => {
    const started = {
      type: 'session.started',
      command_id: cmd,
      worktree_path: '/wt',
      branch: 'b',
      port_range: { base: 41000, count: 10 },
    };
    expect(EngineEventSchema.parse(started)).toEqual(started);
    expect(EngineEventSchema.safeParse({ ...started, command_id: undefined }).success).toBe(false);
    expect(EngineEventSchema.safeParse({ ...started, port_range: undefined }).success).toBe(false);
    expect(
      EngineEventSchema.safeParse({ type: 'agent.exited', code: 0, signal: null }).success,
    ).toBe(false);
  });

  it('snapshot tracks the current agent process', () => {
    expect(SNAPSHOT_FIXTURE.agent_command_id).toBe(cmd);
    expect(SNAPSHOT_FIXTURE.agent_process_live).toBe(true);
    const noLive: Partial<typeof SNAPSHOT_FIXTURE> = { ...SNAPSHOT_FIXTURE };
    delete noLive.agent_process_live;
    expect(SessionSnapshotSchema.safeParse(noLive).success).toBe(false);
  });
});

describe('spend (cumulative per claude_session_id)', () => {
  const s0 = { spend_usd: 0, claude_spend_totals: {} as Record<string, number> };

  it('adds only positive deltas; duplicates and replays are no-ops', () => {
    const s1 = applySpend(s0, 'a', 0.4);
    expect(s1.spend_usd).toBeCloseTo(0.4);
    expect(applySpend(s1, 'a', 0.4)).toBe(s1);
    expect(applySpend(s1, 'a', 0.3)).toBe(s1);
    const s2 = applySpend(s1, 'a', 1.0);
    expect(s2.spend_usd).toBeCloseTo(1.0);
    expect(s2.claude_spend_totals).toEqual({ a: 1.0 });
  });

  it('tracks each Claude session separately', () => {
    const s = applySpend(applySpend(s0, 'a', 0.5), 'b', 0.2);
    expect(s.spend_usd).toBeCloseTo(0.7);
    expect(spendDelta(s, 'b', 0.25)).toBeCloseTo(0.05);
  });
});
