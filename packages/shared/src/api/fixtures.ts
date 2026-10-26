import type { BoardCard, MoveDto, TransitionSessionRequest } from './rest.js';
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
  workflow_id: 'conductor',
  workflow_state: null,
  status: null,
  column: 'queued',
  badges: [],
  checking: null,
  kind: null,
  pending: null,
  human_transitions: [],
  pr_url: null,
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
      from: 'implementing',
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

// ---------------------------------------------------------------- ADR-0011 (M1b-T01)
// Equal to what toBoardCard derives from MOVE_STEP_FIXTURE / a needs_input session on
// CONDUCTOR_V2_DRAFT (asserted in cards.test.ts). For the web mock (T07) and API tests (T04).

/** A work ticket held in Implementing by `ready_for_testing`'s conditions (approvals 0/1). */
export const BOARD_CARD_PENDING_FIXTURE: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  session_id,
  title: 'Add /health',
  workflow_state: 'implementing → waiting_external (move: ready_for_testing)',
  status: 'waiting_external',
  column: 'implementing',
  badges: ['checking'],
  checking: { to: 'waiting_external', title: 'Waiting external', phase: 'conditions' },
  kind: 'work',
  pending: {
    transition: 'ready_for_testing',
    to: 'waiting_external',
    title: 'Ready for testing',
    items: [
      { label: 'Build passes', status: 'met', detail: null },
      { label: 'Tests pass', status: 'met', detail: null },
      { label: 'PR opened', status: 'met', detail: null },
      { label: 'PR checks green (3/3)', status: 'met', detail: null },
      { label: 'PR approved (0/1)', status: 'pending', detail: null },
      { label: 'Jira fields set: resolution', status: 'disabled', detail: null },
      { label: 'Pipeline ci succeeded', status: 'disabled', detail: null },
    ],
    note: null,
  },
  pr_url: 'https://github.com/benjgrad/fixture-app/pull/7',
  machine_id: 'mbp-ben',
};

/** A personal ticket's Needs-input card (asked from Planning) with its three human buttons. */
export const BOARD_CARD_NEEDS_INPUT_FIXTURE: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a',
  session_id: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
  title: 'Plan the garden',
  workflow_state: 'needs_input',
  status: 'needs_input',
  column: 'needs_input',
  kind: 'personal',
  human_transitions: [
    { name: 'answer', title: 'Back with this answer', goto: 'planning', needs_text: true },
    {
      name: 'waiting_on_someone',
      title: 'Waiting on someone else',
      goto: 'waiting_external',
      needs_text: true,
    },
    { name: 'done', title: 'Done', goto: 'done', needs_text: false },
  ],
  machine_id: 'mbp-ben',
  input_request: {
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    session_id: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
    kind: 'agent_question',
    question: 'Raised beds or in-ground?',
    created_at: ts,
    answer: null,
    answered_by: null,
    answered_at: null,
  },
};

/** SessionDetail.moves of a work ticket that went Planning → Implementing → (move) → Waiting external. */
export const SESSION_MOVES_FIXTURE: MoveDto[] = [
  { at: ts, from: null, to: 'planning', transition: null, reason: null, actor: null },
  {
    at: '2026-10-22T12:10:00.000Z',
    from: 'planning',
    to: 'implementing',
    transition: 'plan_ready',
    reason: 'The plan names every file it changes.',
    actor: 'agent',
  },
  {
    at: '2026-10-22T12:40:00.000Z',
    from: 'implementing',
    to: 'implementing → waiting_external (move: ready_for_testing)',
    transition: 'ready_for_testing',
    reason: 'The endpoint is implemented and tested.',
    actor: 'agent',
  },
  {
    at: '2026-10-23T09:00:00.000Z',
    from: 'implementing → waiting_external (move: ready_for_testing)',
    to: 'waiting_external',
    transition: 'ready_for_testing',
    reason: 'The endpoint is implemented and tested.',
    actor: 'agent',
  },
];

/** POST /api/sessions/:id/transition bodies. */
export const TRANSITION_REQUEST_FIXTURES: Record<string, TransitionSessionRequest> = {
  waiting_on_someone: { name: 'waiting_on_someone', text: 'Dana is reviewing the API shape.' },
  done: { name: 'done' },
};

export const OUTPUT_CHUNK_FIXTURE: OutputChunk = {
  session_id,
  seq: 0,
  stream: 'stdout',
  text: '> npm run build\n',
  ts,
};
