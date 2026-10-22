import type { BoardCard } from './rest.js';
import type { BoardSseEvent, BoardSseEventType, OutputChunk } from './sse.js';

// One fixture per SSE board event type, plus an output chunk. Used by round-trip tests and
// by the web mock API (T09).

const session_id = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f';
const ts = '2026-10-22T12:00:00.000Z';

/** A freshly created ticket: no session yet, Queued column (POST /api/tickets). */
export const BOARD_CARD_FIXTURE: BoardCard = {
  ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
  session_id: null,
  title: 'Add /health',
  external_ref: null,
  repo: 'github.com/benjgrad/fixture-app',
  priority: 0,
  workflow_id: 'm1_basic',
  workflow_state: null,
  status: null,
  column: 'queued',
  badges: [],
  machine_id: null,
  spend_usd: 0,
  input_request: null,
  created_at: ts,
  updated_at: ts,
};

export const BOARD_SSE_FIXTURES: { [K in BoardSseEventType]: Extract<BoardSseEvent, { type: K }> } =
  {
    'card.upserted': {
      type: 'card.upserted',
      id: 100,
      ts,
      session_id: null,
      ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      card: BOARD_CARD_FIXTURE,
    },
    'card.moved': {
      type: 'card.moved',
      id: 101,
      ts,
      session_id,
      ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      from: 'running',
      to: 'needs_input',
    },
    'session.status': {
      type: 'session.status',
      id: 102,
      ts,
      session_id,
      from: 'running',
      to: 'needs_input',
      workflow_state: 'needs_input',
    },
    'input.requested': {
      type: 'input.requested',
      id: 103,
      ts,
      session_id,
      input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      kind: 'agent_question',
      question: 'Which DB should I target?',
      created_at: ts,
    },
    'input.answered': {
      type: 'input.answered',
      id: 104,
      ts,
      session_id,
      input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      answered_by: 'ben',
    },
    'card.badge': {
      type: 'card.badge',
      id: 105,
      ts,
      session_id,
      badge: 'waiting_for_build_slot',
      on: true,
    },
  };

export const OUTPUT_CHUNK_FIXTURE: OutputChunk = {
  session_id,
  seq: 0,
  stream: 'stdout',
  text: '> npm run build\n',
  ts,
};
