import {
  BOARD_CARD_PENDING_FIXTURE,
  CONDUCTOR_V2_DRAFT_DEF,
  moveStateLabel,
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
      resumes: 'wait',
    });
    // The fixture waits only on approvals, so it shows in Waiting external; the source state
    // comes from the step's label, and a card still in its source column resumes too.
    expect(BOARD_CARD_PENDING_FIXTURE.column).toBe('waiting_external');
    expect(composerMode(detail({ ...BOARD_CARD_PENDING_FIXTURE, column: 'implementing' }))).toEqual(
      { mode: 'message', resumes: 'wait' },
    );
  });

  const inPhase = (phase: 'checks' | 'review' | 'actions', over: Partial<BoardCard> = {}) => ({
    ...BOARD_CARD_PENDING_FIXTURE,
    status: 'running' as const,
    checking: { ...BOARD_CARD_PENDING_FIXTURE.checking!, phase },
    ...over,
  });

  it('ADR-0044: messages the agent (stopping the checks) while conductor runs checks or review', () => {
    expect(composerMode(detail(inPhase('checks')))).toEqual({ mode: 'message', resumes: 'checks' });
    expect(composerMode(detail(inPhase('review')))).toEqual({ mode: 'message', resumes: 'checks' });
    // A requeued step (no machine yet) still takes the message.
    expect(composerMode(detail(inPhase('checks', { status: 'queued' })))).toEqual({
      mode: 'message',
      resumes: 'checks',
    });
  });

  it('stays off while conductor opens the PR (the actions phase)', () => {
    const m = composerMode(detail(inPhase('actions')));
    expect(m).toEqual({
      mode: 'off',
      reason:
        'Conductor is opening the PR; the agent resumes (or the ticket moves on) in a moment.',
    });
  });

  it('stays off while conductor checks a move out of an event state (no agent to resume)', () => {
    const card = inPhase('checks', {
      column: 'waiting_external',
      workflow_state: moveStateLabel('waiting_external', 'done', 'ui.approve'),
    });
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
