import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { BOARD_CARD_FIXTURE } from './fixtures.js';
import { INPUT_REQUEST_TEXT_LIMIT, SessionDetailSchema, toSessionInputRequest } from './rest.js';

// UX-7: SessionDetail.input_requests is additive; a payload from an older server still parses.

const OLD_PAYLOAD = {
  card: BOARD_CARD_FIXTURE,
  workflow: CONDUCTOR_V1_DEF,
  workflow_version: 1,
  context: {},
  retry_counters: {},
  state_visits: {},
  return_to: null,
  state_entered_at: '2026-10-27T10:00:00.000Z',
  state_deadline: null,
  spend_usd: 0,
  wall_seconds: 0,
  budget: { usd: 2, minutes: 60 },
  branch: null,
  worktree_path: null,
  pending_input: null,
  recent_output: [],
};

const REQUEST = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'agent_question',
  question: 'Which DB?',
  created_at: '2026-10-27T10:00:00.000Z',
  answer: 'Postgres',
  answered_at: '2026-10-27T10:05:00.000Z',
  truncated: false,
} as const;

describe('SessionDetail.input_requests (UX-7)', () => {
  it('an old payload without it still parses', () => {
    expect(SessionDetailSchema.parse(OLD_PAYLOAD).input_requests).toBeUndefined();
  });

  it('round-trips answered and open requests', () => {
    const open = { ...REQUEST, answer: null, answered_at: null };
    const detail = SessionDetailSchema.parse({ ...OLD_PAYLOAD, input_requests: [REQUEST, open] });
    expect(detail.input_requests).toEqual([REQUEST, open]);
  });

  it('rejects a non-string answer', () => {
    const bad = { ...OLD_PAYLOAD, input_requests: [{ ...REQUEST, answer: 1 }] };
    expect(SessionDetailSchema.safeParse(bad).success).toBe(false);
  });
});

describe('toSessionInputRequest', () => {
  const row = {
    ...REQUEST,
    created_at: new Date(REQUEST.created_at),
    answered_at: new Date(REQUEST.answered_at),
  };

  it('keeps short text as is', () => {
    expect(toSessionInputRequest(row)).toEqual(REQUEST);
  });

  it('clips a long question or answer and flags it', () => {
    const long = 'x'.repeat(INPUT_REQUEST_TEXT_LIMIT + 1);
    const q = toSessionInputRequest({ ...row, question: long });
    expect(q.question).toHaveLength(INPUT_REQUEST_TEXT_LIMIT);
    expect(q.truncated).toBe(true);
    const a = toSessionInputRequest({ ...row, answer: long });
    expect(a.answer).toHaveLength(INPUT_REQUEST_TEXT_LIMIT);
    expect(a.truncated).toBe(true);
  });
});
