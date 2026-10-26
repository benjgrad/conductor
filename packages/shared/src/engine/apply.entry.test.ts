/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1_DEF } from '../workflow/conductor.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { HEAD_SHA, Harness } from './apply.testkit.js';
import {
  entryCounterKey,
  entryStateLabel,
  PR_CONTEXT_KEY,
  REVIEW_PROMPT_HEADING,
} from './review.js';
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
      require_clean: true, // only committed changes are checked
      // Ben, 2026-10-26: in a fresh checkout of the worktree's clean HEAD; setup auto-detected.
      checkout: { sha: null, setup: null, last: false },
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
      context: { [PR_CONTEXT_KEY]: { pr_url: PR, state: 'waiting_external' } },
    });
    expect(done.snapshot.context.waiting_external).toBeUndefined();
    expect(find(done.effects, 'state_entered')).toMatchObject({
      from: LABEL,
      to: 'waiting_external',
    });
    // Approve keeps the PR record.
    const approved = h.run({
      type: 'external.event',
      name: 'ui.approve',
      data: { comment: 'lgtm' },
    });
    expect(approved.snapshot).toMatchObject({
      workflow_state: 'done',
      status: 'done',
      context: {
        [PR_CONTEXT_KEY]: { pr_url: PR },
        waiting_external: { event: 'ui.approve', comment: 'lgtm' },
      },
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

describe("security review: the pushed commit is the checked commit; the PR URL is conductor's", () => {
  it("entering the step kills exactly the worker's process", () => {
    const h = implementing();
    const worker = h.agentCmd;
    const r = h.complete({ summary: 'done' });
    expect(find(r.effects, 'kill')).toEqual({
      type: 'kill',
      reason: 'gate step started: the worker is done',
      target_command_id: worker,
    });
  });

  it('the first check records HEAD; open_pr gets it as expected_sha', () => {
    const h = checking();
    h.cmdExit(0, '', false, HEAD_SHA);
    expect(h.snap.step).toMatchObject({ head_sha: HEAD_SHA });
    const act = find(h.cmdExit(0, '', false, HEAD_SHA).effects, 'run_action')!;
    expect(act.expected_sha).toBe(HEAD_SHA);
  });

  it('HEAD moving between checks is unmet (back to implementing)', () => {
    const h = checking();
    h.cmdExit(0, '', false, HEAD_SHA);
    const r = h.cmdExit(0, '', false, 'f'.repeat(40));
    expect(r.snapshot.workflow_state).toBe('implementing');
    expect(find(r.effects, 'start_session')!.prompt).toContain(
      'the branch moved while the checks ran',
    );
  });

  it('an unknown checked commit → no push: needs_input', () => {
    const oneCheck = conductorWith((raw) => {
      raw.states.waiting_external.entry.checks = [{ name: 'Build passes', cmd: 'npm run build' }];
    });
    const h = checking(oneCheck);
    const r = h.cmdExit(0, '', false, null);
    expect(find(r.effects, 'run_action')).toBeUndefined();
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')!.question).toContain(
      'could not tell which commit the checks',
    );
  });

  it('(QA a) a later check whose head is unknown is unmet', () => {
    const h = checking();
    h.cmdExit(0, '', false, HEAD_SHA);
    const r = h.cmdExit(0, '', false, null);
    expect(r.snapshot.workflow_state).toBe('implementing');
    expect(r.snapshot.retry_counters).toEqual({ [KEY]: 1 });
    expect(find(r.effects, 'start_session')!.prompt).toContain(
      'conductor could not tell which commit this check ran on',
    );
  });

  it('(QA b) a review-only entry pins the commit first; the review is told it', () => {
    const reviewOnly = conductorWith((raw) => {
      raw.states.waiting_external.entry = {
        review: { items: ['Has tests'] },
        on_unmet: { goto: 'implementing' },
      };
    });
    const h = implementing(reviewOnly);
    const r = h.complete({ summary: 'done' });
    expect(find(r.effects, 'run_cmd')).toMatchObject({ cmd: 'true', require_clean: true });
    const rev = find(h.cmdExit(0, '', false, HEAD_SHA).effects, 'start_session')!;
    expect(rev.review).toBe(true);
    expect(rev.prompt).toContain(`The checks ran on commit \`${HEAD_SHA}\``);
  });

  it('(QA b) an action-only entry pins the commit: open_pr always gets expected_sha', () => {
    const actionOnly = conductorWith((raw) => {
      raw.states.waiting_external.entry = {
        actions: ['open_pr'],
        on_unmet: { goto: 'implementing' },
      };
    });
    const h = implementing(actionOnly);
    const r = h.complete({ summary: 'done' });
    expect(find(r.effects, 'run_cmd')).toMatchObject({ cmd: 'true', require_clean: true });
    expect(find(h.cmdExit(0, '', false, HEAD_SHA).effects, 'run_action')!.expected_sha).toBe(
      HEAD_SHA,
    );
  });

  it('the review is told the checked commit', () => {
    const h = checking(
      conductorWith((raw) => {
        raw.states.waiting_external.entry.review = { items: ['Has tests'] };
      }),
    );
    h.cmdExit(0);
    const rev = find(h.cmdExit(0).effects, 'start_session')!;
    expect(rev.prompt).toContain(`The checks ran on commit \`${HEAD_SHA}\``);
  });

  it('an invalid PR URL from the action is a failed action, never recorded', () => {
    const h = checking();
    h.cmdExit(0);
    h.cmdExit(0);
    const r = action(h, { pr_url: 'javascript:alert(1)' });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(r.snapshot.context[PR_CONTEXT_KEY]).toBeUndefined();
    expect(find(r.effects, 'create_input_request')!.question).toContain(
      'reported no valid pull request URL',
    );
  });

  it("an agent result with pr_url is just that state's result, not the PR", () => {
    const h = implementing();
    h.complete({ summary: 'x', pr_url: 'https://github.com/evil/repo/pull/1' });
    expect(h.snap.context[PR_CONTEXT_KEY]).toBeUndefined();
  });
});

describe('a dirty worktree is unmet (only committed changes are checked and pushed)', () => {
  const dirty = (h: Harness, lines: string[]) =>
    h.run({
      type: 'command.exited',
      command_id: h.newId(),
      exit_code: null,
      timed_out: false,
      output_tail: lines.join('\n'),
      head_sha: null,
      dirty: lines,
    });

  it('→ back to implementing with the status list, counted under entry:<to>', () => {
    const h = checking();
    const r = dirty(h, [' M src/health.ts', '?? src/new.test.ts']);
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      step: null,
      retry_counters: { [KEY]: 1 },
    });
    expect(find(r.effects, 'run_cmd')).toBeUndefined();
    const start = find(r.effects, 'start_session')!;
    expect(start.prompt).toContain('Uncommitted changes in the worktree: commit your work');
    expect(start.prompt).toContain(' M src/health.ts\n?? src/new.test.ts');
    // Committed and finished again: the checks run from the first one.
    h.started();
    const again = h.complete({ summary: 'committed' });
    expect(find(again.effects, 'run_cmd')).toMatchObject({
      cmd: 'npm run build',
      require_clean: true,
    });
  });

  it('exhausting the retries on a dirty tree ends at a human', () => {
    const h = checking();
    for (let i = 0; i < 3; i++) {
      dirty(h, [' M a']);
      h.started();
      h.complete({ summary: `try ${i}` });
    }
    const r = dirty(h, [' M a']);
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')!.question).toContain('Uncommitted changes');
  });

  it('the implementing prompt says to commit everything before finishing', () => {
    const r = new Harness(CONDUCTOR_V1_DEF).claimAndStart().complete({ plan: 'p', summary: 's' });
    expect(find(r.effects, 'start_session')!.prompt).toContain(
      'commit everything on the current branch',
    );
  });
});

describe('checks run in a fresh checkout of one commit (Ben, 2026-10-26)', () => {
  it('later checks name the recorded commit; the last one says so', () => {
    const h = checking();
    const r = h.cmdExit(0, '', false, HEAD_SHA);
    expect(find(r.effects, 'run_cmd')).toMatchObject({
      cmd: 'npm test',
      checkout: { sha: HEAD_SHA, setup: null, last: true },
    });
  });

  it('a configured setup is passed through ("" = none)', () => {
    const h = checking(
      conductorWith((raw) => {
        raw.states.waiting_external.entry.setup = 'pnpm i --frozen-lockfile';
      }),
    );
    expect(h.snap.step).toMatchObject({ phase: 'checks' });
    const first = h.last.effects.find((e) => e.type === 'run_cmd');
    expect(first).toMatchObject({ checkout: { setup: 'pnpm i --frozen-lockfile' } });
  });

  it('a failed setup is unmet, with its output', () => {
    const h = checking();
    const r = h.run({
      type: 'command.exited',
      command_id: h.newId(),
      exit_code: 1,
      timed_out: false,
      output_tail: 'npm ERR! missing lockfile',
      head_sha: HEAD_SHA,
      setup_failed: true,
    });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implementing',
      retry_counters: { [KEY]: 1 },
    });
    const prompt = find(r.effects, 'start_session')!.prompt;
    expect(prompt).toContain('- Setup: the setup in a fresh checkout failed (exit code 1)');
    expect(prompt).toContain('npm ERR! missing lockfile');
  });

  it('the implicit pin check of a check-less entry runs no checkout', () => {
    const h = implementing(
      conductorWith((raw) => {
        raw.states.waiting_external.entry = {
          actions: ['open_pr'],
          on_unmet: { goto: 'implementing' },
        };
      }),
    );
    const r = h.complete({ summary: 'done' });
    expect(find(r.effects, 'run_cmd')!.checkout).toBeUndefined();
  });
});
