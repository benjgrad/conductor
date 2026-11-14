import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import {
  HANDOFF_SUMMARY_MAX,
  handoffBrief,
  lastAssistantText,
  type HandoffBriefInput,
} from './handoff.js';
import type { InputRequestDto, MoveDto } from './rest.js';

const SID = '00000000-0000-4000-8000-000000000001';

const WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  id: 'conductor',
  version: 1,
  start: 'implementing',
  budget: { usd: 5, minutes: 240, max_loop_retries: 3 },
  states: {
    implementing: {
      type: 'agent',
      prompt: 'implement_template',
      on: {
        done: 'in_review',
        ask_user: 'needs_input',
        scope_changed: { goto: 'needs_input', title: 'Scope changed', question: true },
      },
    },
    in_review: {
      type: 'human',
      title: 'In review',
      on: { done: { goto: 'done', actor: 'human' } },
    },
    needs_input: { type: 'human', title: 'Needs input' },
    done: { type: 'terminal' },
  },
});

const req = (
  kind: InputRequestDto['kind'],
  question: string,
  over: Partial<InputRequestDto> = {},
): InputRequestDto => ({
  id: '00000000-0000-4000-8000-000000000002',
  session_id: SID,
  kind,
  question,
  created_at: '2026-11-03T10:00:00.000Z',
  answer: null,
  answered_by: null,
  answered_at: null,
  ...over,
});

const move = (over: Partial<MoveDto>): MoveDto => ({
  at: '',
  from: 'implementing',
  to: 'needs_input',
  transition: null,
  reason: null,
  actor: 'system',
  ...over,
});

const START = move({ from: null, to: 'implementing', actor: null, cause: 'start' });

function input(over: Partial<HandoffBriefInput> = {}): HandoffBriefInput {
  return {
    card: { workflow_state: 'needs_input', pr_url: null } as HandoffBriefInput['card'],
    pending_input: null,
    context: {},
    return_to: 'implementing',
    recent_output: [],
    workflow: WORKFLOW as HandoffBriefInput['workflow'],
    moves: [START],
    ...over,
  };
}

const TECHNICAL = /exit code|Last output|Retry, skip, or abort|stderr|SIGKILL/;

describe('handoffBrief', () => {
  it('is null while nothing is handed off (an agent state, no request)', () => {
    expect(
      handoffBrief(input({ card: { workflow_state: 'implementing', pr_url: null } as never })),
    ).toBeNull();
  });

  it('a hand-off: finished, PR open; the summary is not the question repeated', () => {
    const text = 'Added /health. Look at the route first.';
    const b = handoffBrief(
      input({
        card: { workflow_state: 'in_review', pr_url: 'https://github.com/a/b/pull/1' } as never,
        pending_input: req('handoff', text, { origin_transition: 'pr_ready_for_review' }),
        moves: [
          START,
          move({
            to: 'in_review',
            transition: 'pr_ready_for_review',
            reason: text,
            actor: 'agent',
          }),
        ],
        recent_output: [
          { session_id: SID, seq: 1, stream: 'assistant', text: 'All done, tests green.', ts: '' },
        ],
      }),
    );
    expect(b).toEqual({
      why: 'The work is finished and its pull request is open for your review.',
      summary: 'All done, tests green.',
    });
  });

  it('a plan approval', () => {
    const b = handoffBrief(
      input({
        return_to: 'planning',
        context: { planning: { plan: 'P', summary: 'Rename the column in three steps.' } },
        pending_input: req('agent_question', 'Drops a column: OK?', {
          origin_transition: 'plan_needs_approval',
        }),
      }),
    );
    expect(b).toEqual({
      why: 'The plan needs your approval before implementation starts.',
      summary: 'Rename the column in three steps.',
    });
  });

  it('a question names its transition unless it is ask_user', () => {
    const q = (origin: string) =>
      handoffBrief(
        input({ pending_input: req('agent_question', 'Which?', { origin_transition: origin }) }),
      )?.why;
    expect(q('ask_user')).toBe('The agent stopped to ask you a question.');
    expect(q('scope_changed')).toBe('The agent stopped to ask you something ("Scope changed").');
  });

  it('retries exhausted after a gate: the tries and the item, not the output', () => {
    const question =
      'Requirements to take "pr" were not met after 4 attempts (retry limit 3):\n- Tests pass: `npm test` failed (exit code 1)\n\nLast output of "Tests pass":\nFAIL x\n\nRetry, skip, or abort?';
    const b = handoffBrief(
      input({
        pending_input: req('retries_exhausted', question),
        moves: [
          START,
          move({
            to: 'implementing → in_review (move: pr)',
            transition: 'pr',
            reason: 'Added the route.',
            actor: 'agent',
          }),
          move({
            from: 'implementing → in_review (move: pr)',
            cause: 'retries_exhausted',
            transition: 'pr',
            reason: 'Tests pass (retry limit 3)',
          }),
        ],
      }),
    );
    expect(b).toEqual({
      why: 'It kept failing and conductor stopped after 3 tries: Tests pass.',
      summary: 'Added the route.',
    });
  });

  it('an agent that exited: no stderr in the reason', () => {
    const b = handoffBrief(
      input({
        pending_input: req(
          'retries_exhausted',
          '"implementing" failed (the agent exited (exit code 1: boom)). Retry, skip, or abort?',
        ),
        moves: [
          START,
          move({
            cause: 'fallback',
            transition: 'fail',
            reason: 'the agent exited (exit code 1: boom) without calling complete_state',
          }),
        ],
        recent_output: [
          { session_id: SID, seq: 1, stream: 'assistant', text: 'Fixing the parser.', ts: '' },
        ],
      }),
    );
    expect(b?.why).toBe(
      'The agent stopped before it finished: its process exited without reporting back.',
    );
    expect(b?.summary).toBe('Fixing the parser.');
  });

  it.each([
    ['condition_timeout', 'timeout', "weren't met in time"],
    ['action_failed', 'retries_exhausted', 'could not finish a step'],
    ['timeout', 'timeout', 'past its time limit'],
  ] as const)('cause %s reads plainly', (cause, kind, text) => {
    const b = handoffBrief(
      input({
        pending_input: req(kind, 'Technical text. exit code 2. Retry, skip, or abort?'),
        moves: [START, move({ cause, reason: 'x (exit code 2)' })],
      }),
    );
    expect(b?.why).toContain(text);
    expect(b?.why).not.toMatch(TECHNICAL);
  });

  it('budget, lost machine and check config', () => {
    const why = (r: InputRequestDto) => handoffBrief(input({ pending_input: r }))?.why;
    expect(
      why(
        req(
          'budget_exceeded',
          'Budget exceeded in "implementing": spent $5.10 of $5.00. Choose "Raise", or "Stop".',
        ),
      ),
    ).toBe('It ran out of budget (spent $5.10 of $5.00), so conductor paused it.');
    expect(
      why(req('machine_lost', "Ben's MacBook went offline. It resumes when it is back.")),
    ).toBe("The machine running it stopped responding: Ben's MacBook went offline.");
    expect(why(req('check_config', 'Setup failed'))).toContain("isn't this branch's fault");
  });

  it('a human state with no request', () => {
    const b = handoffBrief(input({ card: { workflow_state: 'in_review', pr_url: null } as never }));
    expect(b?.why).toBe('It is waiting in "In review" for you to take the next step.');
    expect(b?.summary).toBeNull();
  });

  it('ignores agent reasons from an earlier visit; clips the summary', () => {
    const b = handoffBrief(
      input({
        pending_input: req('timeout', 'x'),
        moves: [
          move({ from: null, to: 'implementing', reason: 'old visit', actor: 'agent' }),
          move({ from: 'needs_input', to: 'implementing', actor: 'human', cause: 'answer_routed' }),
          move({ cause: 'timeout' }),
        ],
        recent_output: [
          { session_id: SID, seq: 1, stream: 'assistant', text: 'y'.repeat(2000), ts: '' },
        ],
      }),
    );
    expect(b?.summary).not.toBe('old visit');
    expect(b!.summary!.length).toBeLessThanOrEqual(HANDOFF_SUMMARY_MAX);
  });

  it('lastAssistantText keeps the end of the assistant stream only', () => {
    expect(
      lastAssistantText(
        [
          { session_id: SID, seq: 1, stream: 'assistant', text: 'abcdef', ts: '' },
          { session_id: SID, seq: 2, stream: 'tool_use', text: 'Edit', ts: '' },
        ],
        4,
      ),
    ).toBe('…def');
  });
});
