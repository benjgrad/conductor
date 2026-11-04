import { useEffect, useRef } from 'react';
import { EMPTY_BOARD, type BoardState } from '../board/board.js';
import { mayNotifyInTab, showInTab } from './show.js';

/**
 * While a conductor tab is open, show one browser notification per **new** `transition.notified`
 * event (a workflow transition with `notify: true` was taken; 05 §Transitions). Notices already in
 * the board when it loads never fire, and an id seen once never fires again (reconnects,
 * re-renders). Same gates as needs input (`mayNotifyInTab`): notifications on, no push on this
 * device (the push carries the same `tag`), page hidden or unfocused.
 * Unlike a needs-input notification, nothing closes it: nothing is left to answer.
 */
export function useTransitionNotifications(
  board: BoardState,
  onSelect: (sessionId: string) => void,
): void {
  const seen = useRef<Set<number> | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    if (board === EMPTY_BOARD) return;
    const notices = board.notices ?? [];
    if (seen.current === null) {
      seen.current = new Set(notices.map((n) => n.id));
      return;
    }
    for (const n of notices) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (!mayNotifyInTab()) continue;
      showInTab({
        title: n.title,
        body: n.body,
        tag: n.tag,
        ticketId: n.ticket_id,
        onClick: () => onSelectRef.current(n.session_id),
      });
    }
  }, [board]);
}
