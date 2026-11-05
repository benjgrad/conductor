import type { BoardCard } from '@conductor/shared';
import { useEffect, useRef } from 'react';
import { EMPTY_BOARD, type BoardState } from '../board/board.js';
import { waitingOnYou } from '../board/waiting.js';
import { cardAgent } from '../components/agent-identity.js';
import { setFaviconDot } from './favicon.js';
import { mayNotifyInTab, showInTab, type Close } from './show.js';

const TITLE = 'Conductor';
const BODY_MAX = 120;

/**
 * The tag (and seen-key) of a permission prompt's notification: the same as its Web Push's
 * (orchestrator push/payload.ts `permissionTag`), so a push replaces it on a pushed device.
 */
export function permissionTag(requestId: string): string {
  return `permission:${requestId}`;
}

export function clip(text: string, max: number = BODY_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * UX-14: while a conductor tab is open, tell Ben when an agent needs input.
 * - The title reads `(N) Conductor` and the favicon gets a dot while N cards wait on a person:
 *   an open input_request (FR-3) or a pending permission (UXR-32, `waitingOnYou`).
 * - Each **new** open request (by `input_request.id`, or `permission:<request_id>` for the
 *   permission a card shows) shows one browser notification when
 *   notifications are on and the page is hidden or unfocused (FR-1, FR-2). Requests already open
 *   when the board loads are only counted, and an id seen once never fires again, so reconnects,
 *   re-renders and the user's own answer (it only clears the request) don't re-fire (NFR-1).
 * The notification is shown by `showInTab` (show.ts: the service worker, else the constructor,
 * whose click focuses the tab and calls `onSelect` with the card's session id).
 * A card carries only its oldest pending permission, so a second one on the same session notifies
 * here once the first is decided; its Web Push (keyed per request on the server) is not delayed.
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
    const waiting = waitingOnYou(board.cards.values());
    document.title = waiting.total > 0 ? `(${waiting.total}) ${TITLE}` : TITLE;
    setFaviconDot(waiting.total > 0);

    const open: { id: string; card: BoardCard; show: typeof notify }[] = [
      ...waiting.questions.map((card) => ({ id: card.input_request!.id, card, show: notify })),
      ...waiting.permissions.map((card) => ({
        id: permissionTag(card.permission!.request_id),
        card,
        show: notifyPermission,
      })),
    ];
    const openIds = new Set(open.map((o) => o.id));
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
    for (const { id, card, show } of open) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const close = show(card, (sessionId) => onSelectRef.current(sessionId));
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
    title: `${cardAgent(card).name} needs input`,
    body: clip(`${card.title}: ${request.question}`),
    tag: request.id,
    ticketId: card.ticket_id,
    onClick: () => select(sessionId),
  });
}

/** UXR-32: one "needs permission" notification for the permission the card shows, or nothing. */
function notifyPermission(card: BoardCard, select: (sessionId: string) => void): Close | null {
  const permission = card.permission;
  const sessionId = card.session_id;
  if (!permission || sessionId === null || !mayNotifyInTab()) return null;
  return showInTab({
    title: `${cardAgent(card).name} needs permission`,
    body: clip(`${card.title}: ${permission.tool}: ${permission.summary}`),
    tag: permissionTag(permission.request_id),
    ticketId: card.ticket_id,
    onClick: () => select(sessionId),
  });
}
