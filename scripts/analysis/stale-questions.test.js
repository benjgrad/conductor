// @ts-check
import { describe, expect, it } from 'vitest';
import {
  autoProceedHolds,
  classify,
  classifyAll,
  closedByAnswer,
  extractRecommendation,
  originGroup,
  percentile,
  recommend,
  report,
  resolveOverrides,
  stats,
} from './stale-questions.js';

/** @typedef {import('./stale-questions.js').Row} Row */

/** @param {Partial<Row>} p @returns {Row} */
const row = (p) => ({
  id: '00000000-0000-4000-8000-000000000000',
  ticket_kind: 'personal',
  question: 'Should I?',
  options: null,
  answer: 'yes',
  return_to: 'implementing',
  wait_minutes: 10,
  origin_transition: 'ask_user',
  closing_transition: null,
  closing_from: 'needs_input',
  closing_to: 'implementing',
  ...p,
});

const OPTS = { items: [{ label: 'Push it' }, { label: 'Merge instead' }, { label: 'Leave it' }] };

describe('extractRecommendation', () => {
  it('takes the first option label', () => {
    expect(extractRecommendation('Push?', OPTS)).toBe('Push it');
    expect(extractRecommendation('Push?', [{ label: 'A' }, { label: 'B' }])).toBe('A');
  });
  it('treats a plan approval as recommending the plan', () => {
    expect(extractRecommendation('Approve?', null, 'plan_needs_approval')).toBe('approve the plan');
  });
  it('finds a lettered recommendation', () => {
    expect(extractRecommendation('Which? (A, recommended) Close it. (B) Rewrite.', null)).toBe(
      '(A)',
    );
    expect(
      extractRecommendation('How? My recommendation is (A).\n(A) Build. (B) Flag.', null),
    ).toBe('(A)');
  });
  it('finds a prose recommendation sentence', () => {
    expect(
      extractRecommendation('It is blocked. I recommend rebasing onto main. Or wait?', null),
    ).toBe('I recommend rebasing onto main.');
    expect(extractRecommendation('Recommended: wait for main. Or fix it here?', null)).toBe(
      'Recommended: wait for main.',
    );
  });
  it('is null without one', () => {
    expect(extractRecommendation('Can you paste the log?', null)).toBeNull();
    expect(extractRecommendation('I do not recommend this. Should I?', null)).toBeNull();
  });
});

describe('classify', () => {
  /** @type {[string, Partial<Row>, string | null, string][]} */
  const cases = [
    ['plain yes', { answer: 'Yes' }, 'I recommend X.', 'accepted'],
    ['ok with punctuation', { answer: 'ok!' }, null, 'accepted'],
    ['[answer] button', { answer: '[answer]' }, null, 'accepted'],
    ['first option label', { answer: 'Push it', options: OPTS }, 'Push it', 'accepted'],
    ['other option label', { answer: 'Leave it', options: OPTS }, 'Push it', 'rejected'],
    [
      'the plan button',
      { answer: 'Plan approved. Proceed: call complete_state …' },
      'approve the plan',
      'accepted',
    ],
    ['the recommended letter', { answer: 'A' }, '(A)', 'accepted'],
    ['another letter', { answer: 'b' }, '(A)', 'rejected'],
    ['go with another letter', { answer: 'Go with (b): add it' }, '(a)', 'rejected'],
    ['no, instead', { answer: 'No, do Y instead' }, 'I recommend X.', 'rejected'],
    [
      'yes but more',
      { answer: 'Yes, but also add the side-by-side screenshots to the PR writeup' },
      'I recommend X.',
      'modified',
    ],
    [
      'changes requested',
      { answer: 'Changes requested to the plan: spike first' },
      'approve the plan',
      'modified',
    ],
    ['try again', { answer: 'Try again, my computer was asleep for a bit.' }, null, 'accepted'],
    ['free text, no rec', { answer: 'Where can I see the screenshots?' }, null, 'unclear'],
    ['negation without a rec', { answer: "Don't touch web" }, null, 'unclear'],
    ['empty', { answer: '  ' }, null, 'unclear'],
  ];
  it.each(cases)('%s', (_name, p, rec, want) => {
    expect(classify(row(p), rec)).toBe(want);
  });
});

describe('closedByAnswer', () => {
  it('counts the named answer move and the answer box back to return_to', () => {
    expect(closedByAnswer(row({ closing_transition: 'answer', closing_to: 'planning' }))).toBe(
      true,
    );
    expect(closedByAnswer(row({ closing_transition: null }))).toBe(true);
  });
  it('does not count another human move', () => {
    expect(closedByAnswer(row({ closing_transition: 'fresh_conversation' }))).toBe(false);
    expect(closedByAnswer(row({ closing_transition: 'done', closing_to: 'done' }))).toBe(false);
    expect(closedByAnswer(row({ closing_transition: null, closing_to: 'done' }))).toBe(false);
  });
});

describe('originGroup', () => {
  it('groups by the opening move and engine texts', () => {
    expect(originGroup(row({ origin_transition: null }))).toBe('ask_user');
    expect(originGroup(row({ origin_transition: 'plan_needs_approval' }))).toBe('plan_approval');
    expect(originGroup(row({ origin_transition: 'scope_changed' }))).toBe('question_transition');
    expect(
      originGroup(
        row({ question: 'Agent stopped without reporting an outcome; last output attached' }),
      ),
    ).toBe('engine');
  });
});

describe('percentile', () => {
  it('is nearest-rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([3, 1], 50)).toBe(1);
    expect(percentile([3, 1], 90)).toBe(3);
    const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 100)).toBe(10);
  });
});

describe('recommend', () => {
  /** @param {number} n @param {number} acc @param {number} rej */
  const s = (n, acc, rej) => ({
    n,
    counts: { accepted: acc, modified: n - acc - rej, rejected: rej, unclear: 0 },
  });
  it('auto-proceeds at 80 % accepted and under 10 % rejected', () => {
    expect(autoProceedHolds(s(10, 8, 0))).toBe(true);
    expect(autoProceedHolds(s(10, 7, 0))).toBe(false);
    expect(autoProceedHolds(s(10, 9, 1))).toBe(false); // 10 % rejected is not under 10 %
    expect(autoProceedHolds(s(4, 4, 0))).toBe(false); // too few
    expect(recommend({ all: s(10, 9, 0), personal: s(5, 5, 0), work: s(5, 4, 0) })).toBe(
      'auto-proceed',
    );
  });
  it('limits it to personal tickets when only they hold', () => {
    expect(recommend({ all: s(20, 14, 3), personal: s(10, 9, 0), work: s(10, 5, 3) })).toMatch(
      /personal$/,
    );
  });
  it('escalates otherwise', () => {
    expect(recommend({ all: s(17, 9, 7), personal: s(10, 4, 5), work: s(7, 5, 2) })).toBe(
      'escalate',
    );
  });
});

describe('overrides', () => {
  const rows = [
    row({ id: 'aaaaaaaa-0000-4000-8000-000000000001', answer: 'Where are they?' }),
    row({ id: 'bbbbbbbb-0000-4000-8000-000000000002', answer: 'yes' }),
    row({ id: 'cccccccc-0000-4000-8000-000000000003', closing_transition: 'fresh_conversation' }),
    row({ id: 'dddddddd-0000-4000-8000-000000000004', origin_transition: 'pr_ready_for_review' }),
  ];
  it('replace the heuristic class and flags, by id prefix', () => {
    const o = resolveOverrides(rows, {
      _about: 'ignored',
      aaaaaaaa: { class: 'modified', has_rec: true, needs_human: true, note: 'asked for a PR' },
    });
    const items = classifyAll(rows, o);
    expect(items.map((i) => i.row.id.slice(0, 8))).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(items[0]).toMatchObject({
      cls: 'modified',
      heuristic: 'unclear',
      hasRec: true,
      needsHuman: true,
    });
    expect(items[1]).toMatchObject({ cls: 'accepted', heuristic: 'accepted', needsHuman: false });
    expect(stats(items).counts).toEqual({ accepted: 1, modified: 1, rejected: 0, unclear: 0 });
  });
  it('refuse an ambiguous, unknown or short key, and an unknown class', () => {
    expect(() => resolveOverrides(rows, { zzzzzzzz: {} })).toThrow(/matches 0/);
    expect(() => resolveOverrides(rows, { aaaa: {} })).toThrow(/prefix/);
    expect(() =>
      resolveOverrides(rows, { aaaaaaaa: { class: /** @type {any} */ ('maybe') } }),
    ).toThrow(/unknown class/);
  });
});

describe('report', () => {
  it('prints the class table, the recommendation line and the rejected rows', () => {
    const rows = [
      row({ id: 'aaaaaaaa-1', answer: 'No, do Y instead', question: 'I recommend X. OK?' }),
      row({ id: 'bbbbbbbb-2', answer: 'yes', question: 'I recommend X. OK?', ticket_kind: null }),
    ];
    const md = report(classifyAll(rows), { rows: true, excluded: 3 });
    expect(md).toContain('2 agent questions closed by `answer` (3 more');
    expect(md).toContain('| rejected | 1 | 50 % |');
    expect(md).toContain('**Recommendation: escalate**');
    expect(md).toContain('`aaaaaaaa` (personal, ask_user, 10 min)');
    expect(md).toContain('| bbbbbbbb | work |');
  });
});
