/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { Harness } from './apply.testkit.js';
import { entryCounterKey, entryStateLabel, REVIEW_PROMPT_HEADING } from './review.js';
import type { Effect } from './types.js';

// ADR-0010: requirements to enter a column (apply.ts §gate steps), on the shipped conductor v1:
// planning → implementing → [checks: build, test; actions: open_pr] → waiting_external → done.

const LABEL = entryStateLabel('implementing', 'waiting_external');
const KEY = entryCounterKey('waiting_external');
const WORKER = 'c1a0de00-0000-4000-8000-00000000000a';
const REVIEWER = 'c1a0de00-0000-4000-8000-00000000000b';
const PR = 'https://github.com/benjgrad/fixture-app/pull/7';

const types = (effects: Effect[]) => effects.map((e) => e.type);
const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

/** conductor v1 with `mutate` applied to the raw definition. */
function conductorWith(mutate: (raw: Record<string, any>) => void): WorkflowDefinition {
  const raw = structuredClone(CONDUCTOR_V1_DEF) as unknown as Record<string, any>;
  mutate(raw);
  return WorkflowDefinitionSchema.parse(raw);
}

/** Planned and implementing: the worker is running in `implementing`. */
function implementing(def = CONDUCTOR_V1_DEF): Harness {
  const h = new Harness(def).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  expect(h.snap.workflow_state).toBe('planning');
  h.advance(30).complete({ plan: '1. add /health', summary: 'plan' });
  expect(h.snap.workflow_state).toBe('implementing');
  h.started();
  return h;
}

/** The worker finished `implementing`: the entry step for Waiting external has started. */
function checking(def = CONDUCTOR_V1_DEF): Harness {
  const h = implementing(def);
  h.advance(60).complete({ summary: 'added /health' });
  return h;
}

const action = (h: Harness, result: Record<string, string> | null, error: string | null = null) =>
  h.run({
    type: 'action.completed',
    command_id: h.newId(),
    action: 'open_pr',
    result,
    error,
  });

describe('conductor v1: entering Waiting external', () => {
  it('planning hands its plan to implementing ($planning.plan)', () => {
    const h = new Harness(CONDUCTOR_V1_DEF).claimAndStart();
    const r = h.complete({ plan: 'PLAN-TEXT', summary: 's' });
    const start = find(r.effects, 'start_session')!;
    expect(start.state).toBe('implementing');
    expect(start.tools).toEqual(['edit', 'bash', 'git']);
    expect(start.prompt).toContain('## Your step: implementing');
    expect(start.prompt).toContain('- plan: PLAN-TEXT');
  });

  it('done → the entry step: stays in implementing, runs the checks one at a time', () => {
    const h = implementing();
    const r = h.advance(60).complete({ summary: 'added /health' });
    expect(r.snapshot).toMatchObject({
      workflow_state: LABEL,
      status: 'running',
      agent_command_id: null, // the worker is detached: its late events can't count
      step: {
        kind: 'entry',
        from: 'implementing',
        to: 'waiting_external',
        phase: 'checks',
        index: 0,
      },
    });
    expect(find(r.effects, 'run_cmd')).toEqual({
      type: 'run_cmd',
      state: LABEL,
      cmd: 'npm run build',
      cwd: null,
      timeout_ms: 600_000,
    });
    expect(find(r.effects, 'state_entered')).toMatchObject({ from: 'implementing', to: LABEL });
    const next = h.cmdExit(0, 'built');
    expect(find(next.effects, 'run_cmd')?.cmd).toBe('npm test');
    expect(next.snapshot.step).toMatchObject({ phase: 'checks', index: 1 });
  });

  it('checks pass → open_pr through the outbox (idempotency key session+state+visit) → enter', () => {
    const h = checking();
    h.cmdExit(0);
    const r = h.cmdExit(0);
    const act = find(r.effects, 'run_action')!;
    expect(act).toMatchObject({
      state: LABEL,
      target_state: 'waiting_external',
      action: 'open_pr',
      idempotency_key: `${h.snap.id}:waiting_external:1`,
      args: { title: 'Add /health' },
    });
    expect(act.args.body as string).toContain('added /health');
    expect(act.args.body as string).toContain('Opened by conductor.');
    expect(r.snapshot.step).toMatchObject({ phase: 'actions', index: 0 });
    expect(r.snapshot.state_deadline).not.toBeNull();

    const done = action(h, { pr_url: PR });
    expect(done.snapshot).toMatchObject({
      workflow_state: 'waiting_external',
      status: 'waiting_external',
      step: null,
      context: { waiting_external: { pr_url: PR } },
    });
    expect(find(done.effects, 'state_entered')).toMatchObject({
      from: LABEL,
      to: 'waiting_external',
    });
    // Approve keeps the PR URL (merged into the state's context).
    const approved = h.run({
      type: 'external.event',
      name: 'ui.approve',
      data: { comment: 'lgtm' },
    });
    expect(approved.snapshot).toMatchObject({
      workflow_state: 'done',
      status: 'done',
      context: { waiting_external: { pr_url: PR, event: 'ui.approve', comment: 'lgtm' } },
    });
  });

  it('a failed check → back to implementing with the output tail; the rest do not run', () => {
    const h = checking();
    const r = h.cmdExit(2, 'FAIL src/health.test.ts\nexpected 200');
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      step: null,
      retry_counters: { [KEY]: 1 },
    });
    expect(find(r.effects, 'run_cmd')).toBeUndefined();
    const start = find(r.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBe(WORKER);
    expect(start.prompt).toContain('Requirements to enter Waiting external were not met:');
    expect(start.prompt).toContain('- Build passes: `npm run build` failed (exit code 2)');
    expect(start.prompt).toContain('FAIL src/health.test.ts\nexpected 200');
    expect(start.prompt).toContain('Fix what is listed above, commit');
    // The next attempt is a new visit: a new idempotency key.
    h.started();
    h.complete({ summary: 'fixed' });
    h.cmdExit(0);
    const act = find(h.cmdExit(0).effects, 'run_action')!;
    expect(act.idempotency_key).toBe(`${h.snap.id}:waiting_external:2`);
  });

  it('a timed-out check is unmet', () => {
    const h = checking();
    const r = h.cmdExit(null, 'still building', true);
    const start = find(r.effects, 'start_session')!;
    expect(start.prompt).toContain('`npm run build` failed (timed out after 10m)');
  });

  it('retries exhausted → needs_input with the question listing what is unmet', () => {
    const h = checking();
    for (let i = 0; i < 3; i++) {
      h.cmdExit(1, `fail ${i}`);
      h.started();
      h.complete({ summary: `try ${i}` });
    }
    const r = h.cmdExit(1, 'fail last');
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implementing',
      step: null,
      retry_counters: { [KEY]: 3 },
    });
    const req = find(r.effects, 'create_input_request')!;
    expect(req.kind).toBe('retries_exhausted');
    expect(req.question).toContain(
      'Requirements to enter "Waiting external" were not met after 4 attempts (retry limit 3):',
    );
    expect(req.question).toContain('- Build passes: `npm run build` failed (exit code 1)');
    expect(req.question).toContain('fail last');
  });

  it('a failed action is not the agent’s fault: straight to needs_input with the error', () => {
    const h = checking();
    h.cmdExit(0);
    h.cmdExit(0);
    const r = action(h, null, 'gh (the GitHub CLI) is not on PATH');
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      step: null,
      retry_counters: {},
    });
    const req = find(r.effects, 'create_input_request')!;
    expect(req.question).toContain('Conductor could not open the pull request (open_pr)');
    expect(req.question).toContain('gh (the GitHub CLI) is not on PATH');
    expect(types(r.effects)).not.toContain('kill');
  });

  it('a refused action or check → needs_input', () => {
    const h = checking();
    const r = h.run({
      type: 'command.refused',
      command_id: h.newId(),
      command_kind: 'run_cmd',
      reason: 'unknown_session',
    });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')!.question).toContain(
      'Could not run the check "Build passes"',
    );
  });

  it('an action that never reports → timeout → needs_input, and the action is killed', () => {
    const h = checking();
    h.cmdExit(0);
    const r0 = h.cmdExit(0);
    const deadline = r0.snapshot.state_deadline!;
    h.advance(601);
    const r = h.run({ type: 'timer.fired', state: LABEL, deadline });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')).toMatchObject({ kind: 'timeout' });
    expect(types(r.effects)).toContain('kill');
  });

  it('while checking: live messages are refused; worker events are ignored', () => {
    const h = checking();
    expect(h.run({ type: 'operator.message', text: 'hi' }).ignored).toBe('wrong_status');
    expect(h.complete({ verdict: 'approve' }).ignored).toBe('unexpected_event');
    expect(h.run({ type: 'agent.ask_user', question: 'q' }).ignored).toBe('unexpected_event');
    expect(
      h.run({ type: 'agent.exited', command_id: h.starts.at(-1)!, code: 0, signal: null }).ignored,
    ).toBe('command_id_mismatch');
    expect(
      h.run({
        type: 'action.completed',
        command_id: h.newId(),
        action: 'open_pr',
        result: {},
        error: null,
      }).ignored,
    ).toBe('unexpected_event');
    expect(h.snap.workflow_state).toBe(LABEL);
  });

  it('cancel while checking fails the session and drops the step', () => {
    const h = checking();
    const r = h.run({ type: 'operator.cancel' });
    expect(r.snapshot).toMatchObject({ status: 'failed', step: null });
    expect(types(r.effects)).toContain('kill');
  });

  it('a human "skip to waiting_external" also has to meet the requirements', () => {
    const h = implementing();
    h.run({ type: 'agent.ask_user', question: 'which port?' });
    expect(h.snap.workflow_state).toBe('needs_input');
    const r = h.run({
      type: 'input.provided',
      input_request_id: h.newId(),
      answer: 'just open it',
      goto: 'waiting_external',
    });
    expect(r.snapshot).toMatchObject({
      workflow_state: entryStateLabel('needs_input', 'waiting_external'),
      step: { from: 'needs_input', outcome: 'answered' },
    });
    expect(find(r.effects, 'run_cmd')?.cmd).toBe('npm run build');
  });
});

describe('entry review (plain-language items, the ADR-0009 reviewer reused)', () => {
  const ITEMS = ['The change has tests'];
  const withReview = conductorWith((raw) => {
    raw.states.waiting_external.entry.review = { items: ITEMS, model: 'opus' };
  });

  it('checks pass → a fresh read-only reviewer; met → actions; unmet → back with reasons', () => {
    const h = checking(withReview);
    h.cmdExit(0);
    const r = h.cmdExit(0);
    const rev = find(r.effects, 'start_session')!;
    expect(rev).toMatchObject({
      state: LABEL,
      tools: ['review'],
      resume_claude_session_id: null,
      model: 'opus',
      review: true,
    });
    expect(rev.prompt.startsWith(REVIEW_PROMPT_HEADING)).toBe(true);
    expect(rev.prompt).toContain('into the `Waiting external` column');
    expect(r.snapshot.step).toMatchObject({ phase: 'review' });
    h.started();
    h.run({ type: 'agent.claude_session_id', claude_session_id: REVIEWER });
    expect(h.snap.claude_session_id).toBe(WORKER);

    const unmet = h.complete({
      verdict: [{ item: ITEMS[0]!, met: false, reason: 'no test for /health' }],
    } as never);
    expect(unmet.snapshot.workflow_state).toBe('implementing');
    const back = find(unmet.effects, 'start_session')!;
    expect(back.resume_claude_session_id).toBe(WORKER);
    expect(back.prompt).toContain('- The change has tests: no test for /health');

    h.started();
    h.complete({ summary: 'tests added' });
    h.cmdExit(0);
    h.cmdExit(0);
    h.started();
    const met = h.complete({ verdict: [{ item: ITEMS[0]!, met: true, reason: 'ok' }] } as never);
    expect(find(met.effects, 'run_action')).toBeDefined();
    expect(met.snapshot.step).toMatchObject({ phase: 'actions' });
    expect(met.snapshot.agent_command_id).toBeNull();
  });

  it('reviewer timeout → needs_input', () => {
    const h = checking(withReview);
    h.cmdExit(0);
    const r = h.cmdExit(0);
    h.advance(601);
    const t = h.run({ type: 'timer.fired', state: LABEL, deadline: r.snapshot.state_deadline! });
    expect(t.snapshot.workflow_state).toBe('needs_input');
    expect(find(t.effects, 'create_input_request')!.question).toContain(
      'The requirements review to enter "Waiting external" timed out',
    );
  });
});
