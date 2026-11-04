import type { BoardCard } from '@conductor/shared';
import { useEffect, useRef } from 'react';
import { EMPTY_BOARD, type BoardState } from '../board/board.js';
import { agentName } from '../components/agent-identity.js';
import { setFaviconDot } from './favicon.js';
import { mayNotifyInTab, showInTab, type Close } from './show.js';

const TITLE = 'Conductor';
const BODY_MAX = 120;

export function clip(text: string, max: number = BODY_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * UX-14: while a conductor tab is open, tell Ben when an agent needs input.
 * - The title reads `(N) Conductor` and the favicon gets a dot while N cards have an open
 *   input_request (FR-3).
 * - Each **new** open request (by `input_request.id`) shows one browser notification when
 *   notifications are on and the page is hidden or unfocused (FR-1, FR-2). Requests already open
 *   when the board loads are only counted, and an id seen once never fires again, so reconnects,
 *   re-renders and the user's own answer (it only clears the request) don't re-fire (NFR-1).
 * The notification is shown by `showInTab` (show.ts: the service worker, else the constructor,
 * whose click focuses the tab and calls `onSelect` with the card's session id).
 */
export function useNeedsInputNotifications(
  board: BoardState,
  onSelect: (sessionId: string) => void,
): void {
  const seen = useRef<Set<string> | null>(null);
  const shown = useRef(new Map<string, Close>());
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    // Before GET /api/board answers there is nothing to count or compare against.
    if (board === EMPTY_BOARD) return;
    const open = [...board.cards.values()].filter((c) => c.input_request !== null);
    document.title = open.length > 0 ? `(${open.length}) ${TITLE}` : TITLE;
    setFaviconDot(open.length > 0);

    const openIds = new Set(open.map((c) => c.input_request!.id));
    // A request answered (here or elsewhere) takes its notification with it.
    for (const [id, close] of shown.current) {
      if (!openIds.has(id)) {
        close();
        shown.current.delete(id);
      }
    }

    if (seen.current === null) {
      seen.current = openIds;
      return;
    }
    for (const card of open) {
      const id = card.input_request!.id;
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const close = notify(card, (sessionId) => onSelectRef.current(sessionId));
      if (close) shown.current.set(id, close);
    }
  }, [board]);

  useEffect(
    () => () => {
      document.title = TITLE;
      setFaviconDot(false);
    },
    [],
  );
}

/**
 * Show one "needs input" notification, or nothing (off, pushed instead, page in front). Returns
 * how to close it. `seen` is already updated, so the async service worker path can't fire twice.
 */
function notify(card: BoardCard, select: (sessionId: string) => void): Close | null {
  const request = card.input_request;
  const sessionId = card.session_id;
  if (!request || sessionId === null || !mayNotifyInTab()) return null;
  return showInTab({
    title: `${agentName(card.ticket_id)} needs input`,
    body: clip(`${card.title}: ${request.question}`),
    tag: request.id,
    ticketId: card.ticket_id,
    onClick: () => select(sessionId),
  });
}
