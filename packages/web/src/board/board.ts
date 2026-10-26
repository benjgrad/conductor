import {
  boardColumns as defaultColumns,
  type BoardCard,
  type BoardColumnInfo,
  type BoardResponse,
  type BoardSseEvent,
} from '@conductor/shared';

// Client-side board state. The UI keeps one card per ticket_id and derives the columns as
// queries over the cards, so a stream event only has to patch one card. ADR-0010: the columns
// are the `conductor` workflow's states (ordered, from GET /api/board), Queued first; a card's
// `column` is one of their ids.

export interface BoardState {
  /** The board's columns, left to right (GET /api/board). Omitted = conductor v1's. */
  columns?: readonly BoardColumnInfo[] | undefined;
  cards: ReadonlyMap<string, BoardCard>;
  /** Highest board event id applied; replayed events at or below it are dropped. */
  lastEventId: number;
}

/** Before the first GET /api/board: conductor v1's columns, no cards. */
export const EMPTY_BOARD: BoardState = {
  columns: defaultColumns(null),
  cards: new Map(),
  lastEventId: 0,
};

export function boardFromResponse(res: BoardResponse): BoardState {
  const cards = new Map<string, BoardCard>();
  for (const col of res.columns) for (const card of col.cards) cards.set(card.ticket_id, card);
  return {
    columns: res.columns.map(({ id, title, kind }) => ({ id, title, kind })),
    cards,
    lastEventId: res.last_event_id,
  };
}

function findBySession(cards: ReadonlyMap<string, BoardCard>, sessionId: string) {
  for (const card of cards.values()) if (card.session_id === sessionId) return card;
  return undefined;
}

function patch(
  state: BoardState,
  card: BoardCard | undefined,
  next: Partial<BoardCard>,
  id: number,
): BoardState {
  const cards = new Map(state.cards);
  if (card) cards.set(card.ticket_id, { ...card, ...next });
  return { columns: state.columns, cards, lastEventId: id };
}

/** Apply one board SSE event. Pure; returns `state` unchanged for an already-seen id. */
export function applyBoardEvent(state: BoardState, ev: BoardSseEvent): BoardState {
  if (ev.id <= state.lastEventId) return state;
  switch (ev.type) {
    case 'card.upserted': {
      const cards = new Map(state.cards);
      cards.set(ev.ticket_id, ev.card);
      return { columns: state.columns, cards, lastEventId: ev.id };
    }
    case 'card.moved':
      return patch(
        state,
        state.cards.get(ev.ticket_id),
        { column: ev.to, updated_at: ev.ts },
        ev.id,
      );
    case 'session.status':
      return patch(
        state,
        findBySession(state.cards, ev.session_id),
        // ADR-0010: status is a badge, not a column; card.moved / card.upserted move the card.
        { status: ev.to, workflow_state: ev.workflow_state, updated_at: ev.ts },
        ev.id,
      );
    case 'input.requested':
      return patch(
        state,
        findBySession(state.cards, ev.session_id),
        {
          input_request: {
            id: ev.input_request_id,
            session_id: ev.session_id,
            kind: ev.kind,
            question: ev.question,
            created_at: ev.created_at,
            answer: null,
            answered_by: null,
            answered_at: null,
          },
        },
        ev.id,
      );
    case 'input.answered': {
      const card = findBySession(state.cards, ev.session_id);
      const open = card?.input_request?.id === ev.input_request_id;
      return patch(state, open ? card : undefined, { input_request: null }, ev.id);
    }
    case 'card.badge': {
      const card = findBySession(state.cards, ev.session_id);
      if (!card) return { ...state, lastEventId: ev.id };
      const others = card.badges.filter((b) => b !== ev.badge);
      return patch(state, card, { badges: ev.on ? [...others, ev.badge] : others }, ev.id);
    }
  }
}

const byPriorityThenAge = (a: BoardCard, b: BoardCard) =>
  b.priority - a.priority || a.created_at.localeCompare(b.created_at);
const byAge = (a: BoardCard, b: BoardCard) => a.created_at.localeCompare(b.created_at);
const byRecent = (a: BoardCard, b: BoardCard) => b.updated_at.localeCompare(a.updated_at);
/** Oldest open input_request first; cards without one (stream lag) go last. */
const byOldestQuestion = (a: BoardCard, b: BoardCard) => {
  const qa = a.input_request?.created_at;
  const qb = b.input_request?.created_at;
  if (qa === undefined || qb === undefined) return qa === qb ? byAge(a, b) : qa ? -1 : 1;
  return qa.localeCompare(qb);
};

/** Sort per 06 §Kanban columns, by the column's kind (ADR-0010). ISO timestamps sort as time. */
const SORT_BY_KIND: Record<BoardColumnInfo['kind'], (a: BoardCard, b: BoardCard) => number> = {
  queued: byPriorityThenAge,
  agent: byRecent,
  command: byRecent,
  connector: byRecent,
  human: byOldestQuestion,
  event: byAge,
  terminal: byRecent,
};

export interface BoardColumnView extends BoardColumnInfo {
  cards: BoardCard[];
}

/** The column queries: every card in exactly one column (unknown ids in the first), sorted. */
export function boardColumns(state: BoardState): BoardColumnView[] {
  const cols = (state.columns ?? EMPTY_BOARD.columns!).map((c) => ({
    ...c,
    cards: [] as BoardCard[],
  }));
  for (const card of state.cards.values()) {
    (cols.find((c) => c.id === card.column) ?? cols[0])?.cards.push(card);
  }
  for (const col of cols) col.cards.sort(SORT_BY_KIND[col.kind]);
  return cols;
}
