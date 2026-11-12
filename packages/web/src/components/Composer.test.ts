import {
  BOARD_CARD_PENDING_FIXTURE,
  CONDUCTOR_V2_DRAFT_DEF,
  type BoardCard,
  type SessionDetail,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { composerMode, composerPlaceholder } from './Composer.js';

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
    // The fixture waits only on approvals, so it shows in Waiting external; the source state
    // comes from the step's label, and a card still in its source column resumes too.
    expect(BOARD_CARD_PENDING_FIXTURE.column).toBe('waiting_external');
    expect(composerMode(detail({ ...BOARD_CARD_PENDING_FIXTURE, column: 'implementing' }))).toEqual(
      { mode: 'message', resumes: true },
    );
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

describe('composerPlaceholder (UXR-36 FR-3)', () => {
  const answer = { mode: 'answer' } as const;
  const ctx = (tone: Parameters<typeof composerPlaceholder>[1]['tone'], fromAgent = true) => ({
    tone,
    agent: 'Avery',
    fromAgent,
  });

  it('names the agent and the kind of request', () => {
    expect(composerPlaceholder(answer, ctx('question'))).toBe('Answer Avery…');
    expect(composerPlaceholder(answer, ctx('review'))).toBe('Ask Avery for changes…');
    expect(composerPlaceholder({ mode: 'message' }, ctx(null))).toBe(
      'Message Avery… (/ for commands)',
    );
    expect(composerPlaceholder({ mode: 'reopen' }, ctx(null))).toBe(
      'Ask Avery to change something…',
    );
  });

  it("a failure conductor raised is conductor's question; an agent's is the agent's", () => {
    expect(composerPlaceholder(answer, ctx('failure', false))).toBe('Tell Conductor what to do…');
    expect(composerPlaceholder(answer, ctx('failure', true))).toBe('Answer Avery…');
  });

  it('never the Enter hint, and empty when disabled (the reason is shown once, below)', () => {
    expect(composerPlaceholder(answer, ctx('question'))).not.toMatch(/Enter/);
    expect(composerPlaceholder({ mode: 'off', reason: 'Session finished' }, ctx(null))).toBe('');
  });
});
