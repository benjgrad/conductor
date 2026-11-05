// UXR-33 (FR-4): a board card offers at most one action. The panel has every other option; the
// card's title and preview open it. Neither questions nor transitions carry a "recommended" flag:
// ask_user lists the recommended option first and workflows list the primary transition first,
// so the card offers the first.
import type { BoardCard, BoardHumanTransition, QuestionOption } from '@conductor/shared';
import { cardAnswersInline } from './CardActions.js';
import type { PlanOptions, RequestClass } from './request-preview.js';

export type CardAction =
  /** A review request: the PR link. */
  | { kind: 'review_pr'; url: string }
  /** 06 §Plan approval: Approve plan. */
  | { kind: 'approve_plan'; plan: PlanOptions }
  /** The agent's first (recommended) option, answered in one click. */
  | { kind: 'option'; option: QuestionOption }
  /** Too many options (or multi-select) for the card: Answer… opens the panel. */
  | { kind: 'answer' }
  /** ADR-0023: Allow once for the oldest held prompt; Deny and Allow always are in the panel. */
  | { kind: 'allow'; permission: NonNullable<BoardCard['permission']> }
  /** The first human transition. */
  | { kind: 'transition'; option: BoardHumanTransition };

type ActionCard = Pick<
  BoardCard,
  'input_request' | 'pr_url' | 'sub_status' | 'permission' | 'human_transitions'
>;

/** The card's one action, or null. `cls` / `plan`: the open request's class and plan options. */
export function cardAction(
  card: ActionCard,
  cls: RequestClass | null,
  plan: PlanOptions | null,
): CardAction | null {
  const q = card.input_request;
  if (cls === 'review' && card.pr_url) return { kind: 'review_pr', url: card.pr_url };
  if (plan) return { kind: 'approve_plan', plan };
  if (q?.options) {
    const first = q.options.items[0];
    return cardAnswersInline(q) && first ? { kind: 'option', option: first } : { kind: 'answer' };
  }
  if (card.sub_status === 'needs_permission' && card.permission) {
    return { kind: 'allow', permission: card.permission };
  }
  const first = card.human_transitions[0];
  return first ? { kind: 'transition', option: first } : null;
}
