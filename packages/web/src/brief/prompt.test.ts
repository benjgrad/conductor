import {
  renderPrompt,
  SNAPSHOT_FIXTURE,
  TICKET_TEMPLATE,
  type AgentState,
  type OutputChunk,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { initialPrompt, ticketBodyFromPrompt } from './prompt.js';
import { UX2_TICKET_BODY } from './ux2-ticket.js';

const STATE = {
  type: 'agent',
  prompt: TICKET_TEMPLATE,
  on: { done: 'end' },
} as unknown as AgentState;

function prompt(body: string, external_ref: string | null = null) {
  return renderPrompt({
    stateName: 'implement',
    state: STATE,
    snapshot: {
      ticket: { ...SNAPSHOT_FIXTURE.ticket, body, external_ref },
      context: {},
    },
  });
}

const { title, repo } = SNAPSHOT_FIXTURE.ticket;

describe('ticketBodyFromPrompt (the engine-rendered prompt)', () => {
  it('round-trips a sectioned body', () => {
    expect(ticketBodyFromPrompt(prompt(UX2_TICKET_BODY), title, repo)).toBe(UX2_TICKET_BODY.trim());
  });

  it('with an external reference', () => {
    expect(ticketBodyFromPrompt(prompt('Do it.', 'JIRA-1'), title, repo)).toBe('Do it.');
  });

  it('a body that mentions another Repository: line is kept whole', () => {
    const body = 'Clone it.\n\nRepository: github.com/elsewhere/x\n\nThen build.';
    expect(ticketBodyFromPrompt(prompt(body), title, repo)).toBe(body);
  });

  it('(no description) is an empty body', () => {
    expect(ticketBodyFromPrompt(prompt(''), title, repo)).toBe('');
  });

  it('another title or a non-ticket prompt → null', () => {
    expect(ticketBodyFromPrompt(prompt('x'), 'Other', repo)).toBeNull();
    expect(ticketBodyFromPrompt('Run the review skill.', title, repo)).toBeNull();
  });
});

describe('initialPrompt', () => {
  const chunk = (stream: OutputChunk['stream'], text: string, seq: number): OutputChunk => ({
    session_id: SNAPSHOT_FIXTURE.id,
    seq,
    stream,
    text,
    ts: '2026-10-27T10:00:00.000Z',
  });

  it('prefers the ticket prompt over an earlier human message', () => {
    const p = prompt('x');
    expect(
      initialPrompt([chunk('assistant', 'hi', 0), chunk('user', 'hello', 1), chunk('user', p, 2)]),
    ).toBe(p);
  });

  it('falls back to the first user chunk, else null', () => {
    expect(initialPrompt([chunk('user', 'Run it', 0), chunk('user', 'later', 1)])).toBe('Run it');
    expect(initialPrompt([chunk('assistant', 'hi', 0)])).toBeNull();
  });
});
