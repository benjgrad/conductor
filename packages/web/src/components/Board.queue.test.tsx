// @vitest-environment jsdom
// 06 §Queue order: the Queued column's cards are put in pickup order by drag and drop, the arrow
// keys on a card's handle, or (phone) Move up / Move down; Reset returns to priority order.
import { BOARD_CARD_FIXTURE, type BoardCard, type QueueOrderResponse } from '@conductor/shared';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import type { BoardState } from '../board/board.js';
import { mockViewport } from '../test/match-media.js';
import { Board, withQueueOrder } from './Board.js';

afterEach(cleanup);

function card(n: number, over: Partial<BoardCard> = {}): BoardCard {
  const hex = n.toString(16).padStart(12, '0');
  return {
    ...BOARD_CARD_FIXTURE,
    ticket_id: `a1000000-0000-4000-8000-${hex}`,
    session_id: null,
    status: null,
    column: 'queued',
    title: `Q${n}`,
    priority: 3,
    created_at: `2026-10-22T0${n}:00:00.000Z`,
    input_request: null,
    human_transitions: [],
    ...over,
  };
}

const board = (cards: BoardCard[]): BoardState => ({
  cards: new Map(cards.map((c) => [c.ticket_id, c])),
  lastEventId: 0,
});

function fakeApi(reorder?: (ids: readonly string[]) => Promise<QueueOrderResponse>) {
  const reorderQueue = vi.fn(
    reorder ?? ((ids: readonly string[]) => Promise.resolve({ ticket_ids: [...ids], skipped: [] })),
  );
  const resetQueueOrder = vi.fn(() => Promise.resolve({ ticket_ids: [], skipped: [] }));
  return {
    api: { reorderQueue, resetQueueOrder } as unknown as ApiClient,
    reorderQueue,
    resetQueueOrder,
  };
}

const queuedTitles = () =>
  [...document.querySelectorAll('[data-column="queued"] .card-title')].map((e) => e.textContent);

const three = () => [card(1), card(2), card(3)];

describe('Queued column order (06 §Queue order)', () => {
  it('gives a waiting card a handle, but not a claimed card in Queued or one without an api', () => {
    const claimed = card(4, {
      status: 'assigned',
      session_id: 'b2000000-0000-4000-8000-000000000004',
    });
    const { api } = fakeApi();
    const r = render(
      <Board
        board={board([...three(), claimed])}
        selectedSessionId={null}
        onSelect={() => {}}
        api={api}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^Reorder: / })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Reorder: Q4' })).toBeNull();
    r.unmount();
    render(<Board board={board(three())} selectedSessionId={null} onSelect={() => {}} />);
    expect(screen.queryAllByRole('button', { name: /^Reorder: / })).toHaveLength(0);
  });

  it('the arrow keys move a card, at once, and send the new order', async () => {
    const { api, reorderQueue } = fakeApi();
    const [a, b, c] = three();
    render(
      <Board board={board([a!, b!, c!])} selectedSessionId={null} onSelect={() => {}} api={api} />,
    );
    expect(queuedTitles()).toEqual(['Q1', 'Q2', 'Q3']);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder: Q3' }), { key: 'ArrowUp' });
    expect(queuedTitles()).toEqual(['Q1', 'Q3', 'Q2']);
    expect(reorderQueue).toHaveBeenCalledWith([a!.ticket_id, c!.ticket_id, b!.ticket_id]);
    // The top card can't go higher.
    reorderQueue.mockClear();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder: Q1' }), { key: 'ArrowUp' });
    expect(reorderQueue).not.toHaveBeenCalled();
    await waitFor(() => expect(queuedTitles()).toEqual(['Q1', 'Q3', 'Q2']));
  });

  it('dropping a dragged card above another sends that order', () => {
    const { api, reorderQueue } = fakeApi();
    const [a, b, c] = three();
    render(
      <Board board={board([a!, b!, c!])} selectedSessionId={null} onSelect={() => {}} api={api} />,
    );
    const items = [...document.querySelectorAll<HTMLElement>('[data-column="queued"] li')];
    items.forEach((li, i) => {
      li.getBoundingClientRect = () => ({ top: i * 100, height: 100 }) as DOMRect;
    });
    const list = document.querySelector<HTMLElement>('[data-column="queued"] ul')!;
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(items[2]!, { dataTransfer });
    // The pointer in the top half of the first card: the dragged one goes first.
    // jsdom has no DragEvent, so the pointer's position is set on the event by hand.
    const at = (make: typeof createEvent.dragOver, y: number) => {
      const ev = make(list, { dataTransfer });
      Object.defineProperty(ev, 'clientY', { value: y });
      fireEvent(list, ev);
    };
    at(createEvent.dragOver, 20);
    expect(items[0]!.classList.contains('drop-before')).toBe(true);
    at(createEvent.drop, 20);
    expect(reorderQueue).toHaveBeenCalledWith([c!.ticket_id, a!.ticket_id, b!.ticket_id]);
    expect(queuedTitles()).toEqual(['Q3', 'Q1', 'Q2']);
  });

  it('a failed reorder puts the cards back and says so', async () => {
    const { api } = fakeApi(() =>
      Promise.reject(new Error('none of ticket_ids is a queued ticket')),
    );
    render(<Board board={board(three())} selectedSessionId={null} onSelect={() => {}} api={api} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder: Q1' }), { key: 'ArrowDown' });
    expect(queuedTitles()).toEqual(['Q2', 'Q1', 'Q3']);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Couldn’t reorder the queue: none of ticket_ids is a queued ticket',
    );
    expect(queuedTitles()).toEqual(['Q1', 'Q2', 'Q3']);
  });

  it('offers Reset only once a card has a hand-set place', async () => {
    const { api, resetQueueOrder } = fakeApi();
    const r = render(
      <Board board={board(three())} selectedSessionId={null} onSelect={() => {}} api={api} />,
    );
    expect(screen.queryByRole('button', { name: 'Reset to priority order' })).toBeNull();
    r.rerender(
      <Board
        board={board([card(1, { queue_position: 1 }), card(2), card(3)])}
        selectedSessionId={null}
        onSelect={() => {}}
        api={api}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset to priority order' }));
    await act(() => Promise.resolve());
    expect(resetQueueOrder).toHaveBeenCalledOnce();
  });

  it('on a phone: Move up / Move down, and a tap on them is not a column swipe', () => {
    const viewport = mockViewport(375);
    try {
      const { api, reorderQueue } = fakeApi();
      const [a, b, c] = three();
      render(
        <Board
          board={board([a!, b!, c!])}
          selectedSessionId={null}
          onSelect={() => {}}
          api={api}
        />,
      );
      expect(screen.getByRole('button', { name: 'Move up: Q1' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: 'Move down: Q3' })).toHaveProperty(
        'disabled',
        true,
      );
      const down = screen.getByRole('button', { name: 'Move down: Q1' });
      // A sideways pointer drag that starts on the buttons doesn't change column.
      fireEvent.pointerDown(down, { clientX: 300, clientY: 100, isPrimary: true });
      fireEvent.pointerUp(down, { clientX: 100, clientY: 100, isPrimary: true });
      expect(document.querySelector('[data-column="queued"]')).not.toBeNull();
      fireEvent.click(down);
      expect(reorderQueue).toHaveBeenCalledWith([b!.ticket_id, a!.ticket_id, c!.ticket_id]);
    } finally {
      viewport.restore();
    }
  });
});

describe('withQueueOrder', () => {
  it('reorders the waiting cards and leaves a claimed one in its slot', () => {
    const [a, b] = three();
    const claimed = card(5, { status: 'assigned' });
    const out = withQueueOrder([a!, claimed, b!], [b!.ticket_id, a!.ticket_id]);
    expect(out.map((c) => c.title)).toEqual(['Q2', 'Q5', 'Q1']);
  });
});
