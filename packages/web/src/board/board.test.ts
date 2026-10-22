import {
  BOARD_CARD_FIXTURE,
  BOARD_COLUMNS,
  BOARD_SSE_FIXTURES,
  columnFor,
  SessionStatusSchema,
  type BoardCard,
  type BoardColumn,
  type SessionStatus,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { applyBoardEvent, boardColumns, EMPTY_BOARD, type BoardState } from './board.js';

const SESSION = BOARD_SSE_FIXTURES['session.status'].session_id;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function card(over: Partial<BoardCard> = {}): BoardCard {
  const status = over.status === undefined ? null : over.status;
  return {
    ...BOARD_CARD_FIXTURE,
    ticket_id: uuid(),
    session_id: status === null ? null : uuid(),
    column: columnFor(status),
    ...over,
  };
}

function boardOf(...cards: BoardCard[]): BoardState {
  return { cards: new Map(cards.map((c) => [c.ticket_id, c])), lastEventId: 0 };
}

const titles = (cards: BoardCard[]) => cards.map((c) => c.title);

describe('column mapping (06 §Kanban columns)', () => {
  const expected: Record<SessionStatus, BoardColumn> = {
    queued: 'queued',
    assigned: 'queued',
    running: 'running',
    needs_input: 'needs_input',
    waiting_external: 'waiting_external',
    done: 'done',
    failed: 'failed',
    lost: 'failed',
  };

  it('puts every session status in its column, and a sessionless ticket in Queued', () => {
    const cards = SessionStatusSchema.options.map((status) => card({ status, title: status }));
    const cols = boardColumns(boardOf(card({ title: 'new ticket' }), ...cards));
    for (const status of SessionStatusSchema.options) {
      expect(titles(cols[expected[status]])).toContain(status);
    }
    expect(titles(cols.queued)).toEqual(expect.arrayContaining(['new ticket']));
    expect(BOARD_COLUMNS.reduce((sum, c) => sum + cols[c].length, 0)).toBe(cards.length + 1);
  });

  it('keeps a build-slot-waiting session in Running (badge, not status)', () => {
    const c = card({ status: 'running', badges: ['waiting_for_build_slot'], title: 'slot' });
    expect(titles(boardColumns(boardOf(c)).running)).toEqual(['slot']);
  });

  it('sorts needs_input by oldest open input_request first', () => {
    const ask = (title: string, askedAt: string, createdAt: string) =>
      card({
        status: 'needs_input',
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
    // Ticket age must not matter: "b" is the older ticket but asked later.
    const cols = boardColumns(
      boardOf(
        ask('b', '2026-10-22T12:30:00.000Z', '2026-10-22T09:00:00.000Z'),
        ask('a', '2026-10-22T12:10:00.000Z', '2026-10-22T11:00:00.000Z'),
        ask('c', '2026-10-22T12:50:00.000Z', '2026-10-22T08:00:00.000Z'),
      ),
    );
    expect(titles(cols.needs_input)).toEqual(['a', 'b', 'c']);
  });

  it('sorts queued by priority then age, running/done/failed by recent first', () => {
    const t = (h: number) => `2026-10-22T${String(h).padStart(2, '0')}:00:00.000Z`;
    const cols = boardColumns(
      boardOf(
        card({ title: 'q-old', created_at: t(1) }),
        card({ title: 'q-new', created_at: t(2) }),
        card({ title: 'q-urgent', priority: 3, created_at: t(3) }),
        card({ status: 'running', title: 'r-stale', updated_at: t(1) }),
        card({ status: 'running', title: 'r-active', updated_at: t(5) }),
        card({ status: 'done', title: 'd-old', updated_at: t(1) }),
        card({ status: 'done', title: 'd-new', updated_at: t(4) }),
        card({ status: 'waiting_external', title: 'w-young', created_at: t(4) }),
        card({ status: 'waiting_external', title: 'w-old', created_at: t(2) }),
      ),
    );
    expect(titles(cols.queued)).toEqual(['q-urgent', 'q-old', 'q-new']);
    expect(titles(cols.running)).toEqual(['r-active', 'r-stale']);
    expect(titles(cols.done)).toEqual(['d-new', 'd-old']);
    expect(titles(cols.waiting_external)).toEqual(['w-old', 'w-young']);
  });
});

describe('applyBoardEvent', () => {
  const running = card({
    status: 'running',
    session_id: SESSION,
    ticket_id: BOARD_SSE_FIXTURES['card.moved'].ticket_id,
    workflow_state: 'implement',
  });

  it('card.upserted adds a card (the create-ticket path)', () => {
    const s = applyBoardEvent(EMPTY_BOARD, BOARD_SSE_FIXTURES['card.upserted']);
    expect(boardColumns(s).queued).toEqual([BOARD_CARD_FIXTURE]);
    expect(s.lastEventId).toBe(100);
  });

  it('session.status moves the card to columnFor(to)', () => {
    const s = applyBoardEvent(boardOf(running), BOARD_SSE_FIXTURES['session.status']);
    const c = s.cards.get(running.ticket_id);
    expect(c).toMatchObject({ status: 'needs_input', column: 'needs_input' });
  });

  it('card.moved sets the column', () => {
    const s = applyBoardEvent(boardOf(running), BOARD_SSE_FIXTURES['card.moved']);
    expect(boardColumns(s).needs_input.map((c) => c.ticket_id)).toEqual([running.ticket_id]);
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
