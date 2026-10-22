import { describe, expect, it } from 'vitest';
import {
  DAEMON_FIXTURES,
  ORCHESTRATOR_FIXTURES,
  SESSION_EVENT_FIXTURES,
  SESSION_EVENT_MESSAGE_FIXTURES,
} from './fixtures.js';
import {
  DAEMON_MESSAGE_TYPES,
  DaemonToOrchestratorSchema,
  EnvelopeSchema,
  ORCHESTRATOR_MESSAGE_TYPES,
  OrchestratorToDaemonSchema,
  SESSION_EVENT_KINDS,
  parseDaemonMessage,
  parseOrchestratorMessage,
} from './ws.js';

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

  it('rejects a session-scoped orchestrator command without session_id', () => {
    const bad = { ...ORCHESTRATOR_FIXTURES.run_cmd, session_id: null };
    expect(OrchestratorToDaemonSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown message types and garbage frames', () => {
    expect(() => parseDaemonMessage('{"type":"nope"}')).toThrow();
    expect(() => parseDaemonMessage('not json')).toThrow();
  });
});
