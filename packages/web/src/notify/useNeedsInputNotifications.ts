import type { BoardCard } from '@conductor/shared';
import { useEffect, useRef } from 'react';
import { EMPTY_BOARD, type BoardState } from '../board/board.js';
import { agentName } from '../components/agent-identity.js';
import { setFaviconDot } from './favicon.js';
import { notifyState } from './settings.js';

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
 * Clicking a notification focuses the tab and calls `onSelect` with the card's session id.
 */
export function useNeedsInputNotifications(
  board: BoardState,
  onSelect: (sessionId: string) => void,
): void {
  const seen = useRef<Set<string> | null>(null);
  const shown = useRef(new Map<string, Notification>());
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
    for (const [id, n] of shown.current) {
      if (!openIds.has(id)) {
        n.close();
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
      const n = notify(card, (sessionId) => onSelectRef.current(sessionId));
      if (n) shown.current.set(id, n);
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

function notify(card: BoardCard, select: (sessionId: string) => void): Notification | null {
  const request = card.input_request;
  const sessionId = card.session_id;
  if (!request || sessionId === null || notifyState() !== 'on') return null;
  if (document.visibilityState !== 'hidden' && document.hasFocus()) return null;
  try {
    const n = new Notification(`${agentName(card.ticket_id)} needs input`, {
      body: clip(`${card.title}: ${request.question}`),
      tag: request.id,
    });
    n.onclick = () => {
      window.focus();
      select(sessionId);
      n.close();
    };
    return n;
  } catch {
    // Some mobile browsers only allow notifications from a service worker (UX-16).
    return null;
  }
}
