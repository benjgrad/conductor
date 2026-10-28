import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REQUIRED_ERROR_FIXTURE,
  BOARD_CARD_ALERT_FIXTURE,
  BOARD_CARD_FIXTURE,
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  BOARD_CARD_PENDING_FIXTURE,
  BOARD_CARD_ROUTING_FIXTURE,
  M2R_CARD_FIXTURES,
  M2R_TRANSITION_REQUEST_FIXTURES,
  SESSION_QA_FIXTURE,
  TRANSITION_REQUEST_FIXTURES,
} from '../api/fixtures.js';
import {
  ApiErrorSchema,
  BoardCardSchema,
  httpForApplyResult,
  SessionDetailSchema,
  TransitionSessionRequestSchema,
} from '../api/rest.js';
import { CardBadgeSchema } from '../domain.js';
import {
  ClosePrArgsSchema,
  ClosePrResultSchema,
  InspectPrArgsSchema,
  InspectPrResultSchema,
  MergePrArgsSchema,
  MergePrResultSchema,
  OpenPrResultSchema,
  PR_FILES_MAX,
} from './actions.js';
import {
  M1B_WS_FIXTURES,
  M2R_ACTION_FIXTURES,
  M2R_HEAD_SHA,
  M2R_WS_FIXTURES,
  ORCHESTRATOR_FIXTURES,
} from './fixtures.js';
import { parseDaemonMessage, parseOrchestratorMessage, RunActionPayloadSchema } from './ws.js';

// M2r-T01 (ADR-0020 §4, §5, §7): action args / results, the WS additions, and the REST / card
// contracts. Daemon behaviour is M2r-T05 / T06; the routes are M2r-T08.

const A = M2R_ACTION_FIXTURES;

describe('action args and results', () => {
  it('every fixture parses unchanged with its schema', () => {
    const pairs: [{ parse: (v: unknown) => unknown }, unknown][] = [
      [OpenPrResultSchema, A.open_pr_result],
      [OpenPrResultSchema, A.open_pr_result_m1],
      [InspectPrArgsSchema, A.inspect_pr_args],
      [InspectPrResultSchema, A.inspect_pr_result],
      [InspectPrResultSchema, A.inspect_pr_result_truncated],
      [MergePrArgsSchema, A.merge_pr_args],
      [MergePrResultSchema, A.merge_pr_merged],
      [MergePrResultSchema, A.merge_pr_already],
      [MergePrResultSchema, A.merge_pr_head_moved],
      [MergePrResultSchema, A.merge_pr_conflict],
      [MergePrResultSchema, A.merge_pr_approval_missing],
      [MergePrResultSchema, A.merge_pr_blocked],
      [ClosePrArgsSchema, A.close_pr_args],
      [ClosePrArgsSchema, A.close_pr_args_no_pr],
      [ClosePrResultSchema, A.close_pr_result],
      [ClosePrResultSchema, A.close_pr_result_merged],
    ];
    for (const [schema, fixture] of pairs) expect(schema.parse(fixture)).toEqual(fixture);
  });

  it('open_pr head_sha is optional (old daemons) but must be a full sha', () => {
    expect(OpenPrResultSchema.parse({ pr_url: A.open_pr_result.pr_url })).not.toHaveProperty(
      'head_sha',
    );
    expect(OpenPrResultSchema.safeParse({ ...A.open_pr_result, head_sha: 'abc' }).success).toBe(
      false,
    );
    expect(
      OpenPrResultSchema.safeParse({ pr_url: 'https://gitlab.com/a/b/-/merge_requests/1' }).success,
    ).toBe(false);
  });

  it('inspect_pr: 300 files pass, 301 are refused; mergeable and state are gh enums', () => {
    expect(A.inspect_pr_result_truncated.files).toHaveLength(PR_FILES_MAX);
    const r = A.inspect_pr_result;
    const files = Array.from({ length: PR_FILES_MAX + 1 }, (_, i) => `f${i}`);
    expect(InspectPrResultSchema.safeParse({ ...r, files }).success).toBe(false);
    expect(InspectPrResultSchema.safeParse({ ...r, matched: { migration: files } }).success).toBe(
      false,
    );
    expect(InspectPrResultSchema.safeParse({ ...r, mergeable: 'CLEAN' }).success).toBe(false);
    expect(InspectPrResultSchema.safeParse({ ...r, state: 'DRAFT' }).success).toBe(false);
    expect(InspectPrResultSchema.safeParse({ ...r, matched: { Bad: [] } }).success).toBe(false);
    const six = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, ['x/**']]));
    expect(
      InspectPrArgsSchema.safeParse({ ...A.inspect_pr_args, approval_paths: six }).success,
    ).toBe(false);
  });

  it('merge_pr: method merge only, pinned to a full sha', () => {
    expect(MergePrArgsSchema.safeParse({ ...A.merge_pr_args, method: 'squash' }).success).toBe(
      false,
    );
    expect(MergePrArgsSchema.safeParse({ ...A.merge_pr_args, expected_sha: 'HEAD' }).success).toBe(
      false,
    );
  });

  it('merge_pr result: a failure is unmet or error, never both; reasons are fixed', () => {
    expect(
      MergePrResultSchema.safeParse({ ...A.merge_pr_head_moved, error: 'blocked' }).success,
    ).toBe(false);
    expect(MergePrResultSchema.safeParse({ ok: false, unmet: 'closed', detail: '' }).success).toBe(
      false,
    );
    expect(
      MergePrResultSchema.safeParse({ ok: false, error: 'conflict', detail: '' }).success,
    ).toBe(false);
    expect(MergePrResultSchema.safeParse({ ok: false, detail: '' }).success).toBe(false);
    expect(
      MergePrResultSchema.safeParse({ ...A.merge_pr_conflict, detail: 'x'.repeat(2_001) }).success,
    ).toBe(false);
    expect(MergePrResultSchema.safeParse({ ...A.merge_pr_merged, merged: false }).success).toBe(
      false,
    );
  });

  it('close_pr: a reason is required and capped', () => {
    expect(ClosePrArgsSchema.safeParse({ pr_url: null, reason: ' ' }).success).toBe(false);
    expect(ClosePrArgsSchema.safeParse({ pr_url: null, reason: 'x'.repeat(20_001) }).success).toBe(
      false,
    );
  });
});

describe('WS additions', () => {
  it('the M2r envelopes round-trip', () => {
    for (const [name, m] of Object.entries(M2R_WS_FIXTURES)) {
      const parse = m.type === 'session_event' ? parseDaemonMessage : parseOrchestratorMessage;
      expect(parse(JSON.stringify(m)), name).toEqual(m);
    }
  });

  it('run_action accepts the three actions; their args parse with the action schemas', () => {
    expect(RunActionPayloadSchema.shape.action.options).toEqual([
      'open_pr',
      'evaluate_conditions',
      'inspect_pr',
      'merge_pr',
      'close_pr',
    ]);
    expect(InspectPrArgsSchema.parse(M2R_WS_FIXTURES.run_action_inspect_pr.payload.args)).toEqual(
      A.inspect_pr_args,
    );
    expect(MergePrArgsSchema.parse(M2R_WS_FIXTURES.run_action_merge_pr.payload.args)).toEqual(
      A.merge_pr_args,
    );
    expect(ClosePrArgsSchema.parse(M2R_WS_FIXTURES.run_action_close_pr.payload.args)).toEqual(
      A.close_pr_args,
    );
  });

  it('start_session.checkout needs a full sha and a GitHub PR URL', () => {
    const m = M2R_WS_FIXTURES.start_session_qa_checkout;
    const withCheckout = (checkout: unknown) => ({ ...m, payload: { ...m.payload, checkout } });
    expect(
      parseOrchestratorMessage(withCheckout({ ...m.payload.checkout, setup: null })),
    ).toBeTruthy();
    expect(() =>
      parseOrchestratorMessage(withCheckout({ ...m.payload.checkout, sha: 'main' })),
    ).toThrow();
    expect(() =>
      parseOrchestratorMessage(withCheckout({ sha: M2R_HEAD_SHA, setup: null })),
    ).toThrow();
  });

  it('pre-M2r messages still parse (NFR-1)', () => {
    for (const m of [
      ORCHESTRATOR_FIXTURES.start_session,
      ORCHESTRATOR_FIXTURES.run_action,
      M1B_WS_FIXTURES.run_action_evaluate_conditions,
      M1B_WS_FIXTURES.start_session_transitions,
    ]) {
      expect(parseOrchestratorMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
    }
  });
});

describe('REST and card additions', () => {
  it('the M2r cards parse unchanged; badges gain merged and closed_unmerged', () => {
    for (const c of Object.values(M2R_CARD_FIXTURES)) expect(BoardCardSchema.parse(c)).toEqual(c);
    expect(CardBadgeSchema.options).toEqual(expect.arrayContaining(['merged', 'closed_unmerged']));
  });

  it('pre-M2r cards still parse unchanged (NFR-1)', () => {
    for (const c of [
      BOARD_CARD_FIXTURE,
      BOARD_CARD_PENDING_FIXTURE,
      BOARD_CARD_NEEDS_INPUT_FIXTURE,
      BOARD_CARD_ROUTING_FIXTURE,
      BOARD_CARD_ALERT_FIXTURE,
    ]) {
      const parsed = BoardCardSchema.parse(c);
      expect(parsed).toEqual(c);
      expect(parsed).not.toHaveProperty('qa');
      expect(parsed).not.toHaveProperty('pr');
    }
  });

  it('card qa / pr and button approvals / text are checked', () => {
    const card = M2R_CARD_FIXTURES.ready_to_merge;
    expect(
      BoardCardSchema.safeParse({ ...card, qa: { verdict: 'ok', round: 1, max_rounds: 4 } })
        .success,
    ).toBe(false);
    expect(
      BoardCardSchema.safeParse({ ...card, pr: { url: 'x', merged: false, closed: false } })
        .success,
    ).toBe(false);
    const [merge] = card.human_transitions;
    const bad = { ...merge!, approvals: [{ id: 'migration', label: 'x'.repeat(61), files: [] }] };
    expect(BoardCardSchema.safeParse({ ...card, human_transitions: [bad] }).success).toBe(false);
    expect(
      BoardCardSchema.safeParse({ ...card, human_transitions: [{ ...merge!, text: 'maybe' }] })
        .success,
    ).toBe(false);
  });

  it('transition requests carry approvals, at most 5 slugs', () => {
    for (const r of [
      ...Object.values(M2R_TRANSITION_REQUEST_FIXTURES),
      ...Object.values(TRANSITION_REQUEST_FIXTURES),
    ]) {
      expect(TransitionSessionRequestSchema.parse(r)).toEqual(r);
    }
    expect(
      TransitionSessionRequestSchema.safeParse({
        name: 'merge',
        approvals: ['a', 'b', 'c', 'd', 'e', 'f'],
      }).success,
    ).toBe(false);
    expect(
      TransitionSessionRequestSchema.safeParse({ name: 'merge', approvals: ['Not a slug'] })
        .success,
    ).toBe(false);
  });

  it('409 approval_required carries the approvals; pr_open is a 409 too', () => {
    expect(ApiErrorSchema.parse(APPROVAL_REQUIRED_ERROR_FIXTURE)).toEqual(
      APPROVAL_REQUIRED_ERROR_FIXTURE,
    );
    expect(
      httpForApplyResult('transition', { status: 'ignored', reason: 'approval_required' }),
    ).toEqual({ status: 409, code: 'approval_required' });
    expect(httpForApplyResult('transition', { status: 'ignored', reason: 'pr_open' })).toEqual({
      status: 409,
      code: 'pr_open',
    });
    expect(httpForApplyResult('transition', { status: 'ignored', reason: 'wrong_status' })).toEqual(
      {
        status: 409,
        code: 'conflict',
      },
    );
  });

  it('SessionDetail.qa is optional and nullable', () => {
    const qa = SessionDetailSchema.shape.qa;
    expect(qa.parse(SESSION_QA_FIXTURE)).toEqual(SESSION_QA_FIXTURE);
    expect(qa.parse(null)).toBeNull();
    expect(qa.parse(undefined)).toBeUndefined();
    expect(qa.safeParse({ ...SESSION_QA_FIXTURE, head_sha: 'abc' }).success).toBe(false);
  });
});
