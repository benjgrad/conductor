import { describe, expect, it } from 'vitest';
import {
  classifyRequest,
  formatSummary,
  lastMoveTransition,
  PLAN_APPROVED_TEXT,
  planAnswerOption,
  planChangesText,
  PREVIEW_MAX,
  previewText,
  summarizeReport,
} from './request-preview.js';
import { implementerReport, REPORT_PROSE_LINE } from './review-fixture.js';

const req = (over: Partial<Parameters<typeof classifyRequest>[0]> = {}) => ({
  kind: 'agent_question' as const,
  question: 'Which DB?',
  ...over,
});

describe('classifyRequest (FR-2, FR-3)', () => {
  it('a *ready_for_review origin is a review request', () => {
    expect(classifyRequest(req({ origin_transition: 'personal_pr_ready_for_review' }))).toBe(
      'review',
    );
    expect(classifyRequest(req({ origin_transition: 'pr_ready_for_review' }))).toBe('review');
  });

  it('a plan_needs_approval origin is a plan to approve (06 §Plan approval)', () => {
    expect(classifyRequest(req({ origin_transition: 'plan_needs_approval' }))).toBe(
      'plan_approval',
    );
    expect(classifyRequest(req(), 'plan_needs_approval')).toBe('plan_approval');
    expect(classifyRequest(req({ origin_transition: null }), 'plan_needs_approval')).toBe(
      'question',
    );
    expect(classifyRequest(req({ origin_transition: 'needs_product_context' }))).toBe('question');
  });

  it('other transitions and ask_user stay questions', () => {
    expect(classifyRequest(req({ origin_transition: 'scope_changed' }))).toBe('question');
    expect(classifyRequest(req({ origin_transition: null, step_failed: false }))).toBe('question');
    expect(classifyRequest(req())).toBe('question');
  });

  it('step_failed from the server, or from the question text on older servers', () => {
    expect(
      classifyRequest(
        req({ kind: 'retries_exhausted', origin_transition: null, step_failed: true }),
      ),
    ).toBe('step_failed');
    const q =
      'Conductor could not PR opened to enter "Needs input": gh: 422. Retry, skip, or abort?';
    expect(classifyRequest(req({ kind: 'retries_exhausted', question: q }))).toBe('step_failed');
    expect(classifyRequest(req({ kind: 'timeout', question: q }))).toBe('step_failed');
    // The server said no: trust it over the text.
    expect(
      classifyRequest(req({ kind: 'retries_exhausted', question: q, step_failed: false })),
    ).toBe('question');
    expect(classifyRequest(req({ kind: 'agent_question', question: q }))).toBe('question');
  });

  it('falls back to the last move only when the server sent no origin', () => {
    expect(classifyRequest(req(), 'pr_ready_for_review')).toBe('review');
    expect(classifyRequest(req({ origin_transition: null }), 'pr_ready_for_review')).toBe(
      'question',
    );
  });

  it('lastMoveTransition: the last move into the current state', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const move = (to: string, transition: string | null) => ({
      at,
      from: 'x',
      to,
      transition,
      reason: null,
      actor: null,
    });
    const card = { workflow_state: 'needs_input' } as Parameters<
      typeof lastMoveTransition
    >[0]['card'];
    expect(
      lastMoveTransition({
        card,
        moves: [
          move('needs_input', 'a'),
          move('needs_input', 'pr_ready_for_review'),
          move('x', 'b'),
        ],
      }),
    ).toBe('pr_ready_for_review');
    expect(lastMoveTransition({ card })).toBeNull();
  });
});

describe('previewText (FR-1, FR-3)', () => {
  it('a 60-line report: starts after the TASK/BRANCH/STATUS header, bounded', () => {
    const p = previewText(implementerReport(60), 'review');
    // Real reports go from the header straight into ACCEPTANCE: the summary leads, then prose.
    expect(p).toBe(`complete · Acceptance 8/10, gates ✓ · 1 for review · ${REPORT_PROSE_LINE}`);
    expect(p).not.toMatch(/^ACCEPTANCE|TASK:|BRANCH:|STATUS:|evidence/);
    expect(p.length).toBeLessThanOrEqual(PREVIEW_MAX);
  });

  it('a review without a parsable report: its first prose lines, labels skipped', () => {
    expect(
      previewText('TASK: x\nSUMMARY:\nThe PR adds pagination.\nPlease review.', 'review'),
    ).toBe('The PR adds pagination. · Please review.');
  });

  it('a question shows its first sentence', () => {
    expect(
      previewText('Should I use pg or sqlite? The tradeoffs are below.\n\n- pg: …', 'question'),
    ).toBe('Should I use pg or sqlite?');
    // A heading is a title, not the question.
    expect(previewText('## Question\nPick one of them.', 'question')).toBe('Pick one of them.');
    expect(previewText('QUESTION:\nWhich port?', 'question')).toBe('Which port?');
    // An abbreviation's dot doesn't end the sentence.
    expect(previewText('Use a queue, e.g. pg-boss, or cron? I lean queue.', 'question')).toBe(
      'Use a queue, e.g. pg-boss, or cron?',
    );
    expect(previewText('Pick one, i.e. A or B.', 'question')).toBe('Pick one, i.e. A or B.');
  });

  it('a failed step shows its first line', () => {
    expect(
      previewText(
        'Conductor could not PR opened to enter "Needs input": gh: 422.\nmore\n\nRetry?',
        'step_failed',
      ),
    ).toBe('Conductor could not PR opened to enter "Needs input": gh: 422.');
  });

  it('caps a 5,000-character line with an ellipsis', () => {
    const p = previewText('x'.repeat(5000), 'question');
    expect(p.length).toBe(PREVIEW_MAX);
    expect(p.endsWith('…')).toBe(true);
  });
});

describe('summarizeReport (FR-4)', () => {
  it('status, acceptance 8/10, green gates, the lead-owned [-] item apart', () => {
    const s = summarizeReport(implementerReport())!;
    expect(s).toEqual({ status: 'complete', accepted: 8, total: 10, forReview: 1, gates: 'ok' });
    expect(formatSummary(s)).toBe('complete · Acceptance 8/10, gates ✓ · 1 for review');
  });

  it('[-] items are not unmet: 4/4 ✓ with 2 for review', () => {
    const s = summarizeReport(
      'ACCEPTANCE:\n- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [-] e (lead)\n- [-] f (Ben)\nGATES: ✅',
    )!;
    expect(formatSummary(s)).toBe('Acceptance 4/4 ✓, gates ✓ · 2 for review');
  });

  it('a red gate, all met, and checkboxes without an ACCEPTANCE header', () => {
    const s = summarizeReport('- [x] a\n- [X] b\nGATES: typecheck ✅ lint ❌')!;
    expect(s).toEqual({ accepted: 2, total: 2, gates: 'failed' });
    expect(formatSummary(s)).toBe('Acceptance 2/2 ✓, gates ✗');
  });

  it('null for plain text', () => {
    expect(summarizeReport('Done, please review.')).toBeNull();
  });
});

describe('planAnswerOption (06 §Plan approval)', () => {
  const answer = {
    name: 'answer',
    title: 'Back with this answer',
    goto: 'planning',
    needs_text: true,
  };
  const wait = {
    name: 'waiting_on_someone',
    title: 'Waiting on someone else',
    goto: 'waiting_external',
    needs_text: true,
  };
  const done = { name: 'done', title: 'Done', goto: 'done', needs_text: false };
  const options = [answer, wait, done];

  it('the needs_text option into return_to', () => {
    expect(planAnswerOption(options, 'planning')).toBe(answer);
    expect(planAnswerOption(options, 'implementing')).toBeNull();
    expect(planAnswerOption(options, null)).toBeNull();
    expect(planAnswerOption([{ ...answer, needs_text: false }], 'planning')).toBeNull();
  });

  it('the board: the one needs_text option into an agent column, else null', () => {
    expect(planAnswerOption(options, new Set(['planning', 'implementing']))).toBe(answer);
    expect(planAnswerOption(options, new Set(['planning', 'waiting_external']))).toBeNull();
    expect(planAnswerOption([wait, done], new Set(['planning']))).toBeNull();
  });

  it('the texts it posts', () => {
    expect(PLAN_APPROVED_TEXT).toBe(
      'Plan approved. Proceed: call complete_state with plan_ready and this plan.',
    );
    expect(planChangesText('  Split step 2.  ')).toBe(
      'Changes requested to the plan:\n\nSplit step 2.',
    );
  });
});
