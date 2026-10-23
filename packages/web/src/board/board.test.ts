import {
  BOARD_CARD_FIXTURE,
  BOARD_SSE_FIXTURES,
  type BoardCard,
  type BoardResponse,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  applyBoardEvent,
  boardColumns,
  boardFromResponse,
  EMPTY_BOARD,
  type BoardState,
} from './board.js';

const SESSION = BOARD_SSE_FIXTURES['session.status'].session_id;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    ...BOARD_CARD_FIXTURE,
    ticket_id: uuid(),
    session_id: over.status ? uuid() : null,
    ...over,
  };
}

function boardOf(...cards: BoardCard[]): BoardState {
  return { ...EMPTY_BOARD, cards: new Map(cards.map((c) => [c.ticket_id, c])) };
}

const titles = (cards: BoardCard[]) => cards.map((c) => c.title);
const col = (s: BoardState, id: string) => boardColumns(s).find((c) => c.id === id)!.cards;

describe('columns (ADR-0010: the conductor states, Queued first)', () => {
  it('defaults to conductor v1’s columns, in order', () => {
    expect(boardColumns(EMPTY_BOARD).map((c) => [c.id, c.title])).toEqual([
      ['queued', 'Queued'],
      ['planning', 'Planning'],
      ['implementing', 'Implementing'],
      ['needs_input', 'Needs input'],
      ['waiting_external', 'Waiting external'],
      ['done', 'Done'],
    ]);
  });

  it('takes the columns and cards from GET /api/board', () => {
    const c = card({ status: 'running', column: 'build', title: 'x' });
    const res: BoardResponse = {
      columns: [
        { id: 'queued', title: 'Queued', kind: 'queued', cards: [] },
        { id: 'build', title: 'Build it', kind: 'agent', cards: [c] },
      ],
      last_event_id: 7,
    };
    const s = boardFromResponse(res);
    expect(boardColumns(s).map((x) => [x.id, x.title, titles(x.cards)])).toEqual([
      ['queued', 'Queued', []],
      ['build', 'Build it', ['x']],
    ]);
    expect(s.lastEventId).toBe(7);
  });

  it('every card in exactly one column; an unknown column id falls back to the first', () => {
    const cards = [
      card({ title: 'new' }),
      card({ status: 'running', column: 'implementing', title: 'impl' }),
      card({ status: 'done', column: 'done', title: 'done', badges: ['failed'] }),
      card({ status: 'running', column: 'nope', title: 'odd' }),
    ];
    const cols = boardColumns(boardOf(...cards));
    expect(cols.reduce((sum, c) => sum + c.cards.length, 0)).toBe(cards.length);
    expect(titles(col(boardOf(...cards), 'queued'))).toEqual(['new', 'odd']);
    expect(titles(col(boardOf(...cards), 'done'))).toEqual(['done']);
  });

  it('sorts by kind: human by oldest question, queued by priority then age, others recent first', () => {
    const t = (h: number) => `2026-10-22T${String(h).padStart(2, '0')}:00:00.000Z`;
    const ask = (title: string, askedAt: string, createdAt: string) =>
      card({
        status: 'needs_input',
        column: 'needs_input',
        title,
        created_at: createdAt,
        input_request: {
          id: uuid(),
          session_id: uuid(),
          kind: 'agent_question',
          question: title,
          created_at: askedAt,
          answer: null,
          answered_by: null,
          answered_at: null,
        },
      });
    const s = boardOf(
      ask('b', t(12), t(9)),
      ask('a', t(11), t(10)),
      card({ title: 'q-old', created_at: t(1) }),
      card({ title: 'q-urgent', priority: 3, created_at: t(3) }),
      card({ status: 'running', column: 'implementing', title: 'r-stale', updated_at: t(1) }),
      card({ status: 'running', column: 'implementing', title: 'r-active', updated_at: t(5) }),
      card({
        status: 'waiting_external',
        column: 'waiting_external',
        title: 'w-young',
        created_at: t(4),
      }),
      card({
        status: 'waiting_external',
        column: 'waiting_external',
        title: 'w-old',
        created_at: t(2),
      }),
    );
    expect(titles(col(s, 'needs_input'))).toEqual(['a', 'b']);
    expect(titles(col(s, 'queued'))).toEqual(['q-urgent', 'q-old']);
    expect(titles(col(s, 'implementing'))).toEqual(['r-active', 'r-stale']);
    expect(titles(col(s, 'waiting_external'))).toEqual(['w-old', 'w-young']);
  });
});

describe('applyBoardEvent', () => {
  const running = card({
    status: 'running',
    column: 'implementing',
    session_id: SESSION,
    ticket_id: BOARD_SSE_FIXTURES['card.moved'].ticket_id,
    workflow_state: 'implementing',
  });

  it('card.upserted adds a card (the create-ticket path)', () => {
    const s = applyBoardEvent(EMPTY_BOARD, BOARD_SSE_FIXTURES['card.upserted']);
    expect(col(s, 'queued')).toEqual([BOARD_CARD_FIXTURE]);
    expect(s.lastEventId).toBe(100);
  });

  it('session.status updates status and state, not the column (status is a badge)', () => {
    const s = applyBoardEvent(boardOf(running), BOARD_SSE_FIXTURES['session.status']);
    expect(s.cards.get(running.ticket_id)).toMatchObject({
      status: 'needs_input',
      workflow_state: 'needs_input',
      column: 'implementing',
    });
  });

  it('card.moved sets the column', () => {
    const s = applyBoardEvent(boardOf(running), BOARD_SSE_FIXTURES['card.moved']);
    expect(col(s, 'needs_input').map((c) => c.ticket_id)).toEqual([running.ticket_id]);
  });

  it('input.requested / input.answered set and clear the question badge', () => {
    let s = applyBoardEvent(boardOf(running), BOARD_SSE_FIXTURES['input.requested']);
    expect(s.cards.get(running.ticket_id)?.input_request).toMatchObject({
      question: 'Which DB should I target?',
      kind: 'agent_question',
    });
    s = applyBoardEvent(s, BOARD_SSE_FIXTURES['input.answered']);
    expect(s.cards.get(running.ticket_id)?.input_request).toBeNull();
  });

  it('card.badge toggles the build-slot badge', () => {
    let s = applyBoardEvent(boardOf(running), BOARD_SSE_FIXTURES['card.badge']);
    expect(s.cards.get(running.ticket_id)?.badges).toEqual(['waiting_for_build_slot']);
    s = applyBoardEvent(s, { ...BOARD_SSE_FIXTURES['card.badge'], id: 200, on: false });
    expect(s.cards.get(running.ticket_id)?.badges).toEqual([]);
  });

  it('drops replayed events at or below lastEventId', () => {
    const s = { ...boardOf(running), lastEventId: 102 };
    expect(applyBoardEvent(s, BOARD_SSE_FIXTURES['session.status'])).toBe(s);
  });
});
