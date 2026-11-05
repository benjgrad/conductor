import type { BoardCard } from '@conductor/shared';

// UXR-32 (11-web-ui §Waiting on you): what waits on a person. An open question (`input_request`,
// the Needs input column) or a pending tool permission (ADR-0023 `sub_status: needs_permission`;
// the card stays in its agent's column). Every count of "waiting on you" (the Needs-input header
// and phone tab, the title, the favicon dot, the phone's default column) reads this one helper.

export interface WaitingOnYou {
  /** Cards with an open question. */
  questions: readonly BoardCard[];
  /** Cards with a pending permission and no open question (a card is never counted twice). */
  permissions: readonly BoardCard[];
  total: number;
}

/** The card holds a pending permission request (`permission` is set exactly then). */
export function hasPendingPermission(card: BoardCard): boolean {
  return card.sub_status === 'needs_permission' && card.permission !== undefined;
}

/** Permission cards are oldest request first (by when it expires: every request gets the same TTL). */
export function waitingOnYou(cards: Iterable<BoardCard>): WaitingOnYou {
  const questions: BoardCard[] = [];
  const permissions: BoardCard[] = [];
  for (const card of cards) {
    if (card.input_request !== null) questions.push(card);
    else if (hasPendingPermission(card)) permissions.push(card);
  }
  permissions.sort((a, b) => a.permission!.expires_at.localeCompare(b.permission!.expires_at));
  return { questions, permissions, total: questions.length + permissions.length };
}
