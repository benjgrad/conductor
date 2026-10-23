import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinitionInput } from '../workflow/schema.js';
import { resolveToolPolicy } from '../workflow/tools.js';
import { apply } from './apply.js';
import { Harness, referenceWorkflow } from './apply.testkit.js';
import {
  parseVerdict,
  REVIEW_PROMPT_HEADING,
  reviewCounterKey,
  reviewStateLabel,
} from './review.js';
import type { Effect } from './types.js';

// ADR-0009: requirements gates (apply.ts §Requirements review).

const reviewed = referenceWorkflow('m1_reviewed');
const WORKER = 'c1a0de00-0000-4000-8000-00000000000a';
const REVIEWER = 'c1a0de00-0000-4000-8000-00000000000b';
const LABEL = reviewStateLabel('implement', 'build');
const KEY = reviewCounterKey('implement', 'done');
const ITEMS = ['New code paths have unit tests', 'No TODO comments in changed files'];

const types = (effects: Effect[]) => effects.map((e) => e.type);
const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);
const iso = (ms: number) => new Date(ms).toISOString();

const allMet = { verdict: ITEMS.map((item) => ({ item, met: true, reason: 'ok' })) };
const testsMissing = {
  verdict: [
    { item: ITEMS[0]!, met: false, reason: 'src/health.ts has no test' },
    { item: ITEMS[1]!, met: true, reason: 'none found' },
  ],
};

/** m1_reviewed: the worker in `implement` with its Claude session id. */
function working(): Harness {
  const h = new Harness(reviewed).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  return h;
}

/** The worker finished; the reviewer started and reported its own Claude session id. */
function reviewing(): Harness {
  const h = working();
  h.advance(60).complete({ summary: 'added /health' });
  h.started();
  h.run({ type: 'agent.claude_session_id', claude_session_id: REVIEWER });
  return h;
}

describe('gated outcome → review step', () => {
  it('enters the review step instead of the target, with a fresh read-only reviewer', () => {
    const h = working();
    const r = h.advance(60).complete({ summary: 'added /health' });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: LABEL,
      status: 'running',
      claude_session_id: WORKER,
      state_deadline: iso(h.now.getTime() + 10 * 60_000),
      return_to: null,
      review: {
        from: 'implement',
        outcome: 'done',
        to: 'build',
        attachment: null,
        claude_session_id: null,
        nudged: false,
      },
    });
    expect(r.snapshot.review?.subject).toContain('added /health');
    expect(r.snapshot.retry_counters).toEqual({}); // a gate-only object has no goto counter
    expect(types(r.effects)).toEqual(['state_entered', 'start_session', 'set_deadline']);
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: 'implement',
      to: LABEL,
      visit: 1,
    });
    const start = find(r.effects, 'start_session')!;
    expect(start).toMatchObject({
      state: LABEL,
      tools: ['review'],
      resume_claude_session_id: null,
      review: true,
      max_budget_usd: 3,
    });
    expect(start.model).toBeUndefined();
    expect(start.prompt.startsWith(REVIEW_PROMPT_HEADING)).toBe(true);
    for (const item of ITEMS) expect(start.prompt).toContain(item);
    expect(start.prompt).toContain('from `implement` to `build`');
    expect(start.prompt).toContain('"summary": "added /health"');
    expect(start.prompt).toContain('## Ticket: Add /health');
    expect(start.prompt).toContain('`git diff`');
    expect(start.prompt).toContain('"verdict"');
    // No build yet: the target is entered only on a met verdict.
    expect(find(r.effects, 'run_cmd')).toBeUndefined();
    // Wall time: the implement visit was counted on the way in.
    expect(r.snapshot.wall_seconds).toBe(60);
  });

  it('passes the gate model to the reviewer', () => {
    const raw = structuredClone(reviewed) as WorkflowDefinitionInput;
    const done = raw.states.implement!.type === 'agent' ? raw.states.implement.on!.done : null;
    if (typeof done !== 'object' || done === null || !done.requirements) throw new Error('fixture');
    done.requirements.model = 'opus';
    const h = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    const r = h.complete({});
    expect(find(r.effects, 'start_session')).toMatchObject({ model: 'opus', review: true });
  });

  it("keeps the reviewer's Claude session apart from the worker's", () => {
    const h = reviewing();
    expect(h.snap.claude_session_id).toBe(WORKER);
    expect(h.snap.review?.claude_session_id).toBe(REVIEWER);
    expect(h.snap.agent_process_live).toBe(true);
  });

  it('a gate on a command transition reviews with the output tail', () => {
    const raw = structuredClone(referenceWorkflow('m1_basic')) as WorkflowDefinitionInput;
    raw.states.build = {
      ...(raw.states.build as object),
      on: {
        exit_0: {
          goto: 'test',
          requirements: { items: ['The build has no warnings'], on_unmet: { goto: 'implement' } },
        },
        fail: { goto: 'implement', attach: 'output', retries: 3, else: 'needs_input' },
      },
    } as WorkflowDefinitionInput['states'][string];
    const h = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    h.complete({});
    const r = h.cmdExit(0, 'warning: unused variable x');
    expect(r.snapshot.workflow_state).toBe(reviewStateLabel('build', 'test'));
    const start = find(r.effects, 'start_session')!;
    expect(start.prompt).toContain('warning: unused variable x');
    expect(start.prompt).toContain('The build has no warnings');
  });
});

describe('the reviewer verdict', () => {
  it('all met → enters the target', () => {
    const h = reviewing();
    const r = h.advance(30).complete(allMet as never);
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'build',
      status: 'running',
      review: null,
      agent_command_id: null,
      agent_process_live: false,
      claude_session_id: WORKER,
      retry_counters: {},
    });
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: LABEL,
      to: 'build',
      visit: 1,
    });
    expect(find(r.effects, 'run_cmd')).toMatchObject({ state: 'build', cmd: 'npm run build' });
    expect(find(r.effects, 'kill')).toBeUndefined();
    expect(r.snapshot.context[LABEL]).toEqual({
      verdict: ITEMS.map((item) => ({ item, met: true, reason: 'ok' })),
    });
    // Budget: the review's 30 s count toward wall time (60 s implement + 30 s review).
    expect(r.snapshot.wall_seconds).toBe(90);
  });

  it('unmet → on_unmet.goto with the reasons and the instruction, resuming the worker', () => {
    const h = reviewing();
    const r = h.complete(testsMissing as never);
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implement',
      status: 'running',
      review: null,
      retry_counters: { [KEY]: 1 },
    });
    const start = find(r.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBe(WORKER);
    expect(start.tools).toEqual(['edit', 'bash', 'git']);
    expect(start.review).toBeUndefined();
    expect(start.prompt).toContain('Requirements for implement → build were not met:');
    expect(start.prompt).toContain('- New code paths have unit tests: src/health.ts has no test');
    expect(start.prompt).not.toContain('No TODO comments in changed files:');
    expect(start.prompt).toContain('Fix every unmet requirement before anything else');
    expect(find(r.effects, 'state_entered')).toMatchObject({ from: LABEL, to: 'implement' });
  });

  it('a second pass through the gate starts a fresh reviewer again', () => {
    const h = reviewing();
    h.complete(testsMissing as never);
    h.started();
    const r = h.complete({ summary: 'tests added' });
    expect(r.snapshot.workflow_state).toBe(LABEL);
    expect(r.snapshot.state_visits[LABEL]).toBe(2);
    expect(find(r.effects, 'start_session')).toMatchObject({
      resume_claude_session_id: null,
      tools: ['review'],
    });
  });

  it('retries exhausted → on_unmet.else with a question listing the unmet items', () => {
    const h = reviewing();
    for (let i = 0; i < 2; i++) {
      h.complete(testsMissing as never); // unmet → implement
      h.started();
      h.complete({ summary: `attempt ${i + 2}` }); // → review again
      h.started();
    }
    expect(h.snap.retry_counters[KEY]).toBe(2);
    const r = h.complete(testsMissing as never);
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implement',
      review: null,
      retry_counters: { [KEY]: 2 },
    });
    const ir = find(r.effects, 'create_input_request')!;
    expect(ir.kind).toBe('retries_exhausted');
    expect(ir.return_to).toBe('implement');
    expect(ir.question).toContain(
      'Requirements for "implement" → "build" were not met after 3 reviews (retry limit 2):',
    );
    expect(ir.question).toContain('- New code paths have unit tests: src/health.ts has no test');

    // The human's answer goes back to the worker (its Claude session), never the reviewer's.
    const ans = h.run({
      type: 'input.provided',
      input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      answer: 'Add the test, then finish.',
    });
    expect(ans.snapshot.workflow_state).toBe('implement');
    expect(find(ans.effects, 'start_session')).toMatchObject({
      resume_claude_session_id: WORKER,
      prompt: 'Add the test, then finish.',
    });
  });

  it('retries 0 → straight to else on the first unmet verdict', () => {
    const raw = structuredClone(reviewed) as WorkflowDefinitionInput;
    const done = raw.states.implement!.type === 'agent' ? raw.states.implement.on!.done : null;
    if (typeof done !== 'object' || done === null || !done.requirements) throw new Error('fixture');
    done.requirements.on_unmet.retries = 0;
    const h = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    h.complete({});
    h.started();
    const r = h.complete(testsMissing as never);
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')?.question).toContain('after 1 review ');
  });
});

describe('review failures', () => {
  it('reviewer timeout → else with "review timed out", killing the reviewer', () => {
    const h = reviewing();
    const deadline = h.snap.state_deadline!;
    const stale = h.run({ type: 'timer.fired', state: 'implement', deadline });
    expect(stale.ignored).toBe('stale_timer');
    const r = h.advance(600).run({ type: 'timer.fired', state: LABEL, deadline });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implement',
      review: null,
    });
    expect(types(r.effects)[0]).toBe('kill');
    const ir = find(r.effects, 'create_input_request')!;
    expect(ir.kind).toBe('timeout');
    expect(ir.question).toContain('review timed out');
  });

  it('malformed verdict → one nudge (resuming the reviewer), then else', () => {
    const h = reviewing();
    const n = h.complete({ verdict: 'looks good' });
    expect(n.snapshot.workflow_state).toBe(LABEL);
    expect(n.snapshot.review?.nudged).toBe(true);
    const nudge = find(n.effects, 'start_session')!;
    expect(nudge).toMatchObject({
      resume_claude_session_id: REVIEWER,
      tools: ['review'],
      review: true,
    });
    expect(nudge.prompt).toContain('malformed verdict: result.verdict is not an array');
    expect(types(n.effects)).toEqual(['start_session']);
    h.started();

    const r = h.complete({ verdict: [{ item: ITEMS[0]!, met: 'yes' }] } as never);
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', review: null });
    const ir = find(r.effects, 'create_input_request')!;
    expect(ir.kind).toBe('retries_exhausted');
    expect(ir.question).toContain('malformed verdict: verdict[0].met is not a boolean');
    expect(h.snap.retry_counters).toEqual({});
  });

  it('a nudge before the reviewer reported its id starts a fresh reviewer with the full prompt', () => {
    const h = working();
    h.complete({});
    h.started();
    const r = h.complete({ verdict: [] });
    const start = find(r.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt.startsWith(REVIEW_PROMPT_HEADING)).toBe(true);
    expect(start.prompt).toContain('no verdict for: "New code paths have unit tests"');
  });

  it('daemon no_outcome (already nudged) → else directly', () => {
    const h = reviewing();
    const r = h.run({ type: 'agent.no_outcome', last_output: 'hmm' });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'kill')).toBeDefined();
    expect(find(r.effects, 'create_input_request')?.question).toContain(
      'the reviewer stopped without reporting a verdict',
    );
  });

  it('reviewer ask_user and a reviewer exit count as a missing verdict (nudge once)', () => {
    const h = reviewing();
    const a = h.run({ type: 'agent.ask_user', question: 'Which tests?' });
    expect(a.snapshot.review?.nudged).toBe(true);
    expect(find(a.effects, 'start_session')?.resume_claude_session_id).toBe(REVIEWER);
    h.started();
    const r = h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 1, signal: null });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    expect(find(r.effects, 'create_input_request')?.question).toContain(
      'the reviewer exited (exit code 1) without a verdict',
    );
  });

  it('a refused reviewer start requeues; the re-claim starts a fresh reviewer', () => {
    const h = working();
    h.complete({});
    const cmd = h.agentCmd;
    const q = h.run({
      type: 'command.refused',
      command_id: cmd,
      command_kind: 'start_session',
      reason: 'max_sessions',
    });
    expect(q.snapshot).toMatchObject({ status: 'queued', machine_id: null, workflow_state: LABEL });
    expect(q.snapshot.review).not.toBeNull();
    const a = h.run({ type: 'session.assigned', machine_id: 'mbp-2' });
    expect(a.snapshot.status).toBe('assigned');
    expect(find(a.effects, 'start_session')).toMatchObject({
      state: LABEL,
      tools: ['review'],
      resume_claude_session_id: null,
    });
    expect(a.snapshot.state_deadline).not.toBeNull();
    h.started();
    expect(h.snap.status).toBe('running');
  });
});

describe('while reviewing', () => {
  it('ignores events that are not the reviewer’s; nothing changes', () => {
    const h = working();
    h.complete({});
    const workerCmd = h.starts[0]!;
    h.started();
    const before = h.snap;
    const cases = [
      [
        {
          type: 'command.exited',
          command_id: workerCmd,
          exit_code: 0,
          timed_out: false,
          output_tail: '',
        },
        'unexpected_event',
      ],
      [{ type: 'external.event', name: 'ui.approve' }, 'unexpected_event'],
      [{ type: 'operator.message', text: 'be lenient' }, 'wrong_status'],
      [
        {
          type: 'input.provided',
          input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
          answer: 'x',
        },
        'wrong_status',
      ],
      [
        { type: 'agent.exited', command_id: workerCmd, code: 0, signal: null },
        'command_id_mismatch',
      ],
      [{ type: 'session.assigned', machine_id: 'other' }, 'wrong_status'],
    ] as const;
    for (const [event, reason] of cases) {
      const r = apply(reviewed, before, event as never, h.now);
      expect(r.ignored, event.type).toBe(reason);
      expect(r.snapshot).toBe(before);
      expect(r.effects).toEqual([]);
    }
  });

  it("counts the reviewer's spend toward the session budget", () => {
    const h = working();
    h.run({ type: 'spend.reported', claude_session_id: WORKER, total_usd: 0.5 });
    h.complete({});
    h.started();
    h.run({ type: 'agent.claude_session_id', claude_session_id: REVIEWER });
    const r = h.run({ type: 'spend.reported', claude_session_id: REVIEWER, total_usd: 0.2 });
    expect(r.snapshot.spend_usd).toBeCloseTo(0.7);
    expect(r.snapshot.claude_spend_totals).toEqual({ [WORKER]: 0.5, [REVIEWER]: 0.2 });
    // The next reviewer's --max-budget-usd backstop is what is left.
    h.complete(testsMissing as never);
    h.started();
    const again = h.complete({});
    expect(find(again.effects, 'start_session')?.max_budget_usd).toBeCloseTo(2.3);
  });

  it('budget.exceeded → on_budget_exceeded, returning to the source state', () => {
    const h = reviewing();
    const r = h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 3.1, limit: 3 });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      return_to: 'implement',
      review: null,
    });
    expect(types(r.effects)).toContain('kill');
    expect(find(r.effects, 'create_input_request')?.kind).toBe('budget_exceeded');
  });

  it('cancel → failed, the reviewer killed, the review cleared', () => {
    const h = reviewing();
    const r = h.run({ type: 'operator.cancel' });
    expect(r.snapshot).toMatchObject({ status: 'failed', review: null });
    expect(types(r.effects)).toContain('kill');
  });
});

describe('a gate on a counted transition (attach / retries)', () => {
  it('reviews the goto leg and carries the attachment into the target', () => {
    const raw = structuredClone(referenceWorkflow('m1_basic')) as WorkflowDefinitionInput;
    raw.states.build = {
      type: 'command',
      cmd: 'npm run build',
      on: {
        exit_0: 'test',
        fail: {
          goto: 'implement',
          attach: 'output',
          retries: 3,
          else: 'needs_input',
          requirements: { items: ['The failure is understood'], on_unmet: { goto: 'implement' } },
        },
      },
    };
    const h = new Harness(WorkflowDefinitionSchema.parse(raw)).claimAndStart();
    h.complete({});
    const r = h.cmdExit(2, 'error TS2304');
    expect(r.snapshot.workflow_state).toBe(reviewStateLabel('build', 'implement'));
    expect(r.snapshot.retry_counters).toEqual({ 'build->implement': 1 });
    h.started();
    const met = h.complete({
      verdict: [{ item: 'The failure is understood', met: true, reason: 'yes' }],
    } as never);
    expect(met.snapshot.workflow_state).toBe('implement');
    expect(find(met.effects, 'start_session')?.prompt).toContain('error TS2304');
  });
});

describe('parseVerdict', () => {
  it('matches items by text (case and whitespace ignored) and returns the gate order', () => {
    const v = parseVerdict(
      {
        verdict: [
          { item: '  no todo comments in CHANGED files', met: true, reason: 'none' },
          { item: 'New code paths have unit tests', met: false, reason: 'missing' },
        ],
      },
      ITEMS,
    );
    expect(v).toEqual({
      ok: true,
      items: [
        { item: ITEMS[0], met: false, reason: 'missing' },
        { item: ITEMS[1], met: true, reason: 'none' },
      ],
    });
  });

  it('falls back to position when the reviewer paraphrased every item', () => {
    const v = parseVerdict(
      {
        verdict: [
          { item: 'tests', met: true },
          { item: 'todos', met: false, reason: 'one TODO' },
        ],
      },
      ITEMS,
    );
    expect(v).toMatchObject({ ok: true, items: [{ met: true, reason: '' }, { met: false }] });
  });

  it('rejects malformed verdicts', () => {
    expect(parseVerdict({}, ITEMS)).toMatchObject({ ok: false });
    expect(parseVerdict({ verdict: [1] }, ITEMS)).toMatchObject({ ok: false });
    expect(parseVerdict({ verdict: [{ item: 'x', met: true, reason: 3 }] }, ITEMS)).toMatchObject({
      ok: false,
    });
    expect(parseVerdict({ verdict: [{ item: ITEMS[0]!, met: true }] }, ITEMS)).toEqual({
      ok: false,
      error: 'no verdict for: "No TODO comments in changed files"',
    });
  });
});

describe('the review tool alias', () => {
  it('resolves read-only: no edit tools, exact git inspection only, never push', () => {
    const p = resolveToolPolicy(['review']);
    expect(p.builtin).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(p.builtin).not.toContain('Edit');
    expect(p.builtin).not.toContain('Write');
    expect(p.allow).toContain('Bash(git diff)');
    expect(p.allow).toContain('Bash(git log --oneline -n 20)');
    expect(p.allow).toContain('Bash(git show)');
    const bash = p.allow.filter((r) => r.startsWith('Bash('));
    expect(bash.every((r) => r.startsWith('Bash(git ') && !r.endsWith(':*)'))).toBe(true);
    for (const write of ['add', 'commit', 'restore', 'checkout', 'reset', 'push'])
      expect(bash.some((r) => r.startsWith(`Bash(git ${write}`))).toBe(false);
    expect(bash.some((r) => r.includes('--output'))).toBe(false);
    expect(p.deny).toContain('Bash(git push:*)');
  });
});
