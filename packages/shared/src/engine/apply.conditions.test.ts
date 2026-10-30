/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- raw definition edits in tests */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sessionBranch } from '../domain.js';
import { CONDUCTOR_V2_DRAFT, CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { freshSnapshot, Harness, HEAD_SHA, T0 } from './apply.testkit.js';
import { PR_CONTEXT_KEY } from './review.js';
import {
  CONDITIONS_NO_MACHINE_NOTE,
  moveCounterKey,
  MESSAGE_MOVE,
  moveStateLabel,
  type ApplyResult,
  type Effect,
} from './types.js';

// ADR-0011 (M1b-T08): the conditions phase of a move step, on the T01 draft of conductor v2:
// implementing → ready_for_testing (checks, open_pr, then pr_checks_green + pr_approvals ≥ 1, the
// Jira and Azure conditions disabled; condition_poll 2m, condition_timeout 3d).

const PR = 'https://github.com/benjgrad/fixture-app/pull/7';
const LABEL = moveStateLabel('implementing', 'waiting_external', 'ready_for_testing');
const KEY = moveCounterKey('implementing', 'ready_for_testing');
const MIN = 60_000;

type Status = 'met' | 'pending' | 'failed' | 'unsupported';
interface Res {
  status: Status;
  value?: string | null;
  detail?: string | null;
}

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

function v2With(mutate: (raw: Record<string, any>) => void): WorkflowDefinition {
  const raw = structuredClone(CONDUCTOR_V2_DRAFT) as Record<string, any>;
  mutate(raw);
  return WorkflowDefinitionSchema.parse(raw);
}

/** A work ticket, planned and running in `implementing`. */
function implementing(def: WorkflowDefinition = CONDUCTOR_V2_DRAFT_DEF): Harness {
  const snap = freshSnapshot(def);
  snap.ticket = { ...snap.ticket, kind: 'work' };
  const h = new Harness(def, snap).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: { plan: 'P', summary: 'plan' },
    transition: 'plan_ready',
    reason: 'ok',
  });
  h.started();
  return h;
}

/** ready_for_testing: both checks green, open_pr done → the conditions phase has started. */
function toConditions(h: Harness): ApplyResult {
  h.run({
    type: 'agent.complete_state',
    result: { summary: 'added /health' },
    transition: 'ready_for_testing',
    reason: 'Ready.',
  });
  h.cmdExit(0);
  h.cmdExit(0);
  return h.run({
    type: 'action.completed',
    command_id: h.newId(),
    action: 'open_pr',
    result: { pr_url: PR },
    error: null,
  });
}

/** The daemon's answer for [pr_checks_green, pr_approvals]. */
function evaluate(h: Harness, checks: Res, approvals: Res): ApplyResult {
  const one = (type: string, r: Res) => ({
    type,
    status: r.status,
    value: r.value ?? null,
    detail: r.detail ?? null,
  });
  return h.run({
    type: 'action.completed',
    command_id: h.newId(),
    action: 'evaluate_conditions',
    result: { results: [one('pr_checks_green', checks), one('pr_approvals', approvals)] },
    error: null,
  });
}

/** Advance the clock to the armed deadline and fire it. */
function fire(h: Harness): ApplyResult {
  const deadline = h.snap.state_deadline!;
  h.now = new Date(deadline);
  return h.run({ type: 'timer.fired', state: h.snap.workflow_state!, deadline });
}

const GREEN: Res = { status: 'met', value: '3/3' };
const NO_APPROVAL: Res = { status: 'pending', value: '0/1' };
const APPROVED: Res = { status: 'met', value: '1/1' };

const deadlineIn = (h: Harness, ms: number) => new Date(h.now.getTime() + ms).toISOString();

describe('the conditions phase', () => {
  it('approvals pending → pending (re-armed at 2, then 4 min) → met → the target is entered', () => {
    const h = implementing();
    let r = toConditions(h);
    expect(r.snapshot).toMatchObject({
      workflow_state: LABEL,
      status: 'waiting_external', // U-059: paused
      agent_command_id: null,
      agent_process_live: false,
      step: {
        phase: 'conditions',
        conditions_deadline: deadlineIn(h, 3 * 24 * 60 * MIN),
        conditions_poll_ms: 2 * MIN,
        conditions_note: null,
      },
    });
    expect(r.snapshot.step!.conditions.map((c) => [c.label, c.status])).toEqual([
      ['PR checks green', 'running'],
      ['PR approved', 'running'],
      ['Jira fields set: resolution', 'disabled'],
      ['Pipeline ci succeeded', 'disabled'],
    ]);
    const run = find(r.effects, 'run_action')!;
    expect(run).toMatchObject({
      state: LABEL,
      target_state: 'waiting_external',
      action: 'evaluate_conditions',
      expected_sha: HEAD_SHA,
    });
    expect(run.idempotency_key).toBe(`${h.snap.id}:${LABEL}:${h.now.toISOString()}`);
    expect(run.args).toEqual({
      conditions: [{ type: 'pr_checks_green' }, { type: 'pr_approvals', min: 1 }],
      pr_url: PR,
      branch: sessionBranch(h.snap.ticket.id, h.snap.id),
      head_sha: HEAD_SHA,
    });
    expect(find(r.effects, 'session_status')).toEqual({
      type: 'session_status',
      from: 'running',
      to: 'waiting_external',
    });
    expect(r.snapshot.state_deadline).toBe(deadlineIn(h, 2 * MIN));

    // first answer: pending → poll again in 2 min
    h.advance(5);
    r = evaluate(h, GREEN, NO_APPROVAL);
    expect(r.ignored).toBeNull();
    expect(r.snapshot.status).toBe('waiting_external');
    expect(r.snapshot.state_deadline).toBe(deadlineIn(h, 2 * MIN));
    expect(r.snapshot.step!.conditions.slice(0, 2)).toEqual([
      expect.objectContaining({ status: 'met', value: '3/3', checked_at: h.now.toISOString() }),
      expect.objectContaining({ status: 'pending', value: '0/1' }),
    ]);
    expect(find(r.effects, 'run_action')).toBeUndefined();

    // the poll re-evaluates; the same answer → the interval doubles to 4 min
    r = fire(h);
    expect(find(r.effects, 'run_action')?.action).toBe('evaluate_conditions');
    r = evaluate(h, GREEN, NO_APPROVAL);
    expect(r.snapshot.step!.conditions_poll_ms).toBe(4 * MIN);
    expect(r.snapshot.state_deadline).toBe(deadlineIn(h, 4 * MIN));

    // approved → waiting_external is entered, recorded as the agent's move
    fire(h);
    r = evaluate(h, GREEN, APPROVED);
    expect(r.snapshot).toMatchObject({
      workflow_state: 'waiting_external',
      status: 'waiting_external',
      step: null,
      retry_counters: {},
    });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: LABEL,
      to: 'waiting_external',
      visit: 1,
      transition: 'ready_for_testing',
      reason: 'Ready.',
      actor: 'agent',
    });
    expect(r.snapshot.state_deadline).toBeNull();
  });

  it('the backoff doubles up to 15 min and resets when the answer changes', () => {
    const h = implementing();
    toConditions(h);
    const polls: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = evaluate(h, GREEN, NO_APPROVAL);
      polls.push(r.snapshot.step!.conditions_poll_ms! / MIN);
      fire(h);
    }
    expect(polls).toEqual([2, 4, 8, 15, 15, 15]);
    const r = evaluate(h, GREEN, { status: 'pending', value: '0/2' });
    expect(r.snapshot.step!.conditions_poll_ms).toBe(2 * MIN);
  });

  it('checks failed → back to implementing with "pr_checks_green: failed (…)" in the feedback', () => {
    const h = implementing();
    toConditions(h);
    const r = evaluate(h, { status: 'failed', value: '2/3', detail: 'failing: lint' }, NO_APPROVAL);
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      status: 'running',
      step: null,
      retry_counters: { [KEY]: 1 },
    });
    const prompt = find(r.effects, 'start_session')!.prompt;
    expect(prompt).toContain('Requirements for Ready for testing were not met:');
    expect(prompt).toContain('- pr_checks_green: failed (failing: lint; last value 2/3)');
    expect(prompt).not.toContain('pr_approvals');
    expect(find(r.effects, 'state_entered')).toMatchObject({ from: LABEL, to: 'implementing' });
  });

  describe('pr_checks_green.no_checks_after (U-072)', () => {
    const NO_CHECKS: Res = {
      status: 'pending',
      value: '0/0 passed',
      detail: 'no checks reported yet',
    };
    const graced = () =>
      v2With((raw) => {
        raw.states.implementing.on.ready_for_testing.requires.conditions[0].no_checks_after = '5m';
      });

    it('the daemon never sees no_checks_after (an older daemon would refuse the key)', () => {
      const h = implementing(graced());
      const run = find(toConditions(h).effects, 'run_action')!;
      expect((run.args as { conditions: unknown[] }).conditions[0]).toEqual({
        type: 'pr_checks_green',
      });
    });

    it('no checks at all stays pending until 5 min after the conditions started, then is met', () => {
      const h = implementing(graced());
      toConditions(h);
      const start = h.now.getTime();
      let r = evaluate(h, NO_CHECKS, APPROVED);
      expect(r.snapshot.step!.conditions[0]).toMatchObject({ status: 'pending' });
      fire(h); // +2 min
      r = evaluate(h, NO_CHECKS, APPROVED);
      expect(r.snapshot.step!.conditions[0]).toMatchObject({ status: 'pending' });
      fire(h); // +6 min: past the grace
      expect(h.now.getTime() - start).toBeGreaterThanOrEqual(5 * MIN);
      r = evaluate(h, NO_CHECKS, APPROVED);
      expect(r.snapshot).toMatchObject({ workflow_state: 'waiting_external', step: null });
    });

    it('checks that exist but are still running are never graced', () => {
      const h = implementing(graced());
      toConditions(h);
      for (let i = 0; i < 4; i++) {
        evaluate(
          h,
          { status: 'pending', value: '0/2 passed', detail: 'waiting for: ci' },
          APPROVED,
        );
        fire(h);
      }
      const r = evaluate(h, { status: 'pending', value: '0/2 passed' }, APPROVED);
      expect(r.snapshot.step!.conditions[0]).toMatchObject({ status: 'pending' });
    });

    it('without no_checks_after, no checks stays pending however long it takes', () => {
      const h = implementing();
      toConditions(h);
      for (let i = 0; i < 4; i++) {
        evaluate(h, NO_CHECKS, APPROVED);
        fire(h);
      }
      const r = evaluate(h, NO_CHECKS, APPROVED);
      expect(r.snapshot.step!.conditions[0]).toMatchObject({ status: 'pending' });
    });

    it('a met-by-grace checklist line says why', () => {
      const h = implementing(graced());
      toConditions(h);
      evaluate(h, NO_CHECKS, NO_APPROVAL);
      fire(h);
      evaluate(h, NO_CHECKS, NO_APPROVAL);
      fire(h);
      const r = evaluate(h, NO_CHECKS, NO_APPROVAL);
      expect(r.snapshot.step!.conditions[0]).toMatchObject({
        status: 'met',
        detail: 'no CI checks reported within 5m',
      });
    });
  });

  it('a failed condition past on_unmet.retries → on_unmet.else listing the evidence', () => {
    const def = v2With((raw) => {
      raw.states.implementing.on.ready_for_testing.on_unmet.retries = 0;
    });
    const h = implementing(def);
    toConditions(h);
    const r = evaluate(h, GREEN, {
      status: 'failed',
      value: '0/1',
      detail: 'changes requested by dana',
    });
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', status: 'needs_input' });
    const req = find(r.effects, 'create_input_request')!;
    expect(req.kind).toBe('retries_exhausted');
    expect(req.question).toContain(
      '- pr_approvals: failed (changes requested by dana; last value 0/1)',
    );
  });

  it('the timeout → needs_input `timeout` listing the checklist; nothing is killed', () => {
    const def = v2With((raw) => {
      raw.states.implementing.on.ready_for_testing.requires.condition_timeout = '10m';
    });
    const h = implementing(def);
    const start = toConditions(h).snapshot.step!.conditions_deadline!;
    let r: ApplyResult = evaluate(h, GREEN, NO_APPROVAL);
    let guard = 0;
    while (h.snap.step !== null && guard++ < 20) {
      r = fire(h);
      if (find(r.effects, 'run_action') !== undefined) evaluate(h, GREEN, NO_APPROVAL);
    }
    expect(h.now.toISOString()).toBe(start); // the last timer is the deadline, not a later poll
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implementing',
    });
    expect(find(r.effects, 'kill')).toBeUndefined();
    const req = find(r.effects, 'create_input_request')!;
    expect(req.kind).toBe('timeout');
    expect(req.question).toBe(
      [
        'The conditions to take "Ready for testing" (implementing → waiting_external) were not all met within 10m:',
        '- PR checks green: met (3/3)',
        '- PR approved: pending (0/1)',
        '- Jira fields set: resolution: disabled',
        '- Pipeline ci succeeded: disabled',
        '',
        'Retry, skip, or abort?',
      ].join('\n'),
    );
  });

  it('a refused evaluation → still pending, re-armed, the card says "waiting for a machine"', () => {
    const h = implementing();
    toConditions(h);
    evaluate(h, GREEN, NO_APPROVAL);
    fire(h);
    h.advance(30);
    let r = h.run({
      type: 'command.refused',
      command_id: h.newId(),
      command_kind: 'run_action',
      reason: 'not_connected',
    });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: LABEL,
      status: 'waiting_external',
      step: { conditions_note: CONDITIONS_NO_MACHINE_NOTE },
    });
    expect(r.snapshot.step!.conditions.slice(0, 2).map((c) => c.status)).toEqual([
      'pending', // a met condition is not known any more
      'pending',
    ]);
    expect(r.snapshot.state_deadline).toBe(deadlineIn(h, 2 * MIN));
    expect(r.effects.filter((e) => e.type !== 'set_deadline')).toEqual([]);
    // the next poll sends a new evaluation; its answer clears the note
    r = fire(h);
    expect(find(r.effects, 'run_action')).toBeDefined();
    r = evaluate(h, GREEN, NO_APPROVAL);
    expect(r.snapshot.step!.conditions_note).toBeNull();
  });

  it('a poll while the last evaluation is unanswered sends nothing more (dispatcher caveat)', () => {
    const h = implementing();
    toConditions(h);
    let r = fire(h); // the first evaluation never answered (machine offline)
    expect(find(r.effects, 'run_action')).toBeUndefined();
    expect(r.snapshot.step!.conditions_note).toBe(CONDITIONS_NO_MACHINE_NOTE);
    expect(r.snapshot.state_deadline).toBe(deadlineIn(h, 2 * MIN));
    // the machine comes back and the queued evaluation answers
    r = evaluate(h, GREEN, APPROVED);
    expect(r.snapshot.workflow_state).toBe('waiting_external');
  });

  it('an evaluation error or a malformed result keeps the conditions pending, with a note', () => {
    const h = implementing();
    toConditions(h);
    let r = h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'evaluate_conditions',
      result: null,
      error: 'daemon crashed',
    });
    expect(r.snapshot.step).toMatchObject({
      conditions_note: 'the last check failed: daemon crashed',
    });
    expect(r.snapshot.step!.conditions[0]!.status).toBe('todo');
    fire(h);
    r = h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'evaluate_conditions',
      result: { results: [{ type: 'pr_checks_green', status: 'met', value: null, detail: null }] },
      error: null,
    });
    expect(r.snapshot.workflow_state).toBe(LABEL);
    expect(r.snapshot.step!.conditions_note).toContain('1 result for 2 conditions');
    // an answer with nothing in flight is not the phase's
    expect(evaluate(h, GREEN, APPROVED).ignored).toBe('unexpected_event');
  });

  it('`unsupported` counts as pending', () => {
    const h = implementing();
    toConditions(h);
    const r = evaluate(h, GREEN, { status: 'unsupported', detail: 'no gh' });
    expect(r.snapshot).toMatchObject({ workflow_state: LABEL, status: 'waiting_external' });
  });

  it("PR conditions without conductor's PR go straight to on_unmet.else, uncounted; nothing is sent", () => {
    const def = v2With((raw) => {
      const t = raw.states.implementing.on.ready_for_testing;
      delete t.requires.checks;
      delete t.requires.actions;
    });
    const h = implementing(def);
    const r = h.run({
      type: 'agent.complete_state',
      result: { summary: 's' },
      transition: 'ready_for_testing',
      reason: 'Ready.',
    });
    expect(find(r.effects, 'run_action')).toBeUndefined();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      step: null,
      retry_counters: {},
    });
    expect(find(r.effects, 'start_session')).toBeUndefined();
    const req = find(r.effects, 'create_input_request')!;
    expect(req.kind).toBe('retries_exhausted');
    expect(req.question).toContain(
      'Conductor could not check the conditions to take "Ready for testing" (implementing → waiting_external):',
    );
    expect(req.question).toContain(
      '- pr_checks_green: failed (conductor has no pull request for this ticket',
    );
    expect(req.question).toContain('- pr_approvals: failed (conductor has no pull request');
  });

  it("a conditions-only move with conductor's PR sends no head_sha", () => {
    const def = v2With((raw) => {
      const t = raw.states.implementing.on.ready_for_testing;
      delete t.requires.checks;
      delete t.requires.actions;
    });
    const h = implementing(def);
    h.snap = { ...h.snap, context: { ...h.snap.context, [PR_CONTEXT_KEY]: { pr_url: PR } } };
    const r = h.run({
      type: 'agent.complete_state',
      result: { summary: 's' },
      transition: 'ready_for_testing',
      reason: 'Ready.',
    });
    expect(find(r.effects, 'kill')).toBeDefined(); // the worker is ended (U-059)
    const run = find(r.effects, 'run_action')!;
    expect(run.expected_sha).toBeNull();
    expect(run.args).not.toHaveProperty('head_sha');
    expect(run.args).toMatchObject({ pr_url: PR });
  });

  it('wall_seconds does not grow across a 3-day wait', () => {
    const h = implementing();
    h.advance(60);
    toConditions(h);
    const banked = h.snap.wall_seconds;
    expect(banked).toBe(60);
    const until = T0.getTime() + (3 * 24 * 60 - 30) * MIN;
    let polls = 0;
    evaluate(h, GREEN, NO_APPROVAL);
    while (Date.parse(h.snap.state_deadline!) < until) {
      fire(h);
      evaluate(h, GREEN, NO_APPROVAL);
      polls++;
      expect(h.snap.wall_seconds).toBe(banked);
    }
    expect(polls).toBeGreaterThan(250);
    fire(h);
    const r = evaluate(h, GREEN, APPROVED);
    expect(r.snapshot.workflow_state).toBe('waiting_external');
    expect(r.snapshot.wall_seconds).toBe(banked);
    // and the timeout path doesn't count it either
    const t = implementing();
    t.advance(60);
    toConditions(t);
    while (t.snap.step !== null) {
      const f = fire(t);
      if (find(f.effects, 'run_action') !== undefined) evaluate(t, GREEN, NO_APPROVAL);
    }
    expect(t.snap.workflow_state).toBe('needs_input');
    expect(t.snap.wall_seconds).toBe(60);
    // CPU-bound, not flaky: ~300 polls through apply took 6-9 s at load 30, past the 5 s default.
  }, 30_000);

  it('an awaited external.event on the source event state overrides pending conditions', () => {
    const def = v2With((raw) => {
      raw.states.waiting_external.on['ui.approve'] = {
        goto: 'done',
        requires: { conditions: [{ type: 'pr_merged' }], condition_timeout: '1d' },
        on_unmet: { goto: 'waiting_external', retries: 1, else: 'needs_input' },
      };
    });
    const h = implementing(def);
    h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'ask_user',
      reason: 'q?',
    });
    h.run({
      type: 'human.transition',
      name: 'waiting_on_someone',
      text: null,
      actor: 'ui',
    });
    expect(h.snap.workflow_state).toBe('waiting_external');
    h.snap = { ...h.snap, context: { ...h.snap.context, [PR_CONTEXT_KEY]: { pr_url: PR } } };
    let r = h.run({ type: 'external.event', name: 'ui.approve' });
    expect(r.snapshot).toMatchObject({
      workflow_state: moveStateLabel('waiting_external', 'done', 'ui.approve'),
      status: 'waiting_external',
      step: { phase: 'conditions' },
    });
    expect(h.run({ type: 'external.event', name: 'nope' }).ignored).toBe('not_awaited');
    r = h.run({ type: 'external.event', name: 'ui.approve' });
    expect(r.snapshot).toMatchObject({ workflow_state: 'done', status: 'done', step: null });
    expect(find(r.effects, 'state_entered')).toMatchObject({
      to: 'done',
      transition: 'ui.approve',
      reason: 'ui.approve received while the conditions were pending',
    });
  });

  it('a conditions phase from an agent state ignores external events and human moves', () => {
    const h = implementing();
    toConditions(h);
    expect(h.run({ type: 'external.event', name: 'ui.approve' }).ignored).toBe('unexpected_event');
    expect(h.run({ type: 'human.transition', name: 'done', text: null, actor: 'ui' }).ignored).toBe(
      'wrong_status',
    );
    // a cancel still ends it
    const r = h.run({ type: 'operator.cancel' });
    expect(r.snapshot).toMatchObject({ status: 'failed', step: null });
  });

  it("a human's message ends the wait and resumes the agent's conversation with it, uncounted", () => {
    const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001';
    const TEXT = 'While the checks run: also add a test for the 404 path.';
    const h = implementing();
    h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
    toConditions(h);
    const visits = h.snap.state_visits.implementing!;
    const r = h.run({ type: 'operator.message', text: TEXT });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      status: 'running',
      step: null,
      retry_counters: {},
      pending_answer: { input_request_id: null, answer: TEXT },
    });
    expect(r.snapshot.state_visits.implementing).toBe(visits + 1);
    expect(find(r.effects, 'start_session')).toMatchObject({
      state: 'implementing',
      prompt: TEXT, // the resumed conversation gets the bare message
      resume_claude_session_id: CLAUDE,
    });
    expect(find(r.effects, 'state_entered')).toMatchObject({
      from: LABEL,
      to: 'implementing',
      transition: MESSAGE_MOVE,
      reason: TEXT,
      actor: 'human',
    });
    expect(find(r.effects, 'kill')).toBeUndefined();
    // The poll that was armed is stale; a late evaluation is not taken.
    expect(evaluate(h, GREEN, APPROVED).ignored).not.toBeNull();
    expect(h.snap.workflow_state).toBe('implementing');
  });

  it('a message is refused before the conditions phase, while conductor checks', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      result: { summary: 'added /health' },
      transition: 'ready_for_testing',
      reason: 'Ready.',
    });
    expect(h.snap.step?.phase).toBe('checks');
    expect(h.run({ type: 'operator.message', text: 'hi' }).ignored).toBe('wrong_status');
  });
});

// ---------------------------------------------------------------- property: bounded

/** One poll's daemon behaviour. */
type Answer =
  | { kind: 'result'; checks: Status; approvals: Status; value: number }
  | { kind: 'refused' }
  | { kind: 'error' }
  | { kind: 'silent' };

const STATUS = fc.constantFrom<Status>('met', 'pending', 'pending', 'unsupported', 'failed');
const ANSWER: fc.Arbitrary<Answer> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('result' as const),
      checks: STATUS,
      approvals: STATUS,
      value: fc.integer({ min: 0, max: 2 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'refused' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'error' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'silent' as const }) },
);

describe('apply property: the conditions phase is bounded', () => {
  it('every move step with conditions ends at the target or a human within condition_timeout + one poll', () => {
    const TIMEOUT = 60 * MIN;
    const POLL = MIN;
    const def = v2With((raw) => {
      const req = raw.states.implementing.on.ready_for_testing.requires;
      req.condition_timeout = '1h';
      req.condition_poll = '1m';
    });
    fc.assert(
      fc.property(fc.array(ANSWER, { minLength: 1, maxLength: 200 }), (answers) => {
        const h = implementing(def);
        toConditions(h);
        const start = h.now.getTime();
        const wall = h.snap.wall_seconds;
        let failed = false;
        let i = 0;
        let lastRun = true; // toConditions sent the first evaluation
        for (let guard = 0; h.snap.step !== null; guard++) {
          expect(guard).toBeLessThan(500);
          if (lastRun) {
            const a = answers[i++ % answers.length]!;
            h.advance(1);
            if (a.kind === 'result') {
              if (a.checks === 'failed' || a.approvals === 'failed') failed = true;
              evaluate(
                h,
                { status: a.checks, value: `${a.value}/3` },
                { status: a.approvals, value: `${a.value}/1` },
              );
            } else if (a.kind === 'refused') {
              h.run({
                type: 'command.refused',
                command_id: h.newId(),
                command_kind: 'run_action',
                reason: 'not_connected',
              });
            } else if (a.kind === 'error') {
              h.run({
                type: 'action.completed',
                command_id: h.newId(),
                action: 'evaluate_conditions',
                result: null,
                error: 'boom',
              });
            }
            if (h.snap.step === null) break;
          }
          expect(h.snap.status).toBe('waiting_external');
          expect(Date.parse(h.snap.state_deadline!)).toBeLessThanOrEqual(start + TIMEOUT);
          lastRun = find(fire(h).effects, 'run_action') !== undefined;
        }
        expect(h.now.getTime()).toBeLessThanOrEqual(start + TIMEOUT + POLL);
        const allowed = failed
          ? ['waiting_external', 'needs_input', 'implementing']
          : ['waiting_external', 'needs_input'];
        expect(allowed).toContain(h.snap.workflow_state);
        expect(h.snap.wall_seconds).toBe(wall);
      }),
      // M2-T33: unseeded, so every run explores new sequences; `pnpm test:all` runs the full 150.
      { numRuns: process.env.CONDUCTOR_TEST_ALL === '1' ? 150 : 50 },
    );
    // CPU-bound: 150 runs took 10 s at load 30, past vitest's 5 s default.
  }, 60_000);
});
