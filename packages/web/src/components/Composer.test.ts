import {
  BOARD_CARD_PENDING_FIXTURE,
  CONDUCTOR_V2_DRAFT_DEF,
  type BoardCard,
  type SessionDetail,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { composerMode } from './Composer.js';

function detail(card: BoardCard): SessionDetail {
  return {
    card,
    workflow: CONDUCTOR_V2_DRAFT_DEF,
    workflow_version: CONDUCTOR_V2_DRAFT_DEF.version,
    context: {},
    retry_counters: {},
    state_visits: {},
    return_to: null,
    state_entered_at: card.updated_at,
    state_deadline: null,
    spend_usd: 0,
    wall_seconds: 0,
    budget: { usd: 10, minutes: 120 },
    branch: null,
    worktree_path: null,
    pending_input: null,
    recent_output: [],
  };
}

describe('composerMode while a move step waits on its conditions', () => {
  it("messages the agent (resuming it) while the PR's checks run, out of an agent state", () => {
    expect(composerMode(detail(BOARD_CARD_PENDING_FIXTURE))).toEqual({
      mode: 'message',
      resumes: true,
    });
  });

  it('stays off while conductor runs the checks themselves', () => {
    const card: BoardCard = {
      ...BOARD_CARD_PENDING_FIXTURE,
      status: 'running',
      checking: { ...BOARD_CARD_PENDING_FIXTURE.checking!, phase: 'checks' },
    };
    expect(composerMode(detail(card)).mode).toBe('off');
  });

  it('stays off for a plain event state (no agent to resume)', () => {
    const card: BoardCard = {
      ...BOARD_CARD_PENDING_FIXTURE,
      column: 'waiting_external',
      workflow_state: 'waiting_external',
      checking: null,
    };
    expect(composerMode(detail(card)).mode).toBe('off');
  });
});
