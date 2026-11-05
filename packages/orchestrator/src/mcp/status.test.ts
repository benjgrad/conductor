import type { BoardCard, InputRequestDto, SessionDetail } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  STATUS_REPORT_MAX,
  lastAssistantText,
  statusLine,
  statusReport,
  waitingOn,
  type CardLike,
} from './status.js';

const SID = '00000000-0000-4000-8000-000000000001';

const card = (over: Partial<BoardCard> = {}): CardLike & Pick<BoardCard, 'workflow_state'> => ({
  status: 'running',
  input_request: null,
  human_transitions: [],
  checking: null,
  workflow_state: 'implementing',
  ...over,
});

const question = (kind: InputRequestDto['kind'], text = 'Which colour?'): InputRequestDto => ({
  id: '00000000-0000-4000-8000-000000000002',
  session_id: SID,
  kind,
  question: text,
  created_at: '2026-11-03T10:00:00.000Z',
  answer: null,
  answered_by: null,
  answered_at: null,
});

const button = (name: string) => ({ name, title: name, goto: 'x', needs_text: false });

describe('waitingOn', () => {
  it('a running agent, and a running agent after its question was answered, wait on the agent', () => {
    expect(waitingOn(card())).toBe('agent');
  });

  it('an open question of any kind waits on you', () => {
    for (const kind of ['agent_question', 'budget_exceeded', 'machine_lost'] as const) {
      expect(waitingOn(card({ status: 'needs_input', input_request: question(kind) }))).toBe('you');
    }
  });

  it('a permission prompt waits on you on the board, even with buttons', () => {
    const permission = {
      request_id: SID,
      tool: 'Bash' as const,
      summary: 'rm -rf dist',
      expires_at: '2026-11-03T10:05:00.000Z',
      pending_count: 1,
    };
    expect(waitingOn(card({ permission }))).toBe('you_on_board');
  });

  it('buttons wait on you, unless every one needs a board approval', () => {
    const c = card({ status: 'needs_input', human_transitions: [button('merge'), button('back')] });
    expect(waitingOn(c)).toBe('you');
    expect(waitingOn(c, { gated: new Set(['merge']) })).toBe('you');
    expect(waitingOn(c, { gated: new Set(['merge', 'back']) })).toBe('you_on_board');
  });

  it('checks and outside events wait on checks', () => {
    const checking = { to: 'review', title: 'Review', phase: 'checks' as const };
    expect(waitingOn(card({ checking }))).toBe('checks');
    expect(waitingOn(card({ status: 'waiting_external' }))).toBe('checks');
  });

  it('queued, assigned and lost wait on a machine; done and failed on nobody', () => {
    expect(waitingOn(card({ status: null }))).toBe('machine');
    expect(waitingOn(card({ status: 'assigned' }))).toBe('machine');
    expect(waitingOn(card({ status: 'lost' }))).toBe('machine');
    expect(waitingOn(card({ status: 'done' }))).toBe('nobody');
    expect(waitingOn(card({ status: 'failed' }))).toBe('nobody');
    expect(waitingOn(card({ status: null }), { ticketStatus: 'cancelled' })).toBe('nobody');
  });
});

describe('statusLine', () => {
  it('quotes the question, names the buttons, and gives the agent’s time in state', () => {
    const asked = card({ status: 'needs_input', input_request: question('agent_question') });
    expect(statusLine({ card: asked, waiting: 'you' })).toBe(
      'Waiting on you: the agent asks: "Which colour?"',
    );
    // A PR-ready summary through a question: true gate is a hand-off, not a question.
    const done = card({
      status: 'needs_input',
      input_request: question('agent_question', 'I fixed the only failing test.'),
    });
    expect(statusLine({ card: done, waiting: 'you', handoff: true })).toBe(
      'Waiting on you: the agent reports: "I fixed the only failing test."',
    );
    // A cancel ends the session `failed`; the ticket says it was cancelled.
    expect(
      statusLine({
        card: card({ status: 'failed' }),
        waiting: 'nobody',
        ticketStatus: 'cancelled',
      }),
    ).toBe('Cancelled: nothing runs. reopen_ticket sends it back to the agent.');
    const stop = card({ status: 'needs_input', input_request: question('timeout', 'Timed out') });
    expect(statusLine({ card: stop, waiting: 'you', handoff: true })).toBe(
      'Waiting on you: a step timed out: "Timed out"',
    );
    const buttons = card({ status: 'needs_input', human_transitions: [button('approve')] });
    expect(statusLine({ card: buttons, waiting: 'you', stateTitle: 'Review' })).toContain(
      'Review: take one of approve',
    );
    expect(
      statusLine({
        card: card(),
        waiting: 'agent',
        stateTitle: 'Implementing',
        minutesInState: 12.4,
      }),
    ).toBe('The agent is working in Implementing (12 min so far).');
    expect(statusLine({ card: card({ status: 'failed' }), waiting: 'nobody' })).toContain(
      'reopen_ticket',
    );
  });
});

const detail = (over: Partial<SessionDetail> = {}): Parameters<typeof statusReport>[0] => ({
  card: {
    title: 'Laser helm sign-off',
    pr_url: 'https://github.com/acme/app/pull/7',
  } as BoardCard,
  context: { planning: { plan: '1. Draft the memo\n2. Send it', summary: 'Draft and send.' } },
  return_to: null,
  moves: [
    { at: '', from: null, to: 'planning', transition: null, reason: null, actor: null },
    {
      at: '',
      from: 'planning',
      to: 'implementing',
      transition: 'plan_ready',
      reason: null,
      actor: null,
    },
  ],
  spend_usd: 1.5,
  recent_output: [
    { session_id: SID, seq: 1, stream: 'assistant', text: 'Writing the memo now.', ts: '' },
    { session_id: SID, seq: 2, stream: 'tool_use', text: 'Edit memo.md', ts: '' },
  ],
  ...over,
});

describe('statusReport', () => {
  it('carries the status, plan summary, plan, moves, PR, spend and last words', () => {
    const r = statusReport(detail(), 'The agent is working in Implementing.');
    expect(r).toContain('Laser helm sign-off: The agent is working in Implementing.');
    expect(r).toContain('Plan summary: Draft and send.');
    expect(r).toContain('Plan: 1. Draft the memo 2. Send it');
    expect(r).toContain('planning → implementing (plan_ready)');
    expect(r).toContain('PR: https://github.com/acme/app/pull/7');
    expect(r).toContain('Spent $1.50.');
    expect(r).toContain('Agent last said: Writing the memo now.');
    expect(r).not.toContain('Edit memo.md');
  });

  it('stays within its cap and keeps the status first', () => {
    const long = 'x'.repeat(5000);
    const r = statusReport(
      detail({
        context: { planning: { plan: long, summary: long } },
        recent_output: [{ session_id: SID, seq: 1, stream: 'assistant', text: long, ts: '' }],
      }),
      'Waiting on you: the agent asks: "Ship it?"',
    );
    expect(r.length).toBeLessThanOrEqual(STATUS_REPORT_MAX);
    expect(r.startsWith('Laser helm sign-off: Waiting on you')).toBe(true);
  });

  it('lastAssistantText keeps the end', () => {
    const chunks = [
      { session_id: SID, seq: 1, stream: 'assistant' as const, text: 'abcdef', ts: '' },
    ];
    expect(lastAssistantText(chunks, 4)).toBe('…def');
    expect(lastAssistantText([])).toBeNull();
  });
});
