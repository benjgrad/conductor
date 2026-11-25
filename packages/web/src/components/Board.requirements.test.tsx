// @vitest-environment jsdom
// ADR-0045: a board card's requirements chip (`BoardCard.requirements`).
import { BOARD_CARD_NEEDS_INPUT_FIXTURE, type BoardCard } from '@conductor/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Board } from './Board.js';

afterEach(cleanup);

function card(n: number, over: Partial<BoardCard> = {}): BoardCard {
  const hex = n.toString(16).padStart(12, '0');
  return {
    ...BOARD_CARD_NEEDS_INPUT_FIXTURE,
    ticket_id: `a1000000-0000-4000-8000-${hex}`,
    session_id: `b2000000-0000-4000-8000-${hex}`,
    title: `Card ${n}`,
    human_transitions: [],
    ...over,
  };
}

describe('the requirements chip', () => {
  it('shows how many are met and a proposed change; nothing without a checklist', () => {
    const cards = [card(1, { requirements: { met: 2, total: 5, proposed: true } }), card(2)];
    render(
      <Board
        board={{ cards: new Map(cards.map((c) => [c.ticket_id, c])), lastEventId: 0 }}
        selectedSessionId={null}
        onSelect={() => {}}
      />,
    );
    const one = screen.getByText('Card 1').closest('article')!;
    const tag = one.querySelector<HTMLElement>('.tag-requirements');
    expect(tag?.title).toBe('2 of 5 requirements met');
    expect(tag?.textContent).toBe('☑ 2/5 requirements met');
    expect(one.textContent).toContain('requirements change proposed');
    expect(
      screen.getByText('Card 2').closest('article')!.querySelector('.tag-requirements'),
    ).toBeNull();
  });
});
