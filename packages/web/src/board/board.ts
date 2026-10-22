import {
  BOARD_COLUMNS,
  columnFor,
  type BoardCard,
  type BoardColumn,
  type BoardResponse,
  type BoardSseEvent,
} from '@conductor/shared';

// Client-side board state. The UI keeps one card per ticket_id and derives the columns as
// queries over the cards (06 §Kanban columns), so a stream event only has to patch one card.

export interface BoardState {
  cards: ReadonlyMap<string, BoardCard>;
  /** Highest board event id applied; replayed events at or below it are dropped. */
  lastEventId: number;
}

export const EMPTY_BOARD: BoardState = { cards: new Map(), lastEventId: 0 };

export const COLUMN_TITLES: Record<BoardColumn, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs input',
  waiting_external: 'Waiting (external)',
  done: 'Done',
  failed: 'Failed',
};

export function boardFromResponse(res: BoardResponse): BoardState {
  const cards = new Map<string, BoardCard>();
  for (const col of BOARD_COLUMNS)
    for (const card of res.columns[col]) cards.set(card.ticket_id, card);
  return { cards, lastEventId: res.last_event_id };
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
) {
  const cards = new Map(state.cards);
  if (card) cards.set(card.ticket_id, { ...card, ...next });
  return { cards, lastEventId: id };
}

/** Apply one board SSE event. Pure; returns `state` unchanged for an already-seen id. */
export function applyBoardEvent(state: BoardState, ev: BoardSseEvent): BoardState {
  if (ev.id <= state.lastEventId) return state;
  switch (ev.type) {
    case 'card.upserted': {
      const cards = new Map(state.cards);
      cards.set(ev.ticket_id, ev.card);
      return { cards, lastEventId: ev.id };
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
        {
          status: ev.to,
          column: columnFor(ev.to),
          workflow_state: ev.workflow_state,
          updated_at: ev.ts,
        },
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

/** Sort per 06 §Kanban columns. Timestamps are ISO-8601 UTC, so string order is time order. */
const COLUMN_SORT: Record<BoardColumn, (a: BoardCard, b: BoardCard) => number> = {
  queued: byPriorityThenAge,
  running: byRecent,
  needs_input: byOldestQuestion,
  waiting_external: byAge,
  done: byRecent,
  failed: byRecent,
};

/** The column queries: every card in exactly one column, each column sorted per 06. */
export function boardColumns(state: BoardState): Record<BoardColumn, BoardCard[]> {
  const cols = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as BoardCard[]])) as Record<
    BoardColumn,
    BoardCard[]
  >;
  for (const card of state.cards.values()) cols[card.column].push(card);
  for (const col of BOARD_COLUMNS) cols[col].sort(COLUMN_SORT[col]);
  return cols;
}
