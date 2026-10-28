import { describe, expect, it } from 'vitest';
import { permissionDecisionCommand } from './commands.js';
import {
  DAEMON_FIXTURES,
  ORCHESTRATOR_FIXTURES,
  PERMISSION_FIXTURE_IDS,
  PERMISSION_WS_FIXTURES,
} from './fixtures.js';
import {
  COMMAND_REFUSAL_REASONS,
  DAEMON_MESSAGE_TYPES,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  ORCHESTRATOR_MESSAGE_TYPES,
  OrchestratorToDaemonSchema,
  PERMISSION_INPUT_MAX_BYTES,
  PERMISSION_MESSAGE_MAX,
  PERMISSION_SUGGESTIONS_MAX,
  PERMISSION_TOOL_MAX,
  PermissionDecisionPayloadSchema,
  PermissionRequestPayloadSchema,
  jsonByteLength,
  parseDaemonMessage,
  parseOrchestratorMessage,
} from './ws.js';

// M2-T29 (ADR-0023): 10-contracts §Permission prompts.

const wire = (v: unknown) => JSON.stringify(v);
const request = DAEMON_FIXTURES.permission_request;
const decision = ORCHESTRATOR_FIXTURES.permission_decision;

/** A request whose `input` is exactly `bytes` bytes of UTF-8 JSON. */
function inputOfBytes(bytes: number, fill = 'x'): Record<string, string> {
  const overhead = jsonByteLength({ command: '' });
  const unit = new TextEncoder().encode(fill).length;
  const input = { command: fill.repeat(Math.floor((bytes - overhead) / unit)) };
  expect(jsonByteLength(input)).toBe(bytes);
  return input;
}

const withRequest = (payload: Record<string, unknown>) => ({
  ...request,
  payload: { ...request.payload, ...payload },
});
const withDecision = (payload: Record<string, unknown>) => ({
  ...decision,
  payload: { ...decision.payload, ...payload },
});

describe('permission prompt frames (M2-T29)', () => {
  it('are listed in each direction', () => {
    expect(DAEMON_MESSAGE_TYPES).toContain('permission_request');
    expect(ORCHESTRATOR_MESSAGE_TYPES).toContain('permission_decision');
    expect(COMMAND_REFUSAL_REASONS).toContain('unknown_permission_request');
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it.each([
    ['permission_request', request],
    ['request_with_suggestions', PERMISSION_WS_FIXTURES.request_with_suggestions],
  ])('daemon %s round-trips', (_name, fixture) => {
    const parsed = parseDaemonMessage(wire(fixture));
    expect(parsed).toEqual(fixture);
    expect(JSON.parse(wire(parsed))).toEqual(fixture);
  });

  it.each([
    ['permission_decision (deny with a note)', decision],
    ['allow_once', PERMISSION_WS_FIXTURES.allow_once],
    ['allow_always', PERMISSION_WS_FIXTURES.allow_always],
    ['deny_without_note', PERMISSION_WS_FIXTURES.deny_without_note],
  ])('orchestrator %s round-trips', (_name, fixture) => {
    const parsed = parseOrchestratorMessage(wire(fixture));
    expect(parsed).toEqual(fixture);
    expect(JSON.parse(wire(parsed))).toEqual(fixture);
  });
});

describe('permission_request', () => {
  it('is durable and session-scoped: seq, session_id and fencing_token are required', () => {
    expect(() => parseDaemonMessage({ ...request, seq: null })).toThrow();
    expect(() => parseDaemonMessage({ ...request, session_id: null })).toThrow();
    expect(() => parseDaemonMessage({ ...request, fencing_token: null })).toThrow();
  });

  it('accepts input up to PERMISSION_INPUT_MAX_BYTES of JSON and rejects one byte more', () => {
    expect(PERMISSION_INPUT_MAX_BYTES).toBe(65_536);
    const ok = withRequest({ input: inputOfBytes(PERMISSION_INPUT_MAX_BYTES) });
    expect(parseDaemonMessage(ok)).toEqual(ok);
    const over = withRequest({ input: inputOfBytes(PERMISSION_INPUT_MAX_BYTES + 1) });
    expect(() => parseDaemonMessage(over)).toThrow(/larger than 65536 bytes/);
  });

  it('counts the input in UTF-8 bytes, not characters', () => {
    // 'é' is 2 bytes: 40 000 of them is under 64 Ki characters but over 64 KiB.
    const input = { command: 'é'.repeat(40_000) };
    expect(JSON.stringify(input).length).toBeLessThan(PERMISSION_INPUT_MAX_BYTES);
    expect(PermissionRequestPayloadSchema.safeParse({ ...request.payload, input }).success).toBe(
      false,
    );
  });

  it('input must be a JSON object', () => {
    for (const input of ['ls', ['ls'], null, 42]) {
      expect(() => parseDaemonMessage(withRequest({ input }))).toThrow();
    }
  });

  it('bounds suggestions by count and by size', () => {
    const one = { type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'session' };
    const max = Array.from({ length: PERMISSION_SUGGESTIONS_MAX }, () => one);
    expect(parseDaemonMessage(withRequest({ suggestions: max }))).toBeTruthy();
    expect(() => parseDaemonMessage(withRequest({ suggestions: [...max, one] }))).toThrow();
    const big = [{ note: 'x'.repeat(16 * 1024) }];
    expect(() => parseDaemonMessage(withRequest({ suggestions: big }))).toThrow(
      /suggestions are larger/,
    );
  });

  it('rejects a bad tool, request_id or expires_at', () => {
    for (const bad of [
      { tool: '' },
      { tool: 'x'.repeat(PERMISSION_TOOL_MAX + 1) },
      { request_id: 'not-a-uuid' },
      { expires_at: 'in 30 minutes' },
      { expires_at: undefined },
    ]) {
      expect(() => parseDaemonMessage(withRequest(bad)), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('permission_decision', () => {
  it('rejects an unknown behavior or scope', () => {
    for (const bad of [
      { behavior: 'ask' },
      { behavior: 'ALLOW' },
      { scope: 'forever' },
      { scope: 'session' },
      { behavior: undefined },
      { scope: undefined },
    ]) {
      expect(() => parseOrchestratorMessage(withDecision(bad)), JSON.stringify(bad)).toThrow();
    }
  });

  it('a deny is always scope once', () => {
    const r = PermissionDecisionPayloadSchema.safeParse({
      ...decision.payload,
      behavior: 'deny',
      scope: 'always',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['scope']);
  });

  it('rule only with scope always; message bounded', () => {
    expect(() =>
      parseOrchestratorMessage(
        withDecision({ behavior: 'allow', scope: 'once', rule: 'Bash(pnpm i)' }),
      ),
    ).toThrow();
    expect(() =>
      parseOrchestratorMessage(withDecision({ message: 'x'.repeat(PERMISSION_MESSAGE_MAX + 1) })),
    ).toThrow();
    expect(
      parseOrchestratorMessage(withDecision({ message: 'x'.repeat(PERMISSION_MESSAGE_MAX) })),
    ).toBeTruthy();
  });

  it('is an outbox command: command_id required, orchestrator envelope (seq null)', () => {
    const noCommand: Partial<typeof decision.payload> = { ...decision.payload };
    delete noCommand.command_id;
    expect(() => parseOrchestratorMessage({ ...decision, payload: noCommand })).toThrow();
    expect(() => parseOrchestratorMessage({ ...decision, seq: 3 })).toThrow();
    expect(() => parseOrchestratorMessage({ ...decision, session_id: null })).toThrow();
  });
});

describe('permissionDecisionCommand', () => {
  const base = {
    command_id: PERMISSION_FIXTURE_IDS.decisionCommand,
    machine_id: 'mbp-ben',
    request_id: PERMISSION_FIXTURE_IDS.request,
  };

  it('builds the outbox row; the payload is a valid WS command', () => {
    const c = permissionDecisionCommand({
      ...base,
      behavior: 'allow',
      scope: 'always',
      message: null,
      rule: 'Bash(pnpm exec tsc -b)',
    });
    expect(c).toEqual({
      kind: 'permission_decision',
      target: 'machine:mbp-ben',
      payload: { ...PERMISSION_WS_FIXTURES.allow_always.payload },
    });
    expect(
      OrchestratorToDaemonSchema.parse({
        ...PERMISSION_WS_FIXTURES.allow_always,
        payload: c.payload,
      }).payload,
    ).toEqual(c.payload);
  });

  it('omits an empty message and a null rule', () => {
    const c = permissionDecisionCommand({
      ...base,
      behavior: 'deny',
      scope: 'once',
      message: '',
      rule: null,
    });
    expect(c.payload).toEqual(PERMISSION_WS_FIXTURES.deny_without_note.payload);
  });

  it('throws on a deny with scope always', () => {
    expect(() =>
      permissionDecisionCommand({ ...base, behavior: 'deny', scope: 'always' }),
    ).toThrow();
  });
});

describe('older frames still parse (additive)', () => {
  it.each(Object.entries(DAEMON_FIXTURES).filter(([t]) => t !== 'permission_request'))(
    'daemon %s',
    (_t, fixture) => {
      expect(parseDaemonMessage(wire(fixture))).toEqual(fixture);
    },
  );

  it.each(Object.entries(ORCHESTRATOR_FIXTURES).filter(([t]) => t !== 'permission_decision'))(
    'orchestrator %s',
    (_t, fixture) => {
      expect(parseOrchestratorMessage(wire(fixture))).toEqual(fixture);
    },
  );

  it('a heartbeat without any permission field parses unchanged', () => {
    expect(parseDaemonMessage(wire(DAEMON_FIXTURES.heartbeat))).toEqual(DAEMON_FIXTURES.heartbeat);
  });
});
