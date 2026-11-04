import { describe, expect, it } from 'vitest';
import { DAEMON_FIXTURES, M2_WS_FIXTURES, ORCHESTRATOR_FIXTURES } from './fixtures.js';
import {
  DaemonToOrchestratorSchema,
  EnvelopeSchema,
  HeartbeatPayloadSchema,
  ORCHESTRATOR_MESSAGE_TYPES,
  OrchestratorToDaemonSchema,
  parseDaemonMessage,
  parseOrchestratorMessage,
  UPDATE_FAILED_ERROR_MAX,
} from '../index.js';

// M2-T18b (ADR-0021): update_available, heartbeat.draining and the update_failed alert.

const wire = (v: unknown) => JSON.stringify(v);

describe('auto-update fixtures round-trip', () => {
  it.each([
    ['update_available', ORCHESTRATOR_FIXTURES.update_available],
    ['update_available (target)', M2_WS_FIXTURES.update_available],
  ])('%s', (_name, f) => {
    expect(parseOrchestratorMessage(wire(f))).toEqual(f);
    expect(EnvelopeSchema.safeParse(f).success).toBe(true);
  });

  it.each([
    ['heartbeat_draining', M2_WS_FIXTURES.heartbeat_draining],
    ['alert_update_failed', M2_WS_FIXTURES.alert_update_failed],
    ['git_tamper alert', DAEMON_FIXTURES.alert],
    ['git_tamper alert with session', M2_WS_FIXTURES.alert_with_session],
  ])('%s', (_name, f) => {
    expect(parseDaemonMessage(wire(f))).toEqual(f);
    expect(EnvelopeSchema.safeParse(f).success).toBe(true);
  });

  it('update_available is a direct frame type', () => {
    expect(ORCHESTRATOR_MESSAGE_TYPES).toContain('update_available');
  });
});

describe('update_available', () => {
  const base = M2_WS_FIXTURES.update_available;
  const withPayload = (p: object) => ({ ...base, payload: { ...base.payload, ...p } });

  it.each([
    ['a path in file', { file: '../x.tgz' }],
    ['a version not in file', { version: '0.4.0' }],
    ['an upper-case sha256', { sha256: base.payload.sha256.toUpperCase() }],
    ['a short sha256', { sha256: 'abc123' }],
    ['an oversize build', { size: 200 * 1024 * 1024 }],
  ])('refuses %s', (_name, p) => {
    expect(OrchestratorToDaemonSchema.safeParse(withPayload(p)).success).toBe(false);
  });

  it('is machine-level with no seq', () => {
    expect(OrchestratorToDaemonSchema.safeParse({ ...base, seq: 1 }).success).toBe(false);
    expect(
      OrchestratorToDaemonSchema.safeParse({ ...base, session_id: DAEMON_FIXTURES.alert.msg_id })
        .success,
    ).toBe(false);
  });
});

describe('heartbeat.draining', () => {
  it('is optional: an M1 heartbeat still parses', () => {
    const p = HeartbeatPayloadSchema.parse(DAEMON_FIXTURES.heartbeat.payload);
    expect(p.draining).toBeUndefined();
  });

  it('refuses another reason', () => {
    const f = M2_WS_FIXTURES.heartbeat_draining;
    const bad = { ...f.payload, draining: { reason: 'maintenance', version: '0.3.0' } };
    expect(HeartbeatPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe('alert update_failed', () => {
  const base = M2_WS_FIXTURES.alert_update_failed;
  const withPayload = (p: object) => ({ ...base, payload: { ...base.payload, ...p } });

  it('requires seq (durable)', () => {
    expect(DaemonToOrchestratorSchema.safeParse({ ...base, seq: null }).success).toBe(false);
  });

  it.each([
    ['an unknown stage', { stage: 'switch' }],
    ['an empty error', { error: '' }],
    ['a long error', { error: 'x'.repeat(UPDATE_FAILED_ERROR_MAX + 1) }],
    ['a bad version', { version: 'a b' }],
  ])('refuses %s', (_name, p) => {
    expect(DaemonToOrchestratorSchema.safeParse(withPayload(p)).success).toBe(false);
  });

  it('git_tamper fields are stripped, not required', () => {
    const parsed = parseDaemonMessage(withPayload({ repo: '/a', files: ['config'] }));
    expect(parsed.payload).toEqual(base.payload);
  });
});
