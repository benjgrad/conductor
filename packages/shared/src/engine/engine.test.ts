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
