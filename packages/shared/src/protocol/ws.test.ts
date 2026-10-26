import { describe, expect, it } from 'vitest';
import {
  DAEMON_FIXTURES,
  M1B_WS_FIXTURES,
  ORCHESTRATOR_FIXTURES,
  SESSION_EVENT_FIXTURES,
  SESSION_EVENT_MESSAGE_FIXTURES,
} from './fixtures.js';
import {
  ConditionResultSchema,
  DAEMON_MESSAGE_TYPES,
  EvaluateConditionsArgsSchema,
  EvaluateConditionsResultSchema,
  DaemonToOrchestratorSchema,
  EnvelopeSchema,
  ORCHESTRATOR_MESSAGE_TYPES,
  OrchestratorToDaemonSchema,
  NO_OUTCOME_OUTPUT_CHARS,
  SESSION_EVENT_KINDS,
  SessionEventPayloadSchema,
  parseDaemonMessage,
  parseOrchestratorMessage,
} from './ws.js';

import { CompleteStateInputSchema, TRANSITION_REASON_MAX } from './outcome.js';

const wire = (v: unknown) => JSON.stringify(v);

describe('WS protocol fixtures', () => {
  it('has exactly one fixture per message type and session_event kind', () => {
    expect(Object.keys(DAEMON_FIXTURES).sort()).toEqual([...DAEMON_MESSAGE_TYPES].sort());
    expect(Object.keys(ORCHESTRATOR_FIXTURES).sort()).toEqual(
      [...ORCHESTRATOR_MESSAGE_TYPES].sort(),
    );
    expect(Object.keys(SESSION_EVENT_FIXTURES).sort()).toEqual([...SESSION_EVENT_KINDS].sort());
    expect(Object.keys(SESSION_EVENT_MESSAGE_FIXTURES).sort()).toEqual(
      [...SESSION_EVENT_KINDS].sort(),
    );
  });

  it.each(Object.entries(DAEMON_FIXTURES))('daemon %s round-trips', (_type, fixture) => {
    const parsed = parseDaemonMessage(wire(fixture));
    expect(parsed).toEqual(fixture);
    expect(JSON.parse(wire(parsed))).toEqual(fixture);
    expect(EnvelopeSchema.safeParse(fixture).success).toBe(true);
  });

  it.each(Object.entries(SESSION_EVENT_MESSAGE_FIXTURES))(
    'session_event %s round-trips',
    (_kind, fixture) => {
      expect(parseDaemonMessage(wire(fixture))).toEqual(fixture);
    },
  );

  it.each(Object.entries(ORCHESTRATOR_FIXTURES))('orchestrator %s round-trips', (_t, fixture) => {
    const parsed = parseOrchestratorMessage(wire(fixture));
    expect(parsed).toEqual(fixture);
    expect(EnvelopeSchema.safeParse(fixture).success).toBe(true);
  });
});

describe('ADR-0011 WS shapes (M1b-T01)', () => {
  it('complete_state with transition + reason round-trips; old shape still parses', () => {
    const fx = M1B_WS_FIXTURES.complete_state_transition;
    expect(parseDaemonMessage(wire(fx))).toEqual(fx);
    expect(parseDaemonMessage(wire(SESSION_EVENT_MESSAGE_FIXTURES.complete_state))).toEqual(
      SESSION_EVENT_MESSAGE_FIXTURES.complete_state,
    );
  });

  it('start_session with transitions round-trips; without them still parses', () => {
    const fx = M1B_WS_FIXTURES.start_session_transitions;
    expect(parseOrchestratorMessage(wire(fx))).toEqual(fx);
    expect(fx.payload.transitions?.map((t) => t.name)).toContain('ask_user');
    expect(parseOrchestratorMessage(wire(ORCHESTRATOR_FIXTURES.start_session))).toEqual(
      ORCHESTRATOR_FIXTURES.start_session,
    );
  });

  it('run_action evaluate_conditions round-trips and its args parse', () => {
    const fx = M1B_WS_FIXTURES.run_action_evaluate_conditions;
    expect(parseOrchestratorMessage(wire(fx))).toEqual(fx);
    expect(EvaluateConditionsArgsSchema.parse(fx.payload.args)).toEqual(fx.payload.args);
    const bad = { ...fx, payload: { ...fx.payload, action: 'deploy' } };
    expect(OrchestratorToDaemonSchema.safeParse(bad).success).toBe(false);
  });

  it('action_result for evaluate_conditions round-trips and its result parses', () => {
    const fx = M1B_WS_FIXTURES.action_result_evaluate_conditions;
    expect(parseDaemonMessage(wire(fx))).toEqual(fx);
    if (fx.payload.kind !== 'action_result') throw new Error('fixture');
    const res = EvaluateConditionsResultSchema.parse(fx.payload.data.result);
    expect(res.results.map((r) => r.status)).toEqual(['met', 'pending']);
    expect(
      ConditionResultSchema.safeParse({
        type: 'pr_merged',
        status: 'todo',
        value: null,
        detail: null,
      }).success,
    ).toBe(false);
  });

  it('CompleteStateInputSchema: transition and reason optional, capped', () => {
    expect(CompleteStateInputSchema.parse({ result: {} })).toEqual({ result: {} });
    expect(
      CompleteStateInputSchema.parse({ transition: 'done', reason: 'ok', result: { a: 1 } }),
    ).toEqual({ transition: 'done', reason: 'ok', result: { a: 1 } });
    expect(CompleteStateInputSchema.safeParse({ transition: '', result: {} }).success).toBe(false);
    expect(
      CompleteStateInputSchema.safeParse({
        reason: 'x'.repeat(TRANSITION_REASON_MAX + 1),
        result: {},
      }).success,
    ).toBe(false);
    expect(CompleteStateInputSchema.safeParse({ transition: 'done' }).success).toBe(false);
  });
});

describe('WS envelope rules', () => {
  it('rejects a session_event without seq (it is durable and deduped on seq)', () => {
    const bad = { ...DAEMON_FIXTURES.session_event, seq: null };
    expect(DaemonToOrchestratorSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a session_event without fencing_token', () => {
    const bad = { ...DAEMON_FIXTURES.session_event, fencing_token: null };
    expect(DaemonToOrchestratorSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown session_event kind', () => {
    const bad = { ...DAEMON_FIXTURES.session_event, payload: { kind: 'turn_end', data: {} } };
    expect(DaemonToOrchestratorSchema.safeParse(bad).success).toBe(false);
  });

  it.each(['started', 'exit'] as const)(
    'rejects session_event %s without the start_session command_id',
    (kind) => {
      const data: Record<string, unknown> = { ...SESSION_EVENT_FIXTURES[kind].data };
      delete data.command_id;
      const bad = { ...DAEMON_FIXTURES.session_event, payload: { kind, data } };
      expect(DaemonToOrchestratorSchema.safeParse(bad).success).toBe(false);
    },
  );

  it('rejects a session-scoped orchestrator command without session_id', () => {
    const bad = { ...ORCHESTRATOR_FIXTURES.run_cmd, session_id: null };
    expect(OrchestratorToDaemonSchema.safeParse(bad).success).toBe(false);
  });

  it('kill carries target_command_id (orphan kills) and requires the key', () => {
    const orphanKill = {
      ...ORCHESTRATOR_FIXTURES.kill,
      payload: {
        command_id: null,
        target_command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
        reason: 'ack_timeout',
      },
    };
    expect(parseOrchestratorMessage(wire(orphanKill))).toEqual(orphanKill);
    const missing = {
      ...ORCHESTRATOR_FIXTURES.kill,
      payload: { command_id: null, reason: 'stale_fencing_token' },
    };
    expect(OrchestratorToDaemonSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects unknown message types and garbage frames', () => {
    expect(() => parseDaemonMessage('{"type":"nope"}')).toThrow();
    expect(() => parseDaemonMessage('not json')).toThrow();
  });

  it('no_outcome (U-028) caps last_output at NO_OUTCOME_OUTPUT_CHARS', () => {
    const ok = { kind: 'no_outcome', data: { last_output: 'x'.repeat(NO_OUTCOME_OUTPUT_CHARS) } };
    expect(SessionEventPayloadSchema.safeParse(ok).success).toBe(true);
    const long = {
      kind: 'no_outcome',
      data: { last_output: 'x'.repeat(NO_OUTCOME_OUTPUT_CHARS + 1) },
    };
    expect(SessionEventPayloadSchema.safeParse(long).success).toBe(false);
  });
});
