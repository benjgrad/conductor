import { describe, expect, it } from 'vitest';
import {
  M2R_EVENT_FIXTURES,
  MERGE_STEP_FIXTURE,
  MOVE_STEP_FIXTURE,
  PR_CONTEXT_FIXTURE,
  PR_CONTEXT_MERGED_FIXTURE,
  QA_CONTEXT_FIXTURE,
  QA_RESULT_FIXTURES,
  SNAPSHOT_V2_CONDITIONS_FIXTURE,
} from './fixtures.js';
import {
  PrContextSchema,
  QA_CONTEXT_KEY,
  QA_LIMITS,
  QA_VERDICTS,
  QaContextSchema,
  QaResultSchema,
} from './qa.types.js';
import { APPLY_IGNORE_REASONS, EffectSchema, EngineEventSchema, GateStepSchema } from './types.js';

// M2r-T01 (ADR-0020 §2, §5, §7): QA result and context, PR context, engine event / step / effect
// additions. The engine behaviour is M2r-T03 / T04.

const pass = QA_RESULT_FIXTURES.pass;
const refused = (v: unknown) => expect(QaResultSchema.safeParse(v).success).toBe(false);

describe('QaResult', () => {
  it('every fixture parses unchanged; verdicts are fixed', () => {
    for (const r of Object.values(QA_RESULT_FIXTURES)) expect(QaResultSchema.parse(r)).toEqual(r);
    expect(QA_VERDICTS).toEqual(['pass', 'pass_with_debt', 'fail']);
    refused({ ...pass, verdict: 'ok' });
  });

  it('lists default to [] and requirements stay optional', () => {
    const r = QaResultSchema.parse({ verdict: 'pass', summary: 'Fine.' });
    expect(r).toEqual({
      verdict: 'pass',
      findings: [],
      required_fixes: [],
      debt: [],
      unknowns: [],
      tests_run: [],
      summary: 'Fine.',
    });
  });

  it('caps every list at its limit', () => {
    const finding = { severity: 'nit', text: 'x' };
    const lists: [string, unknown, number][] = [
      ['requirements', { req: 'FR-1', met: true, reason: '' }, QA_LIMITS.requirements],
      ['findings', finding, QA_LIMITS.findings],
      ['required_fixes', 'fix', QA_LIMITS.required_fixes],
      ['debt', { text: 'td' }, QA_LIMITS.debt],
      ['unknowns', { question: 'q', why: 'w' }, QA_LIMITS.unknowns],
      ['tests_run', { cmd: 'pnpm test', result: 'pass' }, QA_LIMITS.tests_run],
    ];
    for (const [key, item, max] of lists) {
      expect(QaResultSchema.safeParse({ ...pass, [key]: Array(max).fill(item) }).success).toBe(
        true,
      );
      refused({ ...pass, [key]: Array(max + 1).fill(item) });
    }
  });

  it('caps every text field', () => {
    const long = 'x'.repeat(QA_LIMITS.text + 1);
    const ok = 'x'.repeat(QA_LIMITS.text);
    expect(QaResultSchema.safeParse({ ...pass, required_fixes: [ok] }).success).toBe(true);
    refused({ ...pass, required_fixes: [long] });
    refused({ ...pass, findings: [{ severity: 'major', text: long }] });
    refused({ ...pass, requirements: [{ req: 'FR-1', met: false, reason: long }] });
    refused({ ...pass, requirements: [{ req: 'x'.repeat(41), met: false, reason: '' }] });
    refused({ ...pass, debt: [{ text: long }] });
    refused({ ...pass, debt: [{ text: 't', payoff: long }] });
    refused({ ...pass, unknowns: [{ question: long, why: 'w' }] });
    refused({ ...pass, tests_run: [{ cmd: long, result: 'pass' }] });
    refused({ ...pass, tests_run: [{ cmd: 'c', result: 'skipped' }] });
    refused({ ...pass, findings: [{ severity: 'critical', text: 't' }] });
    expect(
      QaResultSchema.safeParse({ ...pass, summary: 'x'.repeat(QA_LIMITS.summary) }).success,
    ).toBe(true);
    refused({ ...pass, summary: 'x'.repeat(QA_LIMITS.summary + 1) });
    refused({ ...pass, summary: '' });
  });
});

describe('QaContext and PrContext', () => {
  it('the fixtures parse; the key is __qa', () => {
    expect(QA_CONTEXT_KEY).toBe('__qa');
    expect(QaContextSchema.parse(QA_CONTEXT_FIXTURE)).toEqual(QA_CONTEXT_FIXTURE);
    expect(PrContextSchema.parse(PR_CONTEXT_FIXTURE)).toEqual(PR_CONTEXT_FIXTURE);
    expect(PrContextSchema.parse(PR_CONTEXT_MERGED_FIXTURE)).toEqual(PR_CONTEXT_MERGED_FIXTURE);
  });

  it('refuses a short sha, round 0 or a round past max_rounds', () => {
    const q = QA_CONTEXT_FIXTURE;
    expect(QaContextSchema.safeParse({ ...q, head_sha: 'abc123' }).success).toBe(false);
    expect(QaContextSchema.safeParse({ ...q, round: 0 }).success).toBe(false);
    expect(QaContextSchema.safeParse({ ...q, round: 5, max_rounds: 4 }).success).toBe(false);
  });

  it('an M1b __pr still parses', () => {
    expect(PrContextSchema.safeParse(SNAPSHOT_V2_CONDITIONS_FIXTURE.context.__pr).success).toBe(
      true,
    );
  });
});

describe('engine additions', () => {
  it('human.transition carries approvals, absent ≡ none', () => {
    for (const ev of Object.values(M2R_EVENT_FIXTURES)) {
      expect(EngineEventSchema.parse(ev)).toEqual(ev);
    }
    expect(
      EngineEventSchema.safeParse({ ...M2R_EVENT_FIXTURES.human_merge, approvals: ['Migration'] })
        .success,
    ).toBe(false);
    expect(
      EngineEventSchema.safeParse({
        ...M2R_EVENT_FIXTURES.human_merge,
        approvals: ['a', 'b', 'c', 'd', 'e', 'f'],
      }).success,
    ).toBe(false);
  });

  it('approval_required and pr_open are ignore reasons', () => {
    expect(APPLY_IGNORE_REASONS).toContain('approval_required');
    expect(APPLY_IGNORE_REASONS).toContain('pr_open');
  });

  it('GateStep: an older step parses with approvals null; one with approvals parses', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { approvals: _a, ...old } = MOVE_STEP_FIXTURE;
    expect(GateStepSchema.parse(old).approvals).toBeNull();
    expect(GateStepSchema.parse(MERGE_STEP_FIXTURE)).toEqual(MERGE_STEP_FIXTURE);
    expect(
      GateStepSchema.safeParse({
        ...MERGE_STEP_FIXTURE,
        approvals: { who: 'ui', ids: ['Bad Id'], files: {} },
      }).success,
    ).toBe(false);
  });

  it('the start_session effect takes an optional checkout', () => {
    const start = {
      type: 'start_session',
      state: 'in_qa',
      prompt: 'QA',
      tools: ['qa'],
      resume_claude_session_id: null,
      review: true,
    };
    expect(EffectSchema.safeParse(start).success).toBe(true);
    const checkout = {
      sha: QA_CONTEXT_FIXTURE.head_sha,
      pr_url: PR_CONTEXT_FIXTURE.pr_url,
      setup: null,
    };
    expect(EffectSchema.parse({ ...start, checkout })).toMatchObject({ checkout });
    expect(
      EffectSchema.safeParse({ ...start, checkout: { ...checkout, pr_url: 'https://x.test/1' } })
        .success,
    ).toBe(false);
  });
});
