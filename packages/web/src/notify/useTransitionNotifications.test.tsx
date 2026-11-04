// @vitest-environment jsdom
import { BOARD_CARD_FIXTURE, BOARD_SSE_FIXTURES, type BoardCard } from '@conductor/shared';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBoardEvent,
  boardFromResponse,
  EMPTY_BOARD,
  type BoardState,
} from '../board/board.js';
import { stubNotification } from './notification-stub.js';
import { useTransitionNotifications } from './useTransitionNotifications.js';

const EV = BOARD_SSE_FIXTURES['transition.notified'];
const CARD: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: EV.ticket_id,
  session_id: EV.session_id,
};

function loaded(lastEventId = 10): BoardState {
  return boardFromResponse({
    columns: [{ id: 'queued', title: 'Queued', kind: 'queued', cards: [CARD] }],
    last_event_id: lastEventId,
  });
}
const notified = (b: BoardState, id: number) => applyBoardEvent(b, { ...EV, id });

let N: ReturnType<typeof stubNotification>;
const onSelect = vi.fn();

function mount(board: BoardState) {
  return renderHook(({ b }) => useTransitionNotifications(b, onSelect), {
    initialProps: { b: board },
  });
}

beforeEach(() => {
  N = stubNotification('granted');
  localStorage.setItem('conductor.notifications', 'on');
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  onSelect.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useTransitionNotifications', () => {
  it('fires once per new notice, with its title, body and tag; a click opens the session', () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const start = loaded();
    const { rerender } = mount(start);
    const next = notified(start, 11);
    rerender({ b: next });
    expect(N.instances).toHaveLength(1);
    expect(N.instances[0]!.title).toBe(EV.title);
    expect(N.instances[0]!.options).toMatchObject({ body: EV.body, tag: EV.tag });
    N.instances[0]!.onclick!();
    expect(onSelect).toHaveBeenCalledWith(EV.session_id);

    // Re-render and replay: nothing more. A second notice: one more.
    rerender({ b: next });
    rerender({ b: notified(next, 11) });
    expect(N.instances).toHaveLength(1);
    rerender({ b: notified(next, 12) });
    expect(N.instances).toHaveLength(2);
  });

  it('never fires for notices already there at the first board', () => {
    const { rerender } = mount(EMPTY_BOARD);
    rerender({ b: notified(loaded(), 11) });
    expect(N.instances).toHaveLength(0);
  });

  it("doesn't fire when off, focused, or when this device gets the push", () => {
    const start = loaded();
    const { rerender } = mount(start);
    localStorage.setItem('conductor.notifications', 'off');
    let b = notified(start, 11);
    rerender({ b });
    localStorage.setItem('conductor.notifications', 'on');
    localStorage.setItem('conductor.push', 'on');
    b = notified(b, 12);
    rerender({ b });
    localStorage.removeItem('conductor.push');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    rerender({ b: notified(b, 13) });
    expect(N.instances).toHaveLength(0);
  });
});
