import { describe, expect, it } from 'vitest';
import {
  classifyRequest,
  formatSummary,
  lastMoveTransition,
  PREVIEW_MAX,
  previewText,
  summarizeReport,
} from './request-preview.js';
import { implementerReport, REPORT_FIRST_LINE } from './review-fixture.js';

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
    expect(p.startsWith(REPORT_FIRST_LINE)).toBe(true);
    expect(p).not.toMatch(/TASK:|BRANCH:|STATUS:/);
    expect(p.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(p.split(' · ')).toHaveLength(3);
  });

  it('a question shows its first sentence', () => {
    expect(
      previewText('Should I use pg or sqlite? The tradeoffs are below.\n\n- pg: …', 'question'),
    ).toBe('Should I use pg or sqlite?');
    expect(previewText('## Decision needed\nPick one.', 'question')).toBe('Decision needed');
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
  it('status, acceptance 8/10 and green gates', () => {
    const s = summarizeReport(implementerReport())!;
    expect(s).toEqual({ status: 'complete', accepted: 8, total: 10, gates: 'ok' });
    expect(formatSummary(s)).toBe('complete · Acceptance 8/10, gates ✓');
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
