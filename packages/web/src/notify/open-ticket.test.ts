// @vitest-environment jsdom
import { BOARD_CARD_FIXTURE, type BoardCard } from '@conductor/shared';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardFromResponse, EMPTY_BOARD, type BoardState } from '../board/board.js';
import { ticketFromUrl, useOpenFromNotification } from './open-ticket.js';

const CARD: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: '11111111-1111-4111-8111-111111111111',
  session_id: '22222222-2222-4222-8222-222222222222',
};

const loaded = (cards: BoardCard[]): BoardState =>
  boardFromResponse({
    columns: [{ id: 'queued', title: 'Queued', kind: 'queued', cards }],
    last_event_id: 1,
  });

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('ticketFromUrl', () => {
  it.each([
    ['https://c.example/#/?ticket=abc', 'abc'],
    ['/#/?ticket=abc', 'abc'],
    ['#/?ticket=abc&x=1', 'abc'],
    ['https://c.example/#/', null],
    ['https://c.example/?ticket=abc', null],
    ['#/?ticket=', null],
  ])('%s → %s', (url, want) => {
    expect(ticketFromUrl(url)).toBe(want);
  });
});

describe('useOpenFromNotification', () => {
  it('selects the ticket from the URL once the board loads, then cleans the URL', () => {
    window.history.replaceState(null, '', `/#/?ticket=${CARD.ticket_id}`);
    const onSelect = vi.fn();
    const { rerender } = renderHook(({ board }) => useOpenFromNotification(board, onSelect), {
      initialProps: { board: EMPTY_BOARD },
    });
    expect(onSelect).not.toHaveBeenCalled();
    rerender({ board: loaded([CARD]) });
    expect(onSelect).toHaveBeenCalledWith(CARD.session_id);
    expect(window.location.hash).toBe('#/');
  });

  it('drops a ticket that is not on the board', () => {
    window.history.replaceState(null, '', '/#/?ticket=gone');
    const onSelect = vi.fn();
    renderHook(() => useOpenFromNotification(loaded([CARD]), onSelect));
    expect(onSelect).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
  });

  it('does nothing without a ticket in the URL', () => {
    const onSelect = vi.fn();
    renderHook(() => useOpenFromNotification(loaded([CARD]), onSelect));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
