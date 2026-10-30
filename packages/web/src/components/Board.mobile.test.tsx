// @vitest-environment jsdom
import { BOARD_CARD_NEEDS_INPUT_FIXTURE, type BoardCard } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardState } from '../board/board.js';
import { mockViewport, type MockViewport } from '../test/match-media.js';
import { Board } from './Board.js';

let viewport: MockViewport;
beforeEach(() => {
  viewport = mockViewport(375);
});
afterEach(() => {
  cleanup();
  viewport.restore();
});

function card(n: number, column: string, over: Partial<BoardCard> = {}): BoardCard {
  const hex = n.toString(16).padStart(12, '0');
  return {
    ...BOARD_CARD_NEEDS_INPUT_FIXTURE,
    ticket_id: `a1000000-0000-4000-8000-${hex}`,
    session_id: `b2000000-0000-4000-8000-${hex}`,
    title: `Card ${n}`,
    column,
    human_transitions: [],
    input_request: null,
    ...over,
  };
}

function board(cards: BoardCard[]): BoardState {
  return { cards: new Map(cards.map((c) => [c.ticket_id, c])), lastEventId: 0 };
}

const renderBoard = (cards: BoardCard[]) =>
  render(<Board board={board(cards)} selectedSessionId={null} onSelect={() => {}} />);

const regions = () => screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
const selectedTab = () =>
  screen
    .getAllByRole('tab')
    .find((t) => t.getAttribute('aria-selected') === 'true')
    ?.textContent?.replace(/\s*\d+$/, '');

function drag(dx: number, dy: number) {
  const el = document.querySelector('.board') as HTMLElement;
  fireEvent.pointerDown(el, { clientX: 200, clientY: 300, isPrimary: true });
  fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 300 + dy, isPrimary: true });
}

describe('phone board (11-web-ui §Board)', () => {
  it('renders one column, with a switcher of every column and its count', () => {
    renderBoard([card(1, 'implementing'), card(2, 'implementing')]);
    expect(regions()).toHaveLength(1);
    const tabs = within(screen.getByRole('tablist', { name: 'Columns' })).getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(1);
    expect(screen.getByRole('tab', { name: /Implementing 2/ })).toBeTruthy();
  });

  it('opens on Needs input when it has cards', () => {
    renderBoard([card(1, 'queued'), card(2, 'needs_input')]);
    expect(regions()).toEqual(['Needs input']);
    expect(selectedTab()).toBe('Needs input');
  });

  it('else opens on the first column with cards', () => {
    renderBoard([card(1, 'implementing')]);
    expect(regions()).toEqual(['Implementing']);
    expect(screen.getByText('Card 1')).toBeTruthy();
  });

  it('a switcher tab shows its column', () => {
    renderBoard([card(1, 'queued'), card(2, 'needs_input')]);
    fireEvent.click(screen.getByRole('tab', { name: /Queued/ }));
    expect(regions()).toEqual(['Queued']);
    expect(screen.getByText('Card 1')).toBeTruthy();
    expect(screen.queryByText('Card 2')).toBeNull();
  });

  it('a swipe left shows the next column, a swipe right the previous one', () => {
    renderBoard([card(1, 'queued')]);
    expect(regions()).toEqual(['Queued']);
    drag(-120, 10);
    const next = regions()[0];
    expect(next).not.toBe('Queued');
    drag(120, -10);
    expect(regions()).toEqual(['Queued']);
  });

  it('a vertical drag, or a short one, does not change the column', () => {
    renderBoard([card(1, 'queued')]);
    drag(-80, 100);
    expect(regions()).toEqual(['Queued']);
    drag(-40, 0);
    expect(regions()).toEqual(['Queued']);
  });

  it('above the breakpoint every column renders and there is no switcher', () => {
    viewport.resize(1440);
    renderBoard([card(1, 'queued'), card(2, 'needs_input')]);
    expect(regions().length).toBeGreaterThan(1);
    expect(screen.queryByRole('tablist', { name: 'Columns' })).toBeNull();
  });
});
