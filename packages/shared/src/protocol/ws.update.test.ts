import { describe, expect, it } from 'vitest';
import { DAEMON_FIXTURES, M2_WS_FIXTURES } from './fixtures.js';
import {
  DaemonToOrchestratorSchema,
  EnvelopeSchema,
  HeartbeatPayloadSchema,
  ORCHESTRATOR_MESSAGE_TYPES,
  OrchestratorToDaemonSchema,
  parseDaemonMessage,
  parseOrchestratorMessage,
} from './ws.js';

// ADR-0021 (M2-T18b): update_available, heartbeat.draining, alert update_failed.

const wire = (v: unknown) => JSON.stringify(v);

describe('auto-update fixtures', () => {
  it('update_available is an orchestrator message type', () => {
    expect(ORCHESTRATOR_MESSAGE_TYPES).toContain('update_available');
  });

  it('update_available round-trips', () => {
    const f = M2_WS_FIXTURES.update_available;
    expect(parseOrchestratorMessage(wire(f))).toEqual(f);
    expect(EnvelopeSchema.safeParse(f).success).toBe(true);
  });

  it.each([
    ['heartbeat_draining', M2_WS_FIXTURES.heartbeat_draining],
    ['alert_update_failed', M2_WS_FIXTURES.alert_update_failed],
    // T02's git_tamper alerts still parse.
    ['alert (git_tamper)', DAEMON_FIXTURES.alert],
    ['alert_with_session (git_tamper)', M2_WS_FIXTURES.alert_with_session],
  ])('daemon %s round-trips', (_name, f) => {
    expect(parseDaemonMessage(wire(f))).toEqual(f);
    expect(EnvelopeSchema.safeParse(f).success).toBe(true);
  });

  it('a heartbeat without draining still parses', () => {
    const p = HeartbeatPayloadSchema.parse(DAEMON_FIXTURES.heartbeat.payload);
    expect(p.draining).toBeUndefined();
    expect(parseDaemonMessage(wire(DAEMON_FIXTURES.heartbeat))).toEqual(DAEMON_FIXTURES.heartbeat);
  });
});

describe('update_available', () => {
  const base = M2_WS_FIXTURES.update_available;
  const bad = (patch: object) => ({ ...base, payload: { ...base.payload, ...patch } });

  it.each([
    ['file ../x.tgz', { file: '../x.tgz' }],
    ['a version not in file', { version: '0.4.0' }],
    ['an uppercase sha256', { sha256: 'AB'.repeat(32) }],
    ['a short sha256', { sha256: 'ab'.repeat(31) }],
    ['a size over 100 MB', { size: 100 * 1024 * 1024 + 1 }],
  ])('refuses %s', (_name, patch) => {
    expect(OrchestratorToDaemonSchema.safeParse(bad(patch)).success).toBe(false);
  });

  it('is machine-level with no seq', () => {
    expect(OrchestratorToDaemonSchema.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(
      OrchestratorToDaemonSchema.safeParse({
        ...base,
        session_id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
        fencing_token: 1,
      }).success,
    ).toBe(false);
  });
});

describe('heartbeat.draining', () => {
  const base = M2_WS_FIXTURES.heartbeat_draining;

  it('refuses another reason or a bad version', () => {
    for (const draining of [
      { reason: 'other', version: '0.3.0' },
      { reason: 'update', version: '../x' },
      { reason: 'update' },
      null,
    ]) {
      expect(
        DaemonToOrchestratorSchema.safeParse({ ...base, payload: { ...base.payload, draining } })
          .success,
        JSON.stringify(draining),
      ).toBe(false);
    }
  });
});

describe('alert update_failed', () => {
  const base = M2_WS_FIXTURES.alert_update_failed;
  const withPayload = (payload: object) => ({ ...base, payload: { ...base.payload, ...payload } });

  it('requires seq (durable)', () => {
    expect(DaemonToOrchestratorSchema.safeParse({ ...base, seq: null }).success).toBe(false);
  });

  it('refuses an unknown stage, a long or empty error, or no version', () => {
    for (const patch of [
      { stage: 'install' },
      { error: 'x'.repeat(501) },
      { error: '' },
      { version: undefined },
      { at: 'yesterday' },
    ]) {
      expect(
        DaemonToOrchestratorSchema.safeParse(withPayload(patch)).success,
        JSON.stringify(patch).slice(0, 60),
      ).toBe(false);
    }
    expect(
      DaemonToOrchestratorSchema.safeParse(withPayload({ error: 'x'.repeat(500) })).success,
    ).toBe(true);
  });

  it('git_tamper fields do not make an update_failed alert valid', () => {
    const { kind: _kind, ...tamper } = M2_WS_FIXTURES.alert_with_session.payload;
    expect(
      DaemonToOrchestratorSchema.safeParse({
        ...base,
        payload: { ...tamper, kind: 'update_failed' },
      }).success,
    ).toBe(false);
  });
});
