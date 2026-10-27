import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { BOARD_CARD_FIXTURE } from './fixtures.js';
import { SessionDetailSchema } from './rest.js';

// UX-2: SessionDetail.ticket_body is additive; a payload from an older server still parses.

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

describe('SessionDetail.ticket_body (UX-2)', () => {
  it('an old payload without it still parses', () => {
    const detail = SessionDetailSchema.parse(OLD_PAYLOAD);
    expect(detail.ticket_body).toBeUndefined();
  });

  it('round-trips a markdown body', () => {
    const body = '## Goal\nShip it.\n\n## Functional requirements\n- FR-1 Works';
    expect(SessionDetailSchema.parse({ ...OLD_PAYLOAD, ticket_body: body }).ticket_body).toBe(body);
  });

  it('rejects a non-string', () => {
    expect(SessionDetailSchema.safeParse({ ...OLD_PAYLOAD, ticket_body: 1 }).success).toBe(false);
  });
});
