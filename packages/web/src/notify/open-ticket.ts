import { useCallback, useEffect, useRef } from 'react';
import { EMPTY_BOARD, type BoardState } from '../board/board.js';

// UX-16: a push notification opens `/#/?ticket=<ticket_id>` (UX-15's payload). A closed app loads
// that URL; an open one gets the URL from the service worker in a `conductor:open` message
// (public/sw.js) and is only focused, not reloaded. Either way the board selects the ticket's
// session once the card is on the board, and the parameter leaves the URL.

export const OPEN_MESSAGE = 'conductor:open';

/** The `ticket` parameter of a `#/?ticket=…` hash (a full URL or the hash alone), or null. */
export function ticketFromUrl(url: string): string | null {
  const hash = url.slice(url.indexOf('#') + 1);
  const q = hash.indexOf('?');
  if (!url.includes('#') || q === -1) return null;
  return new URLSearchParams(hash.slice(q + 1)).get('ticket') || null;
}

/** Select the session of the ticket a notification points at, when its card arrives. */
export function useOpenFromNotification(
  board: BoardState,
  onSelect: (sessionId: string) => void,
): void {
  // Refs, not state: the ticket waits for the board, and opening it only calls onSelect.
  const pending = useRef<string | null>(null);
  const boardRef = useRef(board);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  /** Open the pending ticket once the board has loaded; a ticket not on it is dropped. */
  const tryOpen = useCallback(() => {
    const ticket = pending.current;
    const current = boardRef.current;
    if (ticket === null || current === EMPTY_BOARD) return;
    pending.current = null;
    const card = [...current.cards.values()].find((c) => c.ticket_id === ticket);
    if (card?.session_id) onSelectRef.current(card.session_id);
    if (ticketFromUrl(window.location.href)) window.history.replaceState(null, '', '#/');
  }, []);

  useEffect(() => {
    const open = (url: string) => {
      const id = ticketFromUrl(url);
      if (id === null) return;
      pending.current = id;
      tryOpen();
    };
    const onHash = () => open(window.location.href);
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === OPEN_MESSAGE && typeof data.url === 'string') open(data.url);
    };
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    open(window.location.href);
    window.addEventListener('hashchange', onHash);
    sw?.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('hashchange', onHash);
      sw?.removeEventListener('message', onMessage);
    };
  }, [tryOpen]);

  useEffect(() => {
    boardRef.current = board;
    tryOpen();
  }, [board, tryOpen]);
}
