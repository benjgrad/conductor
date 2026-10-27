// UX-7: the STAR model of the Details tab (star.ts).
import type { MoveDto, SessionDetail, SessionInputRequest } from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { mockChecking, SEED_IDS } from '../api/mock-data.js';
import { parseBrief } from '../brief/parse.js';
import { firstParagraph, result, situation, timeline } from './star.js';

const AGENT = 'Ada';
let review: SessionDetail;
let running: SessionDetail;

beforeAll(async () => {
  const api = createMockApi({ replyDelayMs: 0 });
  review = await api.getSession(SEED_IDS.review.session);
  running = await api.getSession(SEED_IDS.running.session);
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min)).toISOString();

/** start → plan_ready → ask_user → answered → personal_pr_ready_for_review (conductor v2). */
const MOVES: MoveDto[] = [
  { at: at(0), from: null, to: 'planning', transition: null, reason: null, actor: null },
  {
    at: at(5),
    from: 'planning',
    to: 'implementing',
    transition: 'plan_ready',
    reason: 'Plan is complete.',
    actor: 'agent',
  },
  {
    at: at(10),
    from: 'implementing',
    to: 'needs_input',
    transition: 'ask_user',
    reason: 'Offset or cursor pagination?\nCursor is safer.',
    actor: 'agent',
  },
  {
    at: at(12),
    from: 'needs_input',
    to: 'implementing',
    transition: null,
    reason: null,
    actor: null,
  },
  {
    at: at(30),
    from: 'implementing → needs_input (move: personal_pr_ready_for_review)',
    to: 'needs_input',
    transition: 'personal_pr_ready_for_review',
    reason: 'STATUS: complete\nACCEPTANCE:\n- [x] a\n- [x] b\nGATES: typecheck ✅',
    actor: 'agent',
  },
];

const ANSWERED: SessionInputRequest = {
  id: 'c3000000-0000-4000-8000-0000000000f1',
  kind: 'agent_question',
  question: 'Offset or cursor pagination?',
  created_at: at(10),
  answer: 'Cursor.\nKeep the page size at 50.',
  answered_at: at(12),
  truncated: false,
};

describe('timeline (FR-3)', () => {
  it('tells the moves in order, in plain words, with the matched answer', () => {
    const detail: SessionDetail = {
      ...review,
      moves: MOVES,
      input_requests: [ANSWERED],
      pending_input: null,
      context: { planning: { plan: 'Step 1\nStep 2\nStep 3\nStep 4', summary: 's' } },
    };
    const entries = timeline(detail, AGENT);
    expect(entries.map((e) => [e.kind, e.label])).toEqual([
      ['start', 'Started in Planning'],
      ['plan', 'Plan ready'],
      ['question', 'Ada asked'],
      ['answer', 'You answered'],
      ['review', 'Ready for review'],
    ]);
    expect(entries[1]!.reason).toBe('Plan is complete.');
    expect(entries[1]!.detail).toBe('Step 1\nStep 2\nStep 3\nStep 4');
    expect(entries[2]!.reason).toBe('Offset or cursor pagination?\nCursor is safer.');
    expect(entries[3]!.reason).toBe('Cursor.\nKeep the page size at 50.');
  });

  it('an answer with no input_requests (older server) has no text', () => {
    const detail = { ...review, moves: MOVES, pending_input: null };
    delete detail.input_requests;
    const answer = timeline(detail, AGENT).find((e) => e.kind === 'answer')!;
    expect(answer.label).toBe('You answered');
    expect(answer.reason).toBeNull();
  });

  it('flags a clipped answer', () => {
    const detail = {
      ...review,
      moves: MOVES,
      pending_input: null,
      input_requests: [{ ...ANSWERED, truncated: true }],
    };
    expect(timeline(detail, AGENT).find((e) => e.kind === 'answer')!.truncated).toBe(true);
  });

  it('a step that passed is a check; a plain move names its transition and target', () => {
    const detail: SessionDetail = {
      ...review,
      pending_input: null,
      moves: [
        {
          at: at(1),
          from: 'implementing → done (move: merged)',
          to: 'done',
          transition: null,
          reason: null,
          actor: null,
        },
        {
          at: at(2),
          from: 'planning',
          to: 'implementing',
          transition: 'scope_ok',
          reason: null,
          actor: 'agent',
        },
      ],
    };
    const [check, move] = timeline(detail, AGENT);
    expect(check).toMatchObject({ kind: 'check', label: 'Checks before Done passed' });
    expect(move).toMatchObject({ kind: 'move', label: 'Scope ok → Implementing' });
  });

  it('ends with what is happening now: the running check, an open question', () => {
    const checking = {
      ...review,
      pending_input: null,
      moves: [],
      card: { ...review.card, checking: mockChecking(2) },
    };
    expect(timeline(checking, AGENT).at(-1)).toMatchObject({
      kind: 'live',
      label: 'Conductor is checking: Checks before PR ready for review',
    });
    // The seeded review request has no move here, so it shows as the live tail.
    expect(timeline({ ...review, moves: [] }, AGENT).at(-1)).toMatchObject({
      kind: 'live',
      label: 'Ready for review',
    });
  });
});

describe('result (FR-4)', () => {
  it('a review request: Ready for review, the PR, the acceptance summary, your call', () => {
    const r = result(review, AGENT);
    expect(r.status).toBe('Ready for review');
    expect(r.prUrl).toBe('https://github.com/benjgrad/conductor/pull/42');
    expect(r.acceptance).toBe('complete · Acceptance 8/10, gates ✓ · 1 for review');
    expect(r.next).toMatch(/^Your call: review the PR/);
  });

  it('a done session is Done (no PR state yet), with nothing next', () => {
    const r = result({ ...running, card: { ...running.card, status: 'done' } }, AGENT);
    expect(r.status).toBe('Done');
    expect(r.next).toMatch(/closed/);
  });

  it('a failed step shows its first error', () => {
    const detail: SessionDetail = {
      ...review,
      pending_input: {
        ...review.pending_input!,
        kind: 'retries_exhausted',
        origin_transition: null,
        step_failed: true,
        question:
          'Conductor could not PR opened to enter "Needs input": gh: No commits between main and x. Retry, skip, or abort?',
      },
    };
    const r = result(detail, AGENT);
    expect(r.status).toBe('Waiting for you');
    expect(r.failure?.error).toContain('No commits between');
    expect(r.next).toMatch(/^Your call: retry or fix/);
  });

  it('a failed session shows the last move reason as the error', () => {
    const detail: SessionDetail = {
      ...running,
      card: { ...running.card, status: 'failed' },
      moves: [{ ...MOVES[1]!, reason: 'budget exceeded' }],
    };
    const r = result(detail, AGENT);
    expect(r.status).toBe('Failed');
    expect(r.failure?.error).toBe('budget exceeded');
  });

  it('a running agent is In progress; a running step counts its checks', () => {
    const r = result(running, AGENT);
    expect(r.status).toBe('In progress');
    expect(r.next).toBe('Ada is working on implement.');
    const c = result({ ...running, card: { ...running.card, checking: mockChecking(2) } }, AGENT);
    expect(c.checks).toEqual({ passed: 2, failed: 0, total: 5 });
    expect(c.next).toBe('Waiting for Checks before PR ready for review.');
  });

  it('an agent question is your call to answer it', () => {
    const detail: SessionDetail = {
      ...review,
      pending_input: { ...review.pending_input!, origin_transition: 'ask_user', question: 'Why?' },
    };
    const r = result(detail, AGENT);
    expect(r.status).toBe('Waiting for you');
    expect(r.next).toBe("Your call: answer Ada's question.");
  });
});

describe('situation (FR-1)', () => {
  it("is the ticket's Context section when there is one", () => {
    const body = '## Goal\nShip it.\n\n## Context\nUsers asked for it.\n\n## Out of scope\nx';
    const s = situation(running, parseBrief(body), body);
    expect(s.text).toBe('Users asked for it.');
    expect(s).toMatchObject({ title: running.card.title, repo: running.card.repo });
  });

  it("is a legacy ticket's first paragraph", () => {
    const body = 'Rename the field.\nEverywhere.\n\nAlso the docs.';
    expect(situation(running, parseBrief(body), body).text).toBe('Rename the field.\nEverywhere.');
  });

  it('firstParagraph skips a leading heading', () => {
    expect(firstParagraph('# Title\n\nFirst.\n\nSecond.')).toBe('First.');
  });
});
