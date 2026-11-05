// @vitest-environment jsdom
// UXR-37: focus mode's ticket list. Collapsible groups per column, remembered; Done starts
// collapsed; the open ticket's group always shows.
import { BOARD_CARD_NEEDS_INPUT_FIXTURE, type BoardCard } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../board/board.js';
import { ticketListKey } from './board-layout.js';
import { TicketList, type TicketListProps } from './TicketList.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function card(n: number, column: string, over: Partial<BoardCard> = {}): BoardCard {
  const hex = n.toString(16).padStart(12, '0');
  return {
    ...BOARD_CARD_NEEDS_INPUT_FIXTURE,
    ticket_id: `a1000000-0000-4000-8000-${hex}`,
    session_id: `b2000000-0000-4000-8000-${hex}`,
    title: `Card ${n}`,
    column,
    input_request: null,
    human_transitions: [],
    ...over,
  };
}

const CARDS = [
  card(1, 'queued', { session_id: null }),
  card(2, 'implementing'),
  card(3, 'needs_input', {
    input_request: {
      ...BOARD_CARD_NEEDS_INPUT_FIXTURE.input_request!,
      session_id: 'b2000000-0000-4000-8000-000000000003',
    },
  }),
  card(4, 'done'),
  card(5, 'done'),
];

function board(cards: BoardCard[] = CARDS): BoardState {
  return {
    columns: [
      { id: 'queued', title: 'Queued', kind: 'queued' },
      { id: 'implementing', title: 'Implementing', kind: 'agent' },
      { id: 'needs_input', title: 'Needs input', kind: 'human' },
      { id: 'waiting', title: 'Waiting external', kind: 'event' },
      { id: 'done', title: 'Done', kind: 'terminal' },
    ],
    cards: new Map(cards.map((c) => [c.ticket_id, c])),
    lastEventId: 0,
  };
}

function renderList(props: Partial<TicketListProps> = {}) {
  const onSelect = vi.fn();
  const onSelectTicket = vi.fn();
  const onShowBoard = vi.fn();
  const r = render(
    <TicketList
      board={board()}
      selectedSessionId={null}
      selectedTicketId={null}
      onSelect={onSelect}
      onSelectTicket={onSelectTicket}
      onShowBoard={onShowBoard}
      {...props}
    />,
  );
  return { ...r, onSelect, onSelectTicket, onShowBoard };
}

const toggle = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) });
const row = (title: string) =>
  screen.queryByRole('button', { name: new RegExp(`^${title}(?!\\d)`) });

describe('TicketList (UXR-37)', () => {
  it('lists every open ticket by column; Done starts collapsed; empty columns are left out', () => {
    renderList();
    const nav = screen.getByRole('navigation', { name: 'Tickets' });
    expect(within(nav).getByText('3 open')).toBeTruthy();
    for (const t of ['Card 1', 'Card 2', 'Card 3']) expect(row(t)).toBeTruthy();
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('false');
    expect(row('Card 4')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Waiting external/ })).toBeNull();

    fireEvent.click(toggle('Done'));
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('true');
    expect(row('Card 4')).toBeTruthy();
  });

  it('collapses a group and remembers it', () => {
    const { unmount } = renderList();
    fireEvent.click(toggle('Implementing'));
    expect(toggle('Implementing').getAttribute('aria-expanded')).toBe('false');
    expect(row('Card 2')).toBeNull();
    expect(JSON.parse(localStorage.getItem(ticketListKey('conductor'))!)).toEqual([
      'done',
      'implementing',
    ]);
    unmount();

    renderList();
    expect(toggle('Implementing').getAttribute('aria-expanded')).toBe('false');
    expect(row('Card 2')).toBeNull();
  });

  it("always shows the open ticket's group, without storing that", () => {
    localStorage.setItem(ticketListKey('conductor'), JSON.stringify(['done', 'implementing']));
    renderList({ selectedSessionId: 'b2000000-0000-4000-8000-000000000004' });
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('true');
    expect(row('Card 4')!.getAttribute('aria-current')).toBe('true');
    expect(row('Card 5')!.getAttribute('aria-current')).toBeNull();
    expect(row('Card 2')).toBeNull();
    expect(JSON.parse(localStorage.getItem(ticketListKey('conductor'))!)).toEqual([
      'done',
      'implementing',
    ]);
  });

  it('opens a session by its session and a queued ticket by its ticket; Board goes back', () => {
    const { onSelect, onSelectTicket, onShowBoard } = renderList();
    fireEvent.click(row('Card 2')!);
    expect(onSelect).toHaveBeenCalledWith('b2000000-0000-4000-8000-000000000002');
    fireEvent.click(row('Card 1')!);
    expect(onSelectTicket).toHaveBeenCalledWith('a1000000-0000-4000-8000-000000000001');
    fireEvent.click(screen.getByRole('button', { name: '← Board' }));
    expect(onShowBoard).toHaveBeenCalledOnce();
  });

  it("shows a card's request label", () => {
    renderList();
    const needs = row('Card 3')!;
    expect(needs.querySelector('.badge')?.textContent).toBeTruthy();
  });
});
