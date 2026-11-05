import {
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  BOARD_CARD_NEEDS_PERMISSION_FIXTURE,
  type BoardCard,
  type InputRequestDto,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { cardAction } from './card-action.js';
import type { PlanOptions } from './request-preview.js';

// UXR-33 (FR-4): one action per card, in priority order.
const BASE = BOARD_CARD_NEEDS_INPUT_FIXTURE;
const PR = 'https://github.com/benjgrad/conductor/pull/42';
const withRequest = (over: Partial<InputRequestDto>, card: Partial<BoardCard> = {}): BoardCard => ({
  ...BASE,
  input_request: { ...BASE.input_request!, ...over },
  ...card,
});
const OPTIONS = {
  multi_select: false,
  items: [{ label: 'Postgres', description: 'recommended' }, { label: 'SQLite' }],
};
const PLAN = {} as PlanOptions;

describe('cardAction', () => {
  it('a review request with a PR: the PR link, not the transitions', () => {
    expect(cardAction({ ...BASE, pr_url: PR }, 'review', null)).toEqual({
      kind: 'review_pr',
      url: PR,
    });
  });

  it('a review request without a PR falls back to the first transition', () => {
    expect(cardAction(BASE, 'review', null)).toEqual({
      kind: 'transition',
      option: BASE.human_transitions[0],
    });
  });

  it('a plan to approve: Approve plan', () => {
    expect(cardAction(BASE, 'plan_approval', PLAN)).toEqual({ kind: 'approve_plan', plan: PLAN });
  });

  it("the agent's options: the first, or Answer… when they don't fit the card", () => {
    expect(cardAction(withRequest({ options: OPTIONS }), 'question', null)).toEqual({
      kind: 'option',
      option: OPTIONS.items[0],
    });
    const multi = { ...OPTIONS, multi_select: true };
    expect(cardAction(withRequest({ options: multi }), 'question', null)).toEqual({
      kind: 'answer',
    });
  });

  it('a held permission: Allow once', () => {
    const c = BOARD_CARD_NEEDS_PERMISSION_FIXTURE;
    expect(cardAction(c, null, null)).toEqual({ kind: 'allow', permission: c.permission });
  });

  it('else the first human transition, or nothing', () => {
    expect(cardAction(BASE, 'question', null)).toEqual({
      kind: 'transition',
      option: BASE.human_transitions[0],
    });
    expect(
      cardAction({ ...BASE, input_request: null, human_transitions: [] }, null, null),
    ).toBeNull();
  });
});
