/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- raw definition edits in tests */
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT, CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import {
  WorkflowDefinitionSchema,
  type TicketKind,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { agentTransitionOptions } from '../workflow/transition-rules.js';
import { freshSnapshot, Harness, HEAD_SHA, referenceWorkflow, uuid } from './apply.testkit.js';
import { HOW_TO_FINISH_HEADING, WORK_REPOSITORY_HEADING } from './render.js';
import { PR_CONTEXT_KEY } from './review.js';
import {
  moveCounterKey,
  moveStateLabel,
  unknownTransitionQuestion,
  type Effect,
  type EngineEvent,
} from './types.js';

// ADR-0011 (M1b-T03): agents and humans take named transitions; `requires` runs as a move step.
// Against the T01 draft of conductor v2 (workflow/fixtures.ts).

const WORKER = 'c1a0de00-0000-4000-8000-00000000000a';
const PR = 'https://github.com/benjgrad/fixture-app/pull/7';
const REQ = uuid(4242);

const types = (effects: Effect[]) => effects.map((e) => e.type);
const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

/** conductor v2 (draft) with `mutate` applied to the raw definition. */
function v2With(mutate: (raw: Record<string, any>) => void): WorkflowDefinition {
  const raw = structuredClone(CONDUCTOR_V2_DRAFT) as Record<string, any>;
  mutate(raw);
  return WorkflowDefinitionSchema.parse(raw);
}

/** v2 without the conditions on ready_for_testing (the conditions phase is M1b-T08's). */
const V2_NO_CONDITIONS = v2With((raw) => {
  const t: Record<string, any> = raw.states.implementing.on.ready_for_testing;
  delete t.requires.conditions;
  delete t.requires.condition_timeout;
  delete t.requires.condition_poll;
});

/** A ticket of `kind`, claimed and running in `planning`. */
function planning(kind: TicketKind | null, def = CONDUCTOR_V2_DRAFT_DEF): Harness {
  const snap = freshSnapshot(def);
  snap.ticket = { ...snap.ticket, kind };
  const h = new Harness(def, snap).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  return h;
}

function take(
  h: Harness,
  transition: string | null,
  reason: string | null = 'because',
  result: Record<string, string> = {},
) {
  const e: EngineEvent = { type: 'agent.complete_state', result, transition, reason };
  return h.run(e);
}

/** Planned (plan_ready) and running in `implementing`. */
function implementing(kind: TicketKind | null, def = CONDUCTOR_V2_DRAFT_DEF): Harness {
  const h = planning(kind, def);
  take(h, 'plan_ready', 'The plan is complete.', { plan: '1. add /health', summary: 'plan' });
  expect(h.snap.workflow_state).toBe('implementing');
  h.started();
  return h;
}

/** Parked in needs_input after planning asked `scope_changed`. */
function parked(kind: TicketKind | null = 'work'): Harness {
  const h = planning(kind);
  take(h, 'scope_changed', 'Include the DB migration, or split it out?');
  expect(h.snap).toMatchObject({ workflow_state: 'needs_input', status: 'needs_input' });
  return h;
}

const human = (h: Harness, name: string, text: string | null = null) =>
  h.run({ type: 'human.transition', name, text, actor: 'ui', input_request_id: REQ });

const action = (h: Harness, result: Record<string, string> | null, error: string | null = null) =>
  h.run({ type: 'action.completed', command_id: h.newId(), action: 'open_pr', result, error });

describe('agent transitions (conductor v2)', () => {
  it('plan_ready is taken by name: implementing starts, the move is recorded', () => {
    const h = planning('work');
    const r = take(h, 'plan_ready', 'The plan is complete.', { plan: 'P', summary: 's' });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      status: 'running',
      context: { planning: { plan: 'P', summary: 's' } },
      retry_counters: {}, // a plain forward move: no failure-loop counter
    });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: 'planning',
      to: 'implementing',
      visit: 1,
      transition: 'plan_ready',
      reason: 'The plan is complete.',
      actor: 'agent',
    });
    const start = find(r.effects, 'start_session')!;
    expect(start.transitions).toEqual(
      agentTransitionOptions(CONDUCTOR_V2_DRAFT_DEF, 'implementing', 'work'),
    );
    expect(start.transitions?.map((t) => t.name)).toEqual([
      'needs_approval_to_message',
      'pr_ready_for_review',
      'ready_for_testing',
      'ask_user',
    ]);
  });

  it('plan_ready still checks the result keys (a non-question transition)', () => {
    const h = planning('work');
    const r = take(h, 'plan_ready', 'done', { summary: 's' });
    expect(r.snapshot.workflow_state).toBe('needs_input'); // fail → no fail mapping → fallback
    expect(find(r.effects, 'create_input_request')?.question).toContain(
      'complete_state result is missing plan',
    );
  });

  it.each(['scope_changed', 'plan_needs_approval', 'needs_product_context', 'impossible'])(
    'planning %s → needs_input, the reason is the question (no result keys needed)',
    (name) => {
      const h = planning('personal');
      const r = take(h, name, `Question for ${name}?`);
      expect(r.snapshot).toMatchObject({
        workflow_state: 'needs_input',
        status: 'needs_input',
        return_to: 'planning',
      });
      expect(find(r.effects, 'create_input_request')).toEqual({
        type: 'create_input_request',
        kind: 'agent_question',
        question: `Question for ${name}?`,
        return_to: 'planning',
      });
      expect(find(r.effects, 'state_entered')).toMatchObject({
        transition: name,
        reason: `Question for ${name}?`,
        actor: 'agent',
      });
    },
  );

  it('plan_needs_approval stores its result as context.planning (the plan to approve)', () => {
    const h = planning('work');
    const before = { ...h.snap.context };
    const r = take(h, 'plan_needs_approval', 'Approve this plan?', {
      plan: '1. add /health\n2. test it',
      summary: 'health endpoint',
    });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(r.snapshot.context).toEqual({
      ...before,
      planning: { plan: '1. add /health\n2. test it', summary: 'health endpoint' },
    });
  });

  it('a question with an empty result leaves the context alone; a partial one is kept as is', () => {
    const h = planning('work');
    const before = structuredClone(h.snap.context);
    const r = take(h, 'scope_changed', 'Split it?', {});
    expect(r.snapshot.context).toEqual(before);
    // No result-key check on a question: `summary` alone is fine and stored.
    const h2 = planning('work');
    const r2 = take(h2, 'plan_needs_approval', 'Approve?', { summary: 'only a summary' });
    expect(r2.snapshot.workflow_state).toBe('needs_input');
    expect(find(r2.effects, 'create_input_request')?.kind).toBe('agent_question');
    expect((r2.snapshot.context as Record<string, unknown>).planning).toEqual({
      summary: 'only a summary',
    });
  });

  it('a question transition without a reason still asks something', () => {
    const r = take(planning('work'), 'scope_changed', null);
    expect(find(r.effects, 'create_input_request')?.question).toBe(
      'The agent chose "Scope changed" without saying why.',
    );
  });

  it('implementing needs_approval_to_message → needs_input with the reason as the question', () => {
    const h = implementing('work');
    const r = take(h, 'needs_approval_to_message', 'May I post "deployed" in #team?');
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', return_to: 'implementing' });
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'agent_question',
      question: 'May I post "deployed" in #team?',
    });
  });

  it('pr_ready_for_review runs its requires (test check, open_pr), then asks the question', () => {
    const h = implementing('work');
    const label = moveStateLabel('implementing', 'needs_input', 'pr_ready_for_review');
    let r = take(h, 'pr_ready_for_review', 'Please review the PR.', { summary: 'added /health' });
    expect(r.snapshot).toMatchObject({
      workflow_state: label,
      status: 'running',
      step: {
        kind: 'move',
        transition: 'pr_ready_for_review',
        actor: 'agent',
        reason: 'Please review the PR.',
        phase: 'checks',
      },
    });
    expect(find(r.effects, 'run_cmd')).toMatchObject({ cmd: 'npm test', require_clean: true });
    r = h.cmdExit(0);
    expect(find(r.effects, 'run_action')).toMatchObject({
      action: 'open_pr',
      expected_sha: HEAD_SHA,
      idempotency_key: `${h.snap.id}:${label}:1`,
    });
    r = action(h, { pr_url: PR });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implementing',
      context: { [PR_CONTEXT_KEY]: { pr_url: PR, state: 'needs_input' } },
    });
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'agent_question',
      question: 'Please review the PR.',
    });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: label,
      to: 'needs_input',
      visit: 1,
      transition: 'pr_ready_for_review',
      reason: 'Please review the PR.',
      actor: 'agent',
    });
  });

  it('ready_for_testing (work) starts its move step; done (personal) starts its own', () => {
    const work = implementing('work');
    let r = take(work, 'ready_for_testing', 'Ready.', { summary: 's' });
    expect(r.snapshot.workflow_state).toBe(
      moveStateLabel('implementing', 'waiting_external', 'ready_for_testing'),
    );
    expect(find(r.effects, 'run_cmd')).toMatchObject({ cmd: 'npm run build' });
    const personal = implementing('personal');
    r = take(personal, 'done', 'Finished.', { summary: 's' });
    expect(r.snapshot.workflow_state).toBe(moveStateLabel('implementing', 'done', 'done'));
  });

  it('a work-only transition named on a personal ticket → needs_input (transition_not_allowed)', () => {
    const h = implementing('personal');
    const r = take(h, 'ready_for_testing', 'Ready.', { summary: 's' });
    expect(r.ignored).toBeNull(); // routed, not ignored: ignoring would change nothing
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implementing',
    });
    expect(find(r.effects, 'create_input_request')).toEqual({
      type: 'create_input_request',
      kind: 'agent_question',
      question: `${unknownTransitionQuestion('ready_for_testing')}\n\nIts reason: Ready.`,
      return_to: 'implementing',
    });
    expect(find(r.effects, 'state_entered')).not.toHaveProperty('transition');
  });

  it('a personal-only transition on a work ticket, an unknown name and a system name are routed too', () => {
    for (const [kind, name] of [
      ['work', 'done'],
      ['work', 'nope'],
      ['personal', 'timeout'],
    ] as const) {
      const h = implementing(kind);
      const r = take(h, name, null, { summary: 's' });
      expect(find(r.effects, 'create_input_request')?.question).toBe(
        unknownTransitionQuestion(name),
      );
    }
  });

  it('a null kind matches every transition (U-062)', () => {
    const h = implementing(null);
    take(h, 'ready_for_testing', 'Ready.', { summary: 's' });
    expect(h.snap.step?.transition).toBe('ready_for_testing');
    const p = implementing(null);
    take(p, 'done', 'Finished.', { summary: 's' });
    expect(p.snap.step?.transition).toBe('done');
  });

  it('a null transition means done: taken where allowed (personal), routed where not (work)', () => {
    const personal = implementing('personal');
    let r = take(personal, null, null, { summary: 's' });
    expect(r.snapshot.step).toMatchObject({ kind: 'move', transition: 'done' });
    const work = implementing('work');
    r = take(work, null, null, { summary: 's' });
    expect(find(r.effects, 'create_input_request')?.question).toBe(
      unknownTransitionQuestion('done'),
    );
  });

  it('ask_user named as a transition asks the reason', () => {
    const r = take(planning('work'), 'ask_user', 'Which port?');
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'agent_question',
      question: 'Which port?',
    });
    expect(find(r.effects, 'state_entered')).toMatchObject({ transition: 'ask_user' });
  });

  it('old versions: an unnamed done keeps the M1 record and prompt; no transitions list', () => {
    const def = referenceWorkflow('m1_basic');
    const h = new Harness(def).claimAndStart();
    const start = find(h.last.effects, 'start_session');
    // claimAndStart's last apply is `started`; the claim emitted the start
    expect(start).toBeUndefined();
    const fresh = new Harness(def);
    const claim = fresh.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    const s = find(claim.effects, 'start_session')!;
    expect(s.transitions).toBeUndefined();
    expect(s.prompt).toContain('## When you are done');
    expect(s.prompt).not.toContain(HOW_TO_FINISH_HEADING);
    const r = h.complete({ summary: 's' });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: 'implement',
      to: 'build',
      visit: 1,
    });
    // a named `done` on an old version is a recorded transition
    const n = new Harness(def).claimAndStart();
    const named = take(n, 'done', 'all good', { summary: 's' });
    expect(find(named.effects, 'state_entered')).toMatchObject({
      to: 'build',
      transition: 'done',
      actor: 'agent',
    });
  });

  it('a transition named during a gate step is ignored: the step judges', () => {
    const h = implementing('work');
    take(h, 'ready_for_testing', 'Ready.', { summary: 's' });
    const r = take(h, 'pr_ready_for_review', 'x');
    expect(r.ignored).toBe('unexpected_event');
  });
});

describe('human transitions (conductor v2)', () => {
  it('waiting_on_someone from needs_input enters waiting_external with the text as the reason', () => {
    const h = parked();
    h.advance(600);
    const r = human(h, 'waiting_on_someone', 'Dana is reviewing the API shape.');
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'waiting_external',
      status: 'waiting_external',
      return_to: null,
      pending_answer: null,
    });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: 'needs_input',
      to: 'waiting_external',
      visit: 1,
      transition: 'waiting_on_someone',
      reason: 'Dana is reviewing the API shape.',
      actor: 'human',
    });
    expect(r.snapshot.wall_seconds).toBe(h.snap.wall_seconds); // parked time doesn't count
  });

  it('answer ($return_to) resumes the asking agent with the text as the pending answer', () => {
    const h = parked();
    // the agent's process ended after complete_state
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    const r = human(h, 'answer', 'Split it out.');
    expect(r.snapshot).toMatchObject({
      workflow_state: 'planning',
      status: 'running',
      pending_answer: { input_request_id: REQ, answer: 'Split it out.' },
    });
    expect(find(r.effects, 'start_session')).toMatchObject({
      state: 'planning',
      prompt: 'Split it out.', // a resume's prompt is the bare answer (§Pending answer)
      resume_claude_session_id: WORKER,
    });
    expect(find(r.effects, 'state_entered')).toMatchObject({
      from: 'needs_input',
      to: 'planning',
      transition: 'answer',
      reason: 'Split it out.',
      actor: 'human',
    });
    // the agent runs on it: cleared on its `started`
    expect(h.started().snapshot.pending_answer).toBeNull();
  });

  it('answer to a live parked agent goes to its stdin (send_input)', () => {
    const h = parked();
    expect(h.snap.agent_process_live).toBe(true);
    const r = human(h, 'answer', 'Split it out.');
    expect(types(r.effects)).toContain('send_input');
    expect(find(r.effects, 'send_input')).toEqual({
      type: 'send_input',
      input_request_id: REQ,
      text: 'Split it out.',
    });
    expect(find(r.effects, 'start_session')).toBeUndefined();
  });

  it('done from needs_input finishes the ticket', () => {
    const r = human(parked(), 'done', null);
    expect(r.snapshot).toMatchObject({ workflow_state: 'done', status: 'done' });
    expect(find(r.effects, 'ticket_status')).toEqual({ type: 'ticket_status', to: 'done' });
  });

  it('back_to_implementing from waiting_external: the text reaches the agent', () => {
    const h = parked();
    human(h, 'waiting_on_someone', 'Dana');
    const r = human(h, 'back_to_implementing', 'Dana says: use v2 of the API.');
    expect(r.snapshot).toMatchObject({ workflow_state: 'implementing', status: 'running' });
    const start = find(r.effects, 'start_session')!;
    expect(start.prompt).toContain('## Your step: implementing');
    expect(start.prompt).toContain('## Answer from a human\n\nDana says: use v2 of the API.');
    // planning never produced its plan: the prompt says so (T02 rule 5, lead decision)
    expect(start.prompt).toContain(
      "- `plan`: not produced (a person moved this ticket here directly). Work out what's needed from the ticket.",
    );
    expect(start.prompt).not.toContain('before changing code');
  });

  it('refusals: unknown, not human-actor, wrong status, during a step', () => {
    const h = parked();
    expect(human(h, 'nope').ignored).toBe('unknown_transition');
    human(h, 'waiting_on_someone', 'x');
    // ui.approve is a system transition of the event state
    expect(human(h, 'ui.approve').ignored).toBe('transition_not_allowed');
    const running = planning('work');
    expect(human(running, 'answer', 'x').ignored).toBe('wrong_status');
    const stepping = implementing('work');
    take(stepping, 'ready_for_testing', 'r', { summary: 's' });
    expect(human(stepping, 'done').ignored).toBe('wrong_status');
  });

  it('the kind filter applies to human transitions', () => {
    const def = v2With((raw) => {
      raw.states.needs_input.on.done.kinds = ['personal'];
    });
    const snap = freshSnapshot(def);
    snap.ticket = { ...snap.ticket, kind: 'work' };
    const h = new Harness(def, snap).claimAndStart();
    take(h, 'scope_changed', 'q?');
    expect(human(h, 'done').ignored).toBe('transition_not_allowed');
  });

  it('a human move with requires runs them first ("skip to" runs requirements too)', () => {
    const def = v2With((raw) => {
      raw.states.needs_input.on.done = {
        goto: 'done',
        actor: 'human',
        requires: { checks: [{ name: 'Tests pass', cmd: 'npm test' }] },
        on_unmet: { goto: 'implementing', retries: 1, else: 'needs_input' },
      };
    });
    const snap = freshSnapshot(def);
    snap.ticket = { ...snap.ticket, kind: 'work' };
    const h = new Harness(def, snap).claimAndStart();
    take(h, 'scope_changed', 'q?');
    let r = human(h, 'done', 'ship it');
    expect(r.snapshot).toMatchObject({
      workflow_state: moveStateLabel('needs_input', 'done', 'done'),
      status: 'running',
      step: { kind: 'move', actor: 'human', reason: 'ship it', phase: 'checks' },
    });
    r = h.cmdExit(0);
    expect(r.snapshot).toMatchObject({ workflow_state: 'done', status: 'done' });
    expect(find(r.effects, 'state_entered')).toMatchObject({
      to: 'done',
      transition: 'done',
      actor: 'human',
      reason: 'ship it',
    });
  });

  it('a human move with requires into an agent state delivers the text as an answer (no input_request)', () => {
    const def = v2With((raw) => {
      raw.states.waiting_external.on.back_to_implementing = {
        goto: 'implementing',
        actor: 'human',
        requires: { checks: [{ name: 'Tests pass', cmd: 'npm test' }] },
        on_unmet: { goto: 'implementing', retries: 1, else: 'needs_input' },
      };
    });
    const snap = freshSnapshot(def);
    snap.ticket = { ...snap.ticket, kind: 'work' };
    const h = new Harness(def, snap).claimAndStart();
    take(h, 'scope_changed', 'q?');
    human(h, 'waiting_on_someone', 'Dana');
    let r = human(h, 'back_to_implementing', 'Dana says: use v2 of the API.');
    expect(r.snapshot.step).toMatchObject({ kind: 'move', actor: 'human', phase: 'checks' });
    r = h.cmdExit(0);
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      status: 'running',
      step: null,
      pending_answer: { input_request_id: null, answer: 'Dana says: use v2 of the API.' },
    });
    expect(find(r.effects, 'send_input')).toBeUndefined();
    const start = find(r.effects, 'start_session')!;
    expect(start.prompt).toContain('## Your step: implementing');
    expect(start.prompt).toContain('## Answer from a human\n\nDana says: use v2 of the API.');
    expect(find(r.effects, 'state_entered')).toMatchObject({
      to: 'implementing',
      transition: 'back_to_implementing',
      actor: 'human',
      reason: 'Dana says: use v2 of the API.',
    });
  });
});

describe('move steps (requires on the transition)', () => {
  it('checks red once → back with the evidence (move counter 1), then green → open_pr → entered', () => {
    const h = implementing('work', V2_NO_CONDITIONS);
    const label = moveStateLabel('implementing', 'waiting_external', 'ready_for_testing');
    const key = moveCounterKey('implementing', 'ready_for_testing');
    let r = take(h, 'ready_for_testing', 'Ready.', { summary: 'added /health' });
    expect(r.snapshot.workflow_state).toBe(label);
    // the worker is killed and detached as in an entry step
    expect(find(r.effects, 'kill')).toMatchObject({ target_command_id: h.starts.at(-1) });
    expect(r.snapshot.agent_command_id).toBeNull();
    h.cmdExit(0, 'built');
    r = h.cmdExit(1, 'FAIL health.test.js');
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      status: 'running',
      step: null,
      retry_counters: { [key]: 1 },
    });
    expect(Object.keys(r.snapshot.retry_counters)).toEqual([key]); // no <from>-><goto> counter
    const retry = find(r.effects, 'start_session')!;
    expect(retry.prompt).toContain('Requirements for Ready for testing were not met:');
    expect(retry.prompt).toContain('- Tests pass: `npm test` failed (exit code 1)');
    expect(retry.prompt).toContain('FAIL health.test.js');
    expect(retry.prompt).toContain('Fix what is listed above');
    expect(find(r.effects, 'state_entered')).toMatchObject({ from: label, to: 'implementing' });

    h.started();
    r = take(h, 'ready_for_testing', 'Fixed.', { summary: 'added /health' });
    expect(r.snapshot.state_visits[label]).toBe(2);
    h.cmdExit(0);
    r = h.cmdExit(0);
    expect(find(r.effects, 'run_action')).toMatchObject({
      action: 'open_pr',
      target_state: 'waiting_external',
      idempotency_key: `${h.snap.id}:${label}:2`,
      expected_sha: HEAD_SHA,
    });
    r = action(h, { pr_url: PR });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'waiting_external',
      status: 'waiting_external',
      step: null,
      retry_counters: { [key]: 1 },
    });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: label,
      to: 'waiting_external',
      visit: 1,
      transition: 'ready_for_testing',
      reason: 'Fixed.',
      actor: 'agent',
    });
  });

  it('unmet past on_unmet.retries → on_unmet.else (a human) listing what is unmet', () => {
    const def = v2With((raw) => {
      const t: Record<string, any> = raw.states.implementing.on.ready_for_testing;
      delete t.requires.conditions;
      t.on_unmet.retries = 0;
    });
    const h = implementing('work', def);
    take(h, 'ready_for_testing', 'Ready.', { summary: 's' });
    const r = h.cmdExit(2, 'boom');
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', return_to: 'implementing' });
    const q = find(r.effects, 'create_input_request')!.question;
    expect(q).toContain(
      'Requirements to take "Ready for testing" (implementing → waiting_external) were not met after 1 attempt (retry limit 0):',
    );
    expect(q).toContain('boom');
  });

  it('a failed action goes straight to on_unmet.else', () => {
    const h = implementing('work', V2_NO_CONDITIONS);
    take(h, 'ready_for_testing', 'Ready.', { summary: 's' });
    h.cmdExit(0);
    h.cmdExit(0);
    const r = action(h, null, 'gh: not logged in');
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')?.question).toBe(
      'Conductor could not open the pull request (open_pr) to take "Ready for testing" (implementing → waiting_external): gh: not logged in. Retry, skip, or abort?',
    );
  });

  it('a review in requires runs the fenced reviewer on the checked commit', () => {
    const def = v2With((raw) => {
      raw.states.implementing.on.done.requires.review = { items: ['Has tests'] };
    });
    const h = implementing('personal', def);
    take(h, 'done', 'Finished.', { summary: 's' });
    h.cmdExit(0);
    const r = h.cmdExit(0);
    const reviewer = find(r.effects, 'start_session')!;
    expect(reviewer).toMatchObject({ review: true, tools: ['review'] });
    expect(reviewer.prompt).toContain(HEAD_SHA);
    const v = h.run({
      type: 'agent.complete_state',
      result: { verdict: [{ item: 'Has tests', met: false, reason: 'none' }] },
      transition: 'whatever', // ignored: a reviewer reports a verdict
    });
    expect(v.snapshot.retry_counters).toEqual({ [moveCounterKey('implementing', 'done')]: 1 });
    expect(find(v.effects, 'start_session')?.prompt).toContain('- Has tests: none');
  });

  it('enabled conditions start the conditions phase (M1b-T08); all disabled ones are skipped', () => {
    const h = implementing('work');
    take(h, 'ready_for_testing', 'Ready.', { summary: 's' });
    h.cmdExit(0);
    h.cmdExit(0);
    let r = action(h, { pr_url: PR });
    expect(r.snapshot).toMatchObject({
      workflow_state: moveStateLabel('implementing', 'waiting_external', 'ready_for_testing'),
      status: 'waiting_external',
      step: { phase: 'conditions' },
    });
    expect(find(r.effects, 'run_action')).toMatchObject({ action: 'evaluate_conditions' });
    const def = v2With((raw) => {
      const c = raw.states.implementing.on.ready_for_testing.requires.conditions as any[];
      for (const x of c) x.enabled = false;
    });
    const d = implementing('work', def);
    take(d, 'ready_for_testing', 'Ready.', { summary: 's' });
    d.cmdExit(0);
    d.cmdExit(0);
    r = action(d, { pr_url: PR });
    expect(r.snapshot.workflow_state).toBe('waiting_external');
  });

  it('a counted transition with requires counts its loop first, then runs the step', () => {
    const def = v2With((raw) => {
      raw.states.implementing.on.done.retries = 1;
      raw.states.implementing.on.done.else = 'needs_input';
    });
    const h = implementing('personal', def);
    take(h, 'done', 'Finished.', { summary: 's' });
    expect(h.snap.retry_counters).toEqual({ 'implementing->done': 1 });
    expect(h.snap.step?.kind).toBe('move');
  });

  it('fallback routes never run requirements', () => {
    const def = v2With((raw) => {
      raw.states.implementing.on.timeout = {
        goto: 'needs_input',
        requires: { checks: [{ name: 'x', cmd: 'true' }] },
        on_unmet: { goto: 'implementing', else: 'needs_input' },
      };
    });
    const h = implementing('work', def);
    const r = h.run({
      type: 'timer.fired',
      state: 'implementing',
      deadline: h.snap.state_deadline!,
    });
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', step: null });
  });
});

describe('prompts (conductor v2)', () => {
  /** The implementing prompt (rendered when planning takes plan_ready). */
  const promptFor = (kind: TicketKind | null) => {
    const r = take(planning(kind), 'plan_ready', 'ok', { plan: 'P', summary: 's' });
    return find(r.effects, 'start_session')!.prompt;
  };

  it('How to finish lists the transitions allowed for the kind', () => {
    const work = promptFor('work');
    const finish = work.slice(work.indexOf(HOW_TO_FINISH_HEADING));
    expect(finish).toMatchInlineSnapshot(`
      "## How to finish

      When you finish this step, take exactly one of these transitions:

      - needs_approval_to_message: You are about to message a person and need approval of the text first. Your \`reason\` is the question for the human.
      - pr_ready_for_review: The work is done and you want the user to review the PR. Your \`reason\` is the question for the human.
      - ready_for_testing: The work is complete and should go to testing.
      - ask_user: You are blocked and need a human decision.

      Call the \`complete_state\` tool once with \`transition\` set to its name, \`reason\` saying why in one or two sentences, and a \`result\` object summarising what you did, then stop.
      For a transition that asks a human, write the question in \`reason\`; the \`result\` may then be empty.
      Any other name is refused."
    `);
    const personal = promptFor('personal');
    expect(personal).toContain('- done: The work is complete.');
    expect(personal).not.toContain('- ready_for_testing');
    const both = promptFor(null);
    expect(both).toContain('- done: The work is complete.');
    expect(both).toContain('- ready_for_testing: The work is complete and should go to testing.');
    expect(work.endsWith(finish)).toBe(true); // the prompt ends with it
  });

  it('the work-commit rule: present for work, absent for personal and for a null kind', () => {
    const work = promptFor('work');
    expect(work).toContain(WORK_REPOSITORY_HEADING);
    expect(work).toContain('Do not commit workflow or agent configuration');
    expect(promptFor('personal')).not.toContain(WORK_REPOSITORY_HEADING);
    expect(promptFor(null)).not.toContain(WORK_REPOSITORY_HEADING);
  });

  it('the planning prompt lists the question transitions', () => {
    const fresh = new Harness(CONDUCTOR_V2_DRAFT_DEF, {
      ...freshSnapshot(CONDUCTOR_V2_DRAFT_DEF),
      ticket: { ...freshSnapshot(CONDUCTOR_V2_DRAFT_DEF).ticket, kind: 'personal' },
    });
    const claim = fresh.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    const start = find(claim.effects, 'start_session')!;
    expect(start.prompt).toContain(
      '- scope_changed: A new dependency or finding changes the scope of the ticket. Your `reason` is the question for the human.',
    );
    expect(start.prompt).toContain('- ask_user: You are blocked and need a human decision.');
    expect(start.transitions?.map((t) => t.name)).toEqual([
      'plan_ready',
      'scope_changed',
      'plan_needs_approval',
      'needs_product_context',
      'impossible',
      'ask_user',
    ]);
  });
});
