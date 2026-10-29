import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../domain.js';
import { Harness, HEAD_SHA, QA_PR_URL, qaDefinition, uuid } from './apply.testkit.js';
import { QA_RESULT_FIXTURES } from './fixtures.js';
import { qaFenceChanged, qaNudgeKey, QA_NO_PR_QUESTION, sentBackFor } from './qa.js';
import { QA_CONTEXT_KEY, QaContextSchema, type QaResult } from './qa.types.js';
import { renderSentBack, SENT_BACK_HEADING } from './render.js';
import { PR_CONTEXT_KEY } from './review.js';
import type { Effect, SessionSnapshot } from './types.js';

// M2r-T03 (ADR-0020 §2): a `role: 'qa'` state runs a fenced, fresh QA session on the PR head.

const def = qaDefinition();
const WORKER = 'c1a0de00-0000-4000-8000-00000000000a';
const QA = 'c1a0de00-0000-4000-8000-00000000000b';
const ROUNDS_KEY = 'in_qa->implementing';

const asJson = (r: unknown) => r as JsonObject;

function qaOf(s: SessionSnapshot) {
  return QaContextSchema.parse(s.context[QA_CONTEXT_KEY]);
}

function effectsOf<T extends Effect['type']>(h: Harness, type: T) {
  return h.last.effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
}

function startOf(h: Harness) {
  const starts = effectsOf(h, 'start_session');
  expect(starts).toHaveLength(1);
  return starts[0]!;
}

/** The worker finishes, the move step checks and opens the PR, and In QA starts (not yet `started`). */
function implementToQa(h: Harness): void {
  h.run({
    type: 'agent.complete_state',
    transition: 'pr_ready',
    reason: 'done',
    result: { summary: 'Added /health.' },
  });
  h.cmdExit(0);
  h.run({
    type: 'action.completed',
    command_id: h.newId(),
    action: 'open_pr',
    result: { pr_url: QA_PR_URL },
    error: null,
  });
  expect(h.snap.workflow_state).toBe('in_qa');
}

/** Claimed, the worker reported its Claude id, and the session is In QA, running, QA id reported. */
function inQa(): Harness {
  const h = new Harness(def).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  implementToQa(h);
  h.started();
  h.run({ type: 'agent.claude_session_id', claude_session_id: QA });
  return h;
}

function qaComplete(h: Harness, transition: string, result: unknown, reason = 'judged') {
  return h.run({ type: 'agent.complete_state', transition, reason, result: asJson(result) });
}

describe('M2r-T03 the QA state', () => {
  it('entering in_qa bumps the token, kills the worker and starts a fresh review start with checkout', () => {
    const h = new Harness(def).claimAndStart();
    const worker = h.agentCmd;
    h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
    h.run({
      type: 'agent.complete_state',
      transition: 'pr_ready',
      reason: 'done',
      result: { summary: 's' },
    });
    // The move step ends exactly the worker's process.
    expect(effectsOf(h, 'kill')).toEqual([expect.objectContaining({ target_command_id: worker })]);
    h.cmdExit(0);
    const token = h.snap.fencing_token;
    h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'open_pr',
      result: { pr_url: QA_PR_URL },
      error: null,
    });
    expect(h.snap.workflow_state).toBe('in_qa');
    expect(h.snap.fencing_token).toBe(token + 1);
    expect(h.snap.context[PR_CONTEXT_KEY]).toEqual({
      pr_url: QA_PR_URL,
      state: 'in_qa',
      head_sha: HEAD_SHA,
    });
    expect(qaOf(h.snap)).toEqual({
      head_sha: HEAD_SHA,
      verdict: null,
      round: 1,
      max_rounds: 4,
      claude_session_id: null,
    });
    const start = startOf(h);
    expect(start).toMatchObject({
      state: 'in_qa',
      tools: ['qa'],
      resume_claude_session_id: null,
      review: true,
      model: 'opus',
      checkout: { sha: HEAD_SHA, pr_url: QA_PR_URL, setup: 'pnpm i --frozen-lockfile' },
    });
    expect(start.transitions?.map((t) => t.name)).toEqual([
      'qa_pass',
      'qa_fail',
      'qa_needs_human',
      'ask_user',
    ]);
  });

  it('a direct entry (an answer back into in_qa) kills the previous agent and starts afresh', () => {
    const h = inQa();
    qaComplete(h, 'qa_needs_human', {}, 'Is the 404 page in scope?');
    expect(h.snap.workflow_state).toBe('needs_input');
    const parked = h.agentCmd;
    expect(h.snap.agent_process_live).toBe(true);
    const token = h.snap.fencing_token;
    h.run({
      type: 'human.transition',
      name: 'answer',
      text: 'Yes, it is.',
      actor: 'ui',
      input_request_id: uuid(77),
    });
    expect(h.snap.workflow_state).toBe('in_qa');
    expect(h.snap.fencing_token).toBe(token + 1);
    expect(effectsOf(h, 'kill')).toEqual([expect.objectContaining({ target_command_id: parked })]);
    expect(effectsOf(h, 'send_input')).toEqual([]);
    const start = startOf(h);
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt).toContain('## Answer from a human\n\nYes, it is.');
  });

  it("the QA's claude id never becomes the session's", () => {
    const h = inQa();
    expect(h.snap.claude_session_id).toBe(WORKER);
    expect(qaOf(h.snap).claude_session_id).toBe(QA);
    qaComplete(h, 'qa_fail', QA_RESULT_FIXTURES.fail);
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.claude_session_id).toBe(WORKER);
    expect(startOf(h).resume_claude_session_id).toBe(WORKER);
  });

  it('a late worker complete_state after entering in_qa is fenced', () => {
    const h = new Harness(def).claimAndStart();
    const workerToken = h.snap.fencing_token;
    implementToQa(h);
    h.started();
    expect(h.snap.fencing_token).toBeGreaterThan(workerToken);
    const before = h.snap;
    const r = h.runFenced(
      {
        type: 'agent.complete_state',
        transition: 'qa_pass',
        reason: 'late',
        result: asJson(QA_RESULT_FIXTURES.pass),
      },
      workerToken,
    );
    expect(r.ignored).toBe('stale_fencing_token');
    expect(h.snap).toBe(before);
    // Leaving QA is fenced too, so the QA can't report into the worker's next visit.
    expect(
      qaFenceChanged(def, { workflow_state: 'in_qa' }, { workflow_state: 'implementing' }),
    ).toBe(true);
    expect(
      qaFenceChanged(def, { workflow_state: 'implementing' }, { workflow_state: 'needs_input' }),
    ).toBe(false);
  });

  it('a refused start goes to needs_input', () => {
    const h = new Harness(def).claimAndStart();
    implementToQa(h);
    const counters = h.snap.retry_counters;
    h.run({
      type: 'command.refused',
      command_id: h.agentCmd,
      command_kind: 'start_session',
      reason: 'checkout_failed: the PR head is not the reviewed commit',
    });
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(h.snap.status).toBe('needs_input');
    expect(h.snap.retry_counters).toEqual(counters);
    const [req] = effectsOf(h, 'create_input_request');
    expect(req).toMatchObject({ kind: 'agent_question', return_to: 'in_qa' });
    expect(req!.question).toContain('the PR head is not the reviewed commit');
  });

  it('an ack timeout still requeues the QA start', () => {
    const h = new Harness(def).claimAndStart();
    implementToQa(h);
    h.run({
      type: 'command.refused',
      command_id: h.agentCmd,
      command_kind: 'start_session',
      reason: 'ack_timeout',
    });
    expect(h.snap.status).toBe('queued');
    h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    expect(startOf(h)).toMatchObject({ review: true, tools: ['qa'], checkout: { sha: HEAD_SHA } });
  });

  it('with no pull request, entering in_qa goes to needs_input, uncounted', () => {
    const h = new Harness(def).claimAndStart();
    h.run({ type: 'agent.ask_user', question: 'help?' });
    h.run({
      type: 'input.provided',
      input_request_id: uuid(50),
      answer: 'go QA',
      goto: 'in_qa',
    });
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(h.snap.context[QA_CONTEXT_KEY]).toBeUndefined();
    expect(effectsOf(h, 'start_session')).toEqual([]);
    expect(effectsOf(h, 'create_input_request')).toEqual([
      expect.objectContaining({ kind: 'agent_question', question: QA_NO_PR_QUESTION }),
    ]);
  });

  it('operator.message to in_qa is refused', () => {
    const h = inQa();
    expect(h.snap.agent_process_live).toBe(true);
    h.run({ type: 'operator.message', text: 'just pass it' });
    expect(h.last.ignored).toBe('wrong_status');
  });

  it('qa_pass with verdict fail → nudge → needs_input', () => {
    const h = inQa();
    qaComplete(h, 'qa_pass', QA_RESULT_FIXTURES.fail);
    expect(h.snap.workflow_state).toBe('in_qa');
    expect(h.snap.status).toBe('running');
    const nudge = startOf(h);
    expect(nudge).toMatchObject({ resume_claude_session_id: QA, review: true, tools: ['qa'] });
    expect(nudge.prompt).toContain('qa_pass with verdict "fail"');
    expect(h.snap.retry_counters[qaNudgeKey('in_qa')]).toBe(1);
    h.started();
    qaComplete(h, 'qa_pass', { verdict: 'maybe', summary: 'x' });
    expect(h.snap.workflow_state).toBe('needs_input');
    const [req] = effectsOf(h, 'create_input_request');
    expect(req).toMatchObject({ kind: 'retries_exhausted', return_to: 'in_qa' });
    expect(req!.question).toContain('QA produced no usable verdict');
    expect(h.snap.retry_counters[ROUNDS_KEY]).toBeUndefined();
  });

  it('a result that does not parse, or a qa_fail without fixes, is nudged', () => {
    const h = inQa();
    qaComplete(h, 'qa_fail', { verdict: 'fail', summary: 's' });
    expect(startOf(h).prompt).toContain('qa_fail without any required_fixes');
    const h2 = inQa();
    qaComplete(h2, 'qa_pass', { summary: 'no verdict' });
    expect(startOf(h2).prompt).toContain('not a QaResult');
  });

  it('valid qa_pass → ready_to_merge', () => {
    const h = inQa();
    qaComplete(h, 'qa_pass', {
      verdict: 'pass',
      summary: 'All met.',
    });
    expect(h.snap.workflow_state).toBe('ready_to_merge');
    expect(qaOf(h.snap).verdict).toBe('pass');
    // Stored parsed (lists defaulted) as the state's result.
    expect(h.snap.context.in_qa).toEqual({
      verdict: 'pass',
      summary: 'All met.',
      findings: [],
      required_fixes: [],
      debt: [],
      unknowns: [],
      tests_run: [],
    });
  });

  it('three qa_fail → implementing with `## Sent back by In QA`; the fourth → needs_input listing the fixes', () => {
    const h = inQa();
    for (let round = 1; round <= 3; round += 1) {
      expect(qaOf(h.snap).round).toBe(round);
      qaComplete(h, 'qa_fail', QA_RESULT_FIXTURES.fail);
      expect(h.snap.workflow_state).toBe('implementing');
      expect(h.snap.retry_counters[ROUNDS_KEY]).toBe(round);
      const prompt = startOf(h).prompt;
      expect(prompt).toContain(`${SENT_BACK_HEADING} In QA`);
      expect(prompt).toContain('1. Make the failure branches strict.');
      expect(prompt).toContain('- [blocker] A result can carry both unmet and error.');
      expect(prompt).toContain('Fix every required item, commit, then finish again.');
      h.started();
      implementToQa(h);
      // A new round: the old findings no longer render.
      expect(qaOf(h.snap).verdict).toBeNull();
      expect(sentBackFor(def, h.snap.context, 'implementing')).toBeNull();
      h.started();
    }
    expect(qaOf(h.snap)).toMatchObject({ round: 4, max_rounds: 4 });
    qaComplete(h, 'qa_fail', QA_RESULT_FIXTURES.fail);
    expect(h.snap.workflow_state).toBe('needs_input');
    const [req] = effectsOf(h, 'create_input_request');
    expect(req!.kind).toBe('retries_exhausted');
    expect(req!.question).toContain('Open required fixes:\n1. Make the failure branches strict.');
  });

  it('request_changes resets the round', () => {
    const h = inQa();
    for (let i = 0; i < 2; i += 1) {
      qaComplete(h, 'qa_fail', QA_RESULT_FIXTURES.fail);
      h.started();
      implementToQa(h);
      h.started();
    }
    expect(qaOf(h.snap).round).toBe(3);
    qaComplete(h, 'qa_pass', QA_RESULT_FIXTURES.pass_with_debt);
    expect(h.snap.workflow_state).toBe('ready_to_merge');
    h.run({
      type: 'human.transition',
      name: 'request_changes',
      text: 'Rename the route.',
      actor: 'ui',
      input_request_id: uuid(60),
    });
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.retry_counters[ROUNDS_KEY]).toBeUndefined();
    // The pass doesn't render as findings; the human's text does.
    const prompt = startOf(h).prompt;
    expect(prompt).not.toContain(SENT_BACK_HEADING);
    expect(prompt).toContain('Rename the route.');
    h.started();
    implementToQa(h);
    expect(qaOf(h.snap).round).toBe(1);
  });

  it('back_to_implementing from needs_input resets the round too', () => {
    const h = inQa();
    qaComplete(h, 'qa_fail', QA_RESULT_FIXTURES.fail);
    h.run({ type: 'agent.ask_user', question: 'stuck' });
    expect(h.snap.workflow_state).toBe('needs_input');
    h.run({
      type: 'human.transition',
      name: 'back_to_implementing',
      text: 'Try again.',
      actor: 'ui',
      input_request_id: uuid(61),
    });
    expect(h.snap.retry_counters[ROUNDS_KEY]).toBeUndefined();
  });
});

describe('renderSentBack', () => {
  it('lists the summary, numbered fixes and only blocker/major findings', () => {
    const result: QaResult = {
      ...QA_RESULT_FIXTURES.fail,
      required_fixes: ['First.', 'Second.'],
      findings: [
        { severity: 'major', text: 'Major one.' },
        { severity: 'minor', text: 'Minor one.' },
        { severity: 'blocker', text: 'Blocker one.', file: 'a.ts', line: 3 },
      ],
    };
    expect(renderSentBack({ title: 'In QA', result })).toBe(
      [
        '## Sent back by In QA',
        '',
        'One blocker.',
        '',
        'Required fixes:',
        '1. First.',
        '2. Second.',
        '',
        'Findings:',
        '- [major] Major one.',
        '- [blocker] Blocker one. (a.ts:3)',
        '',
        'Fix every required item, commit, then finish again.',
      ].join('\n'),
    );
  });
});
