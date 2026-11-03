import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_FIXTURE_IDS,
  ASSISTANT_WS_FIXTURES,
  DAEMON_FIXTURES,
  ORCHESTRATOR_FIXTURES,
} from './fixtures.js';
import {
  ASSISTANT_JOB_PROMPT_MAX,
  ASSISTANT_JOB_TIMEOUT_MAX_MS,
  ASSISTANT_JOB_TRANSCRIPT_MAX_CHARS,
  AssistantJobPayloadSchema,
  AssistantResultPayloadSchema,
  COMMAND_REFUSAL_REASONS,
  DAEMON_FEATURE_ASSISTANT_JOB,
  DAEMON_MESSAGE_TYPES,
  ORCHESTRATOR_MESSAGE_TYPES,
  RegisterPayloadSchema,
  parseDaemonMessage,
  parseOrchestratorMessage,
} from './ws.js';

// ADR-0033 P2: 10-contracts §Assistant jobs.

const wire = (v: unknown) => JSON.stringify(v);
const job = ORCHESTRATOR_FIXTURES.assistant_job;
const result = DAEMON_FIXTURES.assistant_result;

describe('assistant job frames', () => {
  it('are listed in each direction, with the refusal reason', () => {
    expect(ORCHESTRATOR_MESSAGE_TYPES).toContain('assistant_job');
    expect(DAEMON_MESSAGE_TYPES).toContain('assistant_result');
    expect(COMMAND_REFUSAL_REASONS).toContain('light_slot_busy');
  });

  it('every fixture parses', () => {
    expect(parseOrchestratorMessage(wire(job))).toEqual(job);
    expect(parseDaemonMessage(wire(result))).toEqual(result);
    for (const f of Object.values(ASSISTANT_WS_FIXTURES)) {
      const parse = f.type === 'assistant_job' ? parseOrchestratorMessage : parseDaemonMessage;
      expect(parse(wire(f))).toEqual(f);
    }
  });
});

describe('assistant_job', () => {
  it('is machine-level: no session, no seq', () => {
    expect(() =>
      parseOrchestratorMessage({ ...job, session_id: ASSISTANT_FIXTURE_IDS.job }),
    ).toThrow();
    expect(() => parseOrchestratorMessage({ ...job, seq: 1 })).toThrow();
  });

  it('caps the prompt, the transcript tail and the timeout', () => {
    const p = job.payload;
    const ok = (o: object) => AssistantJobPayloadSchema.safeParse({ ...p, ...o }).success;
    expect(ok({ prompt: 'x'.repeat(ASSISTANT_JOB_PROMPT_MAX) })).toBe(true);
    expect(ok({ prompt: 'x'.repeat(ASSISTANT_JOB_PROMPT_MAX + 1) })).toBe(false);
    expect(ok({ prompt: '' })).toBe(false);
    expect(ok({ timeout_ms: ASSISTANT_JOB_TIMEOUT_MAX_MS })).toBe(true);
    expect(ok({ timeout_ms: ASSISTANT_JOB_TIMEOUT_MAX_MS + 1 })).toBe(false);
    const t = (max_chars: number) => ({
      transcript: { session_id: p.transcript!.session_id, max_chars },
    });
    expect(ok(t(ASSISTANT_JOB_TRANSCRIPT_MAX_CHARS))).toBe(true);
    expect(ok(t(ASSISTANT_JOB_TRANSCRIPT_MAX_CHARS + 1))).toBe(false);
  });

  it('refuses an unknown kind and a non-object schema', () => {
    const p = job.payload;
    expect(AssistantJobPayloadSchema.safeParse({ ...p, kind: 'triage' }).success).toBe(false);
    expect(AssistantJobPayloadSchema.safeParse({ ...p, json_schema: [] }).success).toBe(false);
  });
});

describe('assistant_result', () => {
  it('is durable: seq required; machine-level', () => {
    expect(() => parseDaemonMessage({ ...result, seq: null })).toThrow();
    expect(() =>
      parseDaemonMessage({ ...result, session_id: ASSISTANT_FIXTURE_IDS.job }),
    ).toThrow();
  });

  it('carries a result or an error', () => {
    const base = {
      job_id: ASSISTANT_FIXTURE_IDS.job,
      command_id: ASSISTANT_FIXTURE_IDS.command,
      duration_ms: 1,
    };
    expect(AssistantResultPayloadSchema.safeParse({ ...base, result: {} }).success).toBe(true);
    expect(AssistantResultPayloadSchema.safeParse({ ...base, error: 'timeout' }).success).toBe(
      true,
    );
    expect(AssistantResultPayloadSchema.safeParse({ ...base, error: 'nope' }).success).toBe(false);
    expect(AssistantResultPayloadSchema.safeParse(base).success).toBe(false);
    expect(
      AssistantResultPayloadSchema.safeParse({
        ...base,
        error: 'malformed',
        detail: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe('register.features (additive)', () => {
  it('is optional, bounded, and names the assistant job feature', () => {
    const p = DAEMON_FIXTURES.register.payload;
    expect(RegisterPayloadSchema.safeParse(p).success).toBe(true);
    expect(ASSISTANT_WS_FIXTURES.register_with_features.payload.features).toEqual([
      DAEMON_FEATURE_ASSISTANT_JOB,
    ]);
    expect(RegisterPayloadSchema.safeParse({ ...p, features: Array(21).fill('a') }).success).toBe(
      false,
    );
    expect(RegisterPayloadSchema.safeParse({ ...p, features: ['x'.repeat(51)] }).success).toBe(
      false,
    );
  });
});
