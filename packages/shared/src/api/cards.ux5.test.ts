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
  priority: 0,
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

  it('NFR-1: an older card with checking {to, title, phase} only still parses', () => {
    const old = {
      ...BOARD_CARD_PENDING_FIXTURE,
      checking: { to: 'waiting_external', title: 'Waiting external', phase: 'checks' },
    };
    const parsed = BoardCardSchema.parse(old);
    expect(parsed.checking).toEqual(old.checking);
    expect(parsed.checking?.items).toBeUndefined();
  });
});
