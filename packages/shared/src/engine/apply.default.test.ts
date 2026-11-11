/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { freshSnapshot, Harness } from './apply.testkit.js';
import {
  defaultAnswerText,
  defaultCounterKey,
  defaultRuntime,
  defaultTakenOf,
  overruleText,
} from './default-answer.js';
import type { Effect } from './types.js';

// ADR-0041: a question no human answers within `default.after` is answered with the agent's own
// recommended answer, delivered to `return_to` like an answer; a human may overrule it after.

const WORKER = 'c1a0de00-0000-4000-8000-00000000000d';
const REQ = '0d0d0d0d-0000-4000-8000-000000000001';
const REQ2 = '0d0d0d0d-0000-4000-8000-000000000002';
const EIGHT_H = 8 * 3600;

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

const V6 = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v6.json', import.meta.url),
    'utf8',
  ),
) as Record<string, any>;

/** conductor v6 with an 8h default on planning's scope_changed and ask_user. */
function defaultDef(): WorkflowDefinition {
  const raw = structuredClone(V6);
  const d = { after: '8h', answer: '$recommended' };
  raw.states.planning.on.scope_changed.default = d;
  raw.states.planning.on.ask_user.default = d;
  const r = validateWorkflow(raw);
  expect(r.ok ? [] : r.errors).toEqual([]);
  return WorkflowDefinitionSchema.parse(raw);
}

function planning(def = defaultDef()): Harness {
  const snap = freshSnapshot(def);
  snap.ticket = { ...snap.ticket, kind: 'work' };
  const h = new Harness(def, snap).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  return h;
}

const ask = (h: Harness, result: Record<string, string> = { recommended: 'Go with A' }) =>
  h.run({
    type: 'agent.complete_state',
    result,
    transition: 'scope_changed',
    reason: 'A or B?',
  });

/** Fire the armed default (the clock moves to it). */
function fire(h: Harness, request = REQ) {
  const rt = defaultRuntime(h.snap.context);
  if (rt === null) throw new Error('no default armed');
  h.now = new Date(rt.at);
  return h.run({
    type: 'default.fired',
    state: rt.state,
    deadline: rt.at,
    input_request_id: request,
  });
}

describe('default answers (ADR-0041)', () => {
  it('arms the default on the request: answer and time', () => {
    const h = planning();
    const r = ask(h);
    const at = new Date(h.now.getTime() + EIGHT_H * 1000).toISOString();
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'agent_question',
      question: 'A or B?',
      default: { answer: 'Go with A', at },
    });
    expect(defaultRuntime(h.snap.context)).toMatchObject({
      state: 'needs_input',
      return_to: 'planning',
      transition: 'scope_changed',
      recommended: 'Go with A',
      at,
    });
  });

  it('taken: a live parked agent gets the answer by send_input, recorded as default_taken', () => {
    const h = planning();
    ask(h);
    const r = fire(h);
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({ workflow_state: 'planning', status: 'running' });
    expect(find(r.effects, 'send_input')).toEqual({
      type: 'send_input',
      input_request_id: REQ,
      text: defaultAnswerText('Go with A', '8h'),
    });
    expect(find(r.effects, 'state_entered')).toMatchObject({
      from: 'needs_input',
      to: 'planning',
      cause: 'default_taken',
      actor: 'system',
      transition: null,
      reason: 'Go with A',
    });
    expect(find(r.effects, 'default_taken')).toEqual({
      type: 'default_taken',
      state: 'needs_input',
      to: 'planning',
      input_request_id: REQ,
      answer: 'Go with A',
      after: '8h',
    });
    expect(r.snapshot.retry_counters[defaultCounterKey('planning')]).toBe(1);
    expect(defaultRuntime(r.snapshot.context)).toBeNull();
    expect(defaultTakenOf(r.snapshot.context)).toMatchObject({
      input_request_id: REQ,
      state: 'planning',
      answer: 'Go with A',
    });
  });

  it('taken without a live process: a fresh start resumes with the answer', () => {
    const h = planning();
    ask(h);
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    const r = fire(h);
    expect(find(r.effects, 'send_input')).toBeUndefined();
    expect(find(r.effects, 'start_session')).toBeDefined();
    expect(r.snapshot.pending_answer).toEqual({
      input_request_id: REQ,
      answer: defaultAnswerText('Go with A', '8h'),
    });
  });

  it('a human answers first: the default is disarmed and its timer is stale', () => {
    const h = planning();
    ask(h);
    const rt = defaultRuntime(h.snap.context)!;
    h.run({ type: 'input.provided', input_request_id: REQ, answer: 'B' });
    expect(defaultRuntime(h.snap.context)).toBeNull();
    h.now = new Date(rt.at);
    const r = h.run({
      type: 'default.fired',
      state: 'needs_input',
      deadline: rt.at,
      input_request_id: REQ,
    });
    expect(r.ignored).toBe('stale_timer');
  });

  it('no recommended answer: no default on the request, a timer is stale', () => {
    const h = planning();
    const r = ask(h, {});
    expect(find(r.effects, 'create_input_request')?.default).toBeUndefined();
    expect(defaultRuntime(h.snap.context)).toBeNull();
    const fired = h.run({
      type: 'default.fired',
      state: 'needs_input',
      deadline: h.now.toISOString(),
      input_request_id: REQ,
    });
    expect(fired.ignored).toBe('stale_timer');
    // A blank recommendation is no recommendation either.
    expect(
      find(ask(planning(), { recommended: '   ' }).effects, 'create_input_request')?.default,
    ).toBeUndefined();
  });

  it('a transition without default arms nothing, even with a recommended answer', () => {
    const h = planning();
    const r = h.run({
      type: 'agent.complete_state',
      result: { recommended: 'x' },
      transition: 'needs_product_context',
      reason: 'Who is it for?',
    });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')?.default).toBeUndefined();
  });

  it('the ask_user tool: the first single-select option is the recommended answer', () => {
    const h = planning();
    const r = h.run({
      type: 'agent.ask_user',
      question: 'Which?',
      options: {
        multi_select: false,
        items: [{ label: 'Keep it' }, { label: 'Drop it' }],
      },
    });
    expect(find(r.effects, 'create_input_request')?.default?.answer).toBe('Keep it');
    // Multi-select or no options: no default.
    const m = planning().run({
      type: 'agent.ask_user',
      question: 'Which?',
      options: { multi_select: true, items: [{ label: 'a' }, { label: 'b' }] },
    });
    expect(find(m.effects, 'create_input_request')?.default).toBeUndefined();
    const n = planning().run({ type: 'agent.ask_user', question: 'Which?' });
    expect(find(n.effects, 'create_input_request')?.default).toBeUndefined();
  });

  it('complete_state ask_user takes result.recommended', () => {
    const r = planning().run({
      type: 'agent.complete_state',
      result: { recommended: 'Yes' },
      transition: 'ask_user',
      reason: 'Proceed?',
    });
    expect(find(r.effects, 'create_input_request')?.default?.answer).toBe('Yes');
  });

  it('a stale deadline, another state or another visit is stale', () => {
    const h = planning();
    ask(h);
    const rt = defaultRuntime(h.snap.context)!;
    const at = (deadline: string, state = 'needs_input') =>
      h.run({ type: 'default.fired', state, deadline, input_request_id: REQ }).ignored;
    expect(at(new Date(Date.parse(rt.at) + 1000).toISOString())).toBe('stale_timer');
    // A different visit: the runtime says visit 1; pretend the session is on a second one.
    h.snap = { ...h.snap, state_visits: { ...h.snap.state_visits, needs_input: 2 } };
    expect(at(rt.at)).toBe('stale_timer');
  });

  it('bounded: after max_loop_retries defaults from a state, the question waits for a human', () => {
    const h = planning();
    const max = h.def.budget.max_loop_retries;
    for (let i = 0; i < max; i++) {
      ask(h);
      expect(fire(h).ignored).toBeNull();
    }
    const r = ask(h);
    expect(find(r.effects, 'create_input_request')?.default).toBeUndefined();
    expect(defaultRuntime(h.snap.context)).toBeNull();
  });
});

describe('overrule (ADR-0041)', () => {
  it('a live agent gets the correction as a message', () => {
    const h = planning();
    ask(h);
    fire(h);
    const r = h.run({ type: 'human.overrule', input_request_id: REQ, text: 'Use B', actor: 'ui' });
    expect(r.ignored).toBeNull();
    expect(r.effects).toEqual([{ type: 'send_message', text: overruleText('Go with A', 'Use B') }]);
    expect(r.snapshot.workflow_state).toBe('planning');
    // A second correction is allowed.
    expect(
      h.run({ type: 'human.overrule', input_request_id: REQ, text: 'and C', actor: 'ui' }).ignored,
    ).toBeNull();
  });

  it('a queued session gets it after the pending answer', () => {
    const h = planning();
    ask(h);
    h.snap = { ...h.snap, machine_id: null, agent_process_live: false };
    const r0 = fire(h);
    expect(r0.snapshot.status).toBe('queued');
    const r = h.run({ type: 'human.overrule', input_request_id: REQ, text: 'Use B', actor: 'ui' });
    expect(r.ignored).toBeNull();
    expect(r.snapshot.pending_answer?.answer).toBe(
      `${defaultAnswerText('Go with A', '8h')}\n\n${overruleText('Go with A', 'Use B')}`,
    );
  });

  it('refused for another request, before a default, or once the agent moved on', () => {
    const h = planning();
    ask(h);
    const over = (id = REQ) =>
      h.run({ type: 'human.overrule', input_request_id: id, text: 'Use B', actor: 'ui' }).ignored;
    expect(over()).toBe('wrong_status');
    fire(h);
    expect(over(REQ2)).toBe('wrong_status');
    // The agent asks again: the window closes.
    ask(h);
    expect(over()).toBe('wrong_status');
  });
});
