import { describe, expect, it } from 'vitest';
import type { TicketStatus } from '../domain.js';
import { STEP_CONTEXT_KEY } from '../engine/review.js';
import { GateStepSchema, moveStateLabel, type GateStep } from '../engine/types.js';
import { boardColumns, CONDUCTOR_V2_DEF } from '../workflow/conductor.js';
import { BOARD_CARD_PENDING_FIXTURE } from './fixtures.js';
import { BoardCardSchema, checkingOfStep, toBoardCard, type CardView } from './rest.js';

// UX-5: `card.checking` says what conductor is running in a gate step (label, items, statuses),
// so the board shows "Conductor is checking", not an agent that looks running but disconnected.

const V2: CardView = { columns: boardColumns(CONDUCTOR_V2_DEF), def: CONDUCTOR_V2_DEF };

const ticket = {
  id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  status: 'in_progress' as TicketStatus,
  kind: 'personal' as const,
  title: 'UX-5',
  external_ref: null,
  repo: 'github.com/benjgrad/conductor',
  priority: 3,
  workflow_id: 'conductor',
  created_at: new Date('2026-10-27T15:00:00.000Z'),
  updated_at: new Date('2026-10-27T15:00:00.000Z'),
};

/** `personal_pr_ready_for_review` out of Implementing, as the engine stores it (apply startStep). */
const step = (over: Partial<GateStep>): GateStep =>
  GateStepSchema.parse({
    kind: 'move',
    from: 'implementing',
    outcome: 'personal_pr_ready_for_review',
    to: 'needs_input',
    attachment: null,
    subject: 'Done.',
    claude_session_id: null,
    nudged: false,
    phase: 'checks',
    index: 0,
    transition: 'personal_pr_ready_for_review',
    actor: 'agent',
    ...over,
  });

const session = (s: GateStep) => ({
  id: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
  workflow_state: moveStateLabel(s.from, s.to, s.transition ?? s.outcome),
  status: 'running' as const,
  machine_id: 'mbp-ben',
  spend_usd: 1.2,
  waiting_for_build_slot: false,
  context: { [STEP_CONTEXT_KEY]: s } as Record<string, unknown>,
  updated_at: new Date('2026-10-27T15:46:00.000Z'),
});

const cardIn = (s: GateStep, view = V2) => toBoardCard(ticket, session(s), null, view);

describe('BoardCard.checking (UX-5)', () => {
  it('FR-1: a move step running its second check has the label, phase and items', () => {
    const card = BoardCardSchema.parse(cardIn(step({ index: 1, head_sha: 'abc' })));
    expect(card.badges).toContain('checking');
    expect(card.column).toBe('implementing');
    expect(card.checking).toEqual({
      to: 'needs_input',
      title: 'Needs input',
      phase: 'checks',
      label: 'Checks before PR ready for review',
      transition: 'personal_pr_ready_for_review',
      items: [
        { label: 'Build passes', kind: 'check', status: 'passed', detail: null },
        { label: 'Tests pass', kind: 'check', status: 'running', detail: null },
        { label: 'PR opened', kind: 'action', status: 'todo', detail: null },
      ],
      current: 1,
      checks_source: 'workflow',
    });
  });

  it('regression (M2-T09b, 15:46): checking.label and checking.items are not empty', () => {
    const checking = cardIn(step({ index: 0 })).checking!;
    // Before UX-5 the card carried only {to, title, phase}: label undefined, no items.
    expect(checking.label).toBeDefined();
    expect(checking.items).toHaveLength(3);
    expect(checking.items![0]).toMatchObject({ label: 'Build passes', status: 'running' });
    expect(checking.current).toBe(0);
  });

  it('the actions phase: both checks passed, open_pr running', () => {
    const checking = cardIn(step({ phase: 'actions', index: 0 })).checking!;
    expect(checking.phase).toBe('actions');
    expect(checking.items!.map((i) => i.status)).toEqual(['passed', 'passed', 'running']);
    expect(checking.current).toBe(2);
  });

  it('the review phase of pr_ready_for_review: a review item, running', () => {
    const checking = cardIn(
      step({
        outcome: 'pr_ready_for_review',
        transition: 'pr_ready_for_review',
        phase: 'review',
      }),
    ).checking!;
    expect(checking.items!.map((i) => [i.kind, i.status])).toEqual([
      ['check', 'passed'],
      ['check', 'passed'],
      ['review', 'running'],
      ['action', 'todo'],
    ]);
    expect(checking.items![2]!.label).toBe('Review: 1 requirement');
  });

  it('an ADR-0009 review step is labelled "Review before …"', () => {
    const s = step({ kind: 'transition', transition: null, phase: 'review' });
    expect(checkingOfStep(null, s).label).toBe('Review before needs_input');
  });

  it('an unknown definition: items [], current null, label from the target', () => {
    const checking = cardIn(step({}), { ...V2, def: null }).checking!;
    expect(checking).toMatchObject({
      label: 'Checks before needs_input',
      items: [],
      current: null,
    });
  });

  it('the conditions phase keeps `pending` as before and has no running item', () => {
    expect(BOARD_CARD_PENDING_FIXTURE.checking?.current).toBeNull();
    expect(BOARD_CARD_PENDING_FIXTURE.pending?.items).toHaveLength(7);
  });

  it('UXR-75: a step with a pinned repo override says so, and lists its checks', () => {
    const repo_checks = { checks: [{ name: 'Make test', cmd: 'make test' }] };
    const checking = cardIn(step({ index: 0, repo_checks })).checking!;
    expect(checking.checks_source).toBe('repo');
    expect(checking.items!.map((i) => i.label)).toEqual(['Make test', 'PR opened']);
  });

  it('UXR-75: without an override the checks are the workflow’s', () => {
    expect(cardIn(step({ index: 0 })).checking!.checks_source).toBe('workflow');
  });

  it('UXR-75: an override on a step that declares no checks does not apply', () => {
    const repo_checks = { checks: [{ name: 'Make test', cmd: 'make test' }] };
    const s = step({ kind: 'transition', transition: null, phase: 'review', repo_checks });
    expect(checkingOfStep(CONDUCTOR_V2_DEF, s).checks_source).toBe('workflow');
  });

  it('UXR-75: an unknown definition reports a pinned override', () => {
    const repo_checks = { checks: [{ name: 'Make test', cmd: 'make test' }] };
    expect(checkingOfStep(null, step({ repo_checks })).checks_source).toBe('repo');
  });

  it('NFR-1: an older card with checking {to, title, phase} only still parses', () => {
    const old = {
      ...BOARD_CARD_PENDING_FIXTURE,
      checking: { to: 'waiting_external', title: 'Waiting external', phase: 'checks' },
    };
    const parsed = BoardCardSchema.parse(old);
    expect(parsed.checking).toEqual(old.checking);
    expect(parsed.checking?.items).toBeUndefined();
    expect(parsed.checking?.checks_source).toBeUndefined();
  });
});

describe('BoardCard.checking: a held move (ADR-0037 P4, T7)', () => {
  const A = 'aaaaaaaa-1111-4000-8000-000000000001';
  const B = 'bbbbbbbb-2222-4000-8000-000000000002';
  /** CONDUCTOR_V2 has no `requires.concurrency`: add it to the PR-ready transition. */
  const withConcurrency = (): CardView => {
    const def = structuredClone(CONDUCTOR_V2_DEF);
    const s = def.states.implementing!;
    if (s.type !== 'agent') throw new Error('agent');
    const t = s.on.personal_pr_ready_for_review!;
    if (typeof t === 'string') throw new Error('object');
    t.requires = {
      ...t.requires,
      concurrency: {
        key: '$repo',
        max_in_flight: 1,
        scope: ['in_review'],
        order: 'oldest_first',
        overlap: 'planned_files',
        hold_timeout: '1d',
      },
    };
    return { columns: boardColumns(def), def };
  };
  const hold = (behind: string[]) => ({
    behind,
    since: '2026-10-27T15:40:00.000Z',
    deadline: '2026-10-28T15:40:00.000Z',
  });

  it('"Queued behind #N" with the holders\' short ids, and a held item first', () => {
    const card = BoardCardSchema.parse(
      cardIn(step({ phase: 'held', hold: hold([A, B]), held: true }), withConcurrency()),
    );
    expect(card.checking).toMatchObject({
      phase: 'held',
      label: 'Queued behind #aaaaaaaa, #bbbbbbbb',
      hold: { behind: ['aaaaaaaa', 'bbbbbbbb'], since: '2026-10-27T15:40:00.000Z' },
    });
    expect(card.checking!.items![0]).toMatchObject({
      kind: 'held',
      label: 'One at a time',
      status: 'pending',
    });
    expect(card.checking!.items!.slice(1).map((i) => i.status)).toEqual(['todo', 'todo', 'todo']);
  });

  it('before the first check, a neutral label (nobody named)', () => {
    const c = cardIn(step({ phase: 'held', hold: hold([]) }), withConcurrency()).checking!;
    expect(c.label).toBe('Checking what else is in flight');
    expect(c.items![0]).toMatchObject({ kind: 'held', status: 'running' });
  });

  it('once released, the held item is passed and the checks run', () => {
    const c = cardIn(step({ phase: 'checks', held: true }), withConcurrency()).checking!;
    expect(c.hold).toBeUndefined();
    expect(c.items!.map((i) => [i.kind, i.status])).toEqual([
      ['held', 'passed'],
      ['check', 'running'],
      ['check', 'todo'],
      ['action', 'todo'],
    ]);
  });
});
