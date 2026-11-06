/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { Harness, freshSnapshot } from './apply.testkit.js';
import { holdersOf, type HolderCandidate } from './concurrency.js';
import { moveStateLabel, type ApplyResult, type Effect, type GateStep } from './types.js';

// ADR-0037 P4 (T7): `requires.concurrency` holds a move in the `held` phase before its checks.
// apply only decides: the EngineService wrapper answers the step's timer with
// `concurrency.checked {holders}` (simulated here, with `holdersOf` where the rule matters).

const MIN = 60_000;
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const RAW = {
  id: 'conc_flow',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  notify: { default: 'once', engine_moves: 'never' },
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash'],
      timeout: '2h',
      on: {
        pr_ready: {
          goto: 'in_review',
          title: 'PR ready for review',
          when: 'Done.',
          handoff: true,
          notify: 'once',
          requires: {
            checks: [{ name: 'Build', cmd: 'make build' }],
            condition_poll: '2m',
            concurrency: {
              key: '$repo',
              max_in_flight: 1,
              scope: ['in_review'],
              overlap: 'planned_files',
              hold_timeout: '1h',
            },
          },
          on_unmet: { goto: 'implementing', retries: 2, else: 'needs_input' },
        },
        ask_user: { goto: 'needs_input', when: 'Blocked.', notify: 'every' },
        timeout: 'needs_input',
      },
    },
    in_review: {
      type: 'human',
      title: 'In review',
      on: {
        done: { goto: 'done', title: 'Merged, done', actor: 'human' },
        request_changes: { goto: '$return_to', title: 'Request changes', actor: 'human' },
      },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: {
        answer: { goto: '$return_to', title: 'Back with this answer', actor: 'human' },
        done: { goto: 'done', title: 'Done', actor: 'human' },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

const DEF = WorkflowDefinitionSchema.parse(RAW);
const LABEL = moveStateLabel('implementing', 'in_review', 'pr_ready');

function defWith(mutate: (raw: Record<string, any>) => void): WorkflowDefinition {
  const raw = structuredClone(RAW) as Record<string, any>;
  mutate(raw);
  return WorkflowDefinitionSchema.parse(raw);
}

const of = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);

/** Running in implementing, then the agent takes `pr_ready` (the step starts). */
function moving(def: WorkflowDefinition = DEF): Harness {
  const h = new Harness(def, freshSnapshot(def)).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: {},
    transition: 'pr_ready',
    reason: 'Ready for review.',
  });
  return h;
}

/** The wrapper's answer to the held step's timer (the clock moves to it). */
function checked(h: Harness, holders: string[]): ApplyResult {
  const deadline = h.snap.state_deadline!;
  if (Date.parse(deadline) > h.now.getTime()) h.now = new Date(deadline);
  return h.run({
    type: 'concurrency.checked',
    state: h.snap.workflow_state!,
    deadline,
    holders: holders.map((t, i) => ({ session_id: `s${i}`, ticket_id: t })),
  });
}

/** Pass the step's one check (→ in_review). */
function passChecks(h: Harness): ApplyResult {
  return h.cmdExit(0);
}

describe('held phase', () => {
  it('the test workflow validates without allowUnavailable (rule 14 lifted, rule 20)', () => {
    const res = validateWorkflow(RAW);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('a move with concurrency starts held: waiting_external, checked at once, nothing runs', () => {
    const h = moving();
    expect(h.snap.workflow_state).toBe(LABEL);
    expect(h.snap.status).toBe('waiting_external');
    expect(h.snap.state_deadline).toBe(h.now.toISOString());
    expect(h.snap.step).toMatchObject({
      phase: 'held',
      held: false,
      started_at: h.now.toISOString(),
      hold: { behind: [], since: h.now.toISOString() },
    });
    expect(h.snap.step!.hold!.deadline).toBe(new Date(h.now.getTime() + 60 * MIN).toISOString());
    expect(of(h.last.effects, 'run_cmd')).toEqual([]);
    expect(of(h.last.effects, 'hold_changed')).toEqual([]);
  });

  it('no holders: on to the checks, and the landing is a plain transition (never held)', () => {
    const h = moving();
    const r = checked(h, []);
    expect(h.snap.step).toMatchObject({ phase: 'checks', hold: null, held: false });
    expect(h.snap.status).toBe('running');
    expect(of(r.effects, 'run_cmd')).toHaveLength(1);
    expect(of(r.effects, 'hold_changed')).toEqual([]);
    const land = passChecks(h);
    expect(h.snap.workflow_state).toBe('in_review');
    expect(of(land.effects, 'state_entered').at(-1)).toMatchObject({
      to: 'in_review',
      cause: 'transition',
      transition: 'pr_ready',
    });
  });

  it('at max: held, behind the holders, silent, re-checked every poll', () => {
    const h = moving();
    const r = checked(h, [A]);
    expect(h.snap.step).toMatchObject({ phase: 'held', held: true, hold: { behind: [A] } });
    expect(h.snap.status).toBe('waiting_external');
    expect(h.snap.state_deadline).toBe(new Date(h.now.getTime() + 2 * MIN).toISOString());
    expect(of(r.effects, 'hold_changed')).toEqual([
      {
        type: 'hold_changed',
        state: LABEL,
        held: true,
        behind: [A],
        since: h.snap.step!.hold!.since,
      },
    ]);
    // Silent: no question, no state change, no run.
    expect(of(r.effects, 'create_input_request')).toEqual([]);
    expect(of(r.effects, 'state_entered')).toEqual([]);
    expect(of(r.effects, 'run_cmd')).toEqual([]);
    // Still held on the next check: one hold_changed only.
    const again = checked(h, [A, B]);
    expect(h.snap.step!.hold!.behind).toEqual([A, B]);
    expect(of(again.effects, 'hold_changed')).toEqual([]);
  });

  it('released: the checks run, and the landing records concurrency_released and pushes', () => {
    const h = moving();
    checked(h, [A]);
    h.advance(300);
    const r = checked(h, []);
    expect(of(r.effects, 'hold_changed')).toEqual([
      expect.objectContaining({ held: false, cause: 'concurrency_released', behind: [A] }),
    ]);
    expect(of(r.effects, 'hold_changed')[0]!.held_ms).toBeGreaterThanOrEqual(5 * MIN);
    expect(h.snap.step).toMatchObject({ phase: 'checks', held: true, hold: null });
    expect(of(r.effects, 'run_cmd')).toHaveLength(1);
    const land = passChecks(h);
    expect(h.snap.workflow_state).toBe('in_review');
    const entered = of(land.effects, 'state_entered').at(-1)!;
    expect(entered).toMatchObject({
      to: 'in_review',
      cause: 'concurrency_released',
      transition: 'pr_ready',
      actor: 'agent',
    });
    // The hand-off still notifies as its own transition (`once`).
    expect(entered.notify_decision).toEqual({ via: 'pr_ready', mode: 'once', decision: 'push' });
    expect(of(land.effects, 'create_input_request')[0]).toMatchObject({ kind: 'handoff' });
  });

  it('hold_timeout at max → on_unmet.else, kind timeout, silent under engine_moves never', () => {
    const h = moving();
    checked(h, [A]);
    // Every poll is capped at the hold's deadline.
    let r = checked(h, [A]);
    while (h.snap.step !== null) {
      expect(Date.parse(h.snap.state_deadline!)).toBeLessThanOrEqual(
        Date.parse(h.snap.step.hold!.deadline),
      );
      r = checked(h, [A]);
    }
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(h.snap.step).toBeNull();
    expect(of(r.effects, 'hold_changed')).toEqual([
      expect.objectContaining({ held: false, cause: 'timeout' }),
    ]);
    const req = of(r.effects, 'create_input_request')[0]!;
    expect(req.kind).toBe('timeout');
    expect(req.question).toContain(`#${A.slice(0, 8)}`);
    expect(of(r.effects, 'state_entered').at(-1)).toMatchObject({
      to: 'needs_input',
      cause: 'timeout',
    });
    expect(req.notify_decision).toMatchObject({ decision: 'silent' });
  });

  it('a raw timer while held only times it out, never releases', () => {
    const h = moving();
    checked(h, [A]);
    const deadline = h.snap.state_deadline!;
    h.now = new Date(deadline);
    h.run({ type: 'timer.fired', state: LABEL, deadline });
    expect(h.snap.step).toMatchObject({ phase: 'held', held: true });
    h.now = new Date(Date.parse(h.snap.step!.hold!.deadline));
    h.run({ type: 'timer.fired', state: LABEL, deadline: h.snap.state_deadline! });
    expect(h.snap.workflow_state).toBe('needs_input');
  });

  it('a stale concurrency.checked is ignored (wrong deadline, wrong phase, outside a step)', () => {
    const h = moving();
    const r = h.run({
      type: 'concurrency.checked',
      state: LABEL,
      deadline: new Date(h.now.getTime() + 1).toISOString(),
      holders: [],
    });
    expect(r.ignored).toBe('stale_timer');
    checked(h, []); // released: now in checks
    const deadline = h.snap.state_deadline ?? h.now.toISOString();
    expect(
      h.run({ type: 'concurrency.checked', state: LABEL, deadline, holders: [] }).ignored,
    ).toBe('stale_timer');
    passChecks(h);
    expect(
      h.run({ type: 'concurrency.checked', state: 'in_review', deadline, holders: [] }).ignored,
    ).toBe('stale_timer');
  });

  it('max_in_flight 2 holds only at two', () => {
    const h = moving(
      defWith((d) => (d.states.implementing.on.pr_ready.requires.concurrency.max_in_flight = 2)),
    );
    checked(h, [A]);
    expect(h.snap.step!.phase).toBe('checks');
    const h2 = moving(
      defWith((d) => (d.states.implementing.on.pr_ready.requires.concurrency.max_in_flight = 2)),
    );
    checked(h2, [A, B]);
    expect(h2.snap.step!.phase).toBe('held');
  });

  it("a human's message while held hands the ticket back to the agent", () => {
    const h = moving();
    checked(h, [A]);
    const r = h.run({ type: 'operator.message', text: 'Rebase first.' });
    expect(r.ignored).toBeNull();
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.step).toBeNull();
    expect(of(r.effects, 'hold_changed')).toEqual([
      expect.objectContaining({ held: false, cause: 'left' }),
    ]);
    expect(of(r.effects, 'start_session')).toHaveLength(1);
  });

  it('a cancel while held ends the hold (audit: left)', () => {
    const h = moving();
    checked(h, [A]);
    const r = h.run({ type: 'operator.cancel' });
    expect(h.snap.status).toBe('failed');
    expect(of(r.effects, 'hold_changed')).toEqual([
      expect.objectContaining({ held: false, cause: 'left' }),
    ]);
  });

  it('a held session that loses its machine parks like the conditions phase', () => {
    const h = moving();
    checked(h, [A]);
    h.run({ type: 'machine.lost', machine_id: 'mbp-ben', reason: 'lease_expired' });
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(h.snap.step).toBeNull();
  });

  it('released with no machine: requeued, and the claim runs the checks', () => {
    const h = moving();
    checked(h, [A]);
    // As after a lost-machine park or a requeue: the session holds no machine.
    h.snap = { ...h.snap, machine_id: null };
    checked(h, []);
    expect(h.snap.status).toBe('queued');
    expect(h.snap.step!.phase).toBe('checks');
    const r = h.run({ type: 'session.assigned', machine_id: 'mbp-2' });
    expect(of(r.effects, 'run_cmd')).toHaveLength(1);
  });

  it('a re-claim while held keeps waiting (no checks)', () => {
    const h = moving();
    checked(h, [A]);
    h.snap = { ...h.snap, status: 'queued', machine_id: null };
    const r = h.run({ type: 'session.assigned', machine_id: 'mbp-2' });
    expect(h.snap.status).toBe('waiting_external');
    expect(h.snap.step!.phase).toBe('held');
    expect(of(r.effects, 'run_cmd')).toEqual([]);
  });
});

describe('planned_files: no evidence, no hold', () => {
  const rule = (() => {
    const s = DEF.states.implementing!;
    if (s.type !== 'agent') throw new Error('agent');
    const t = s.on!.pr_ready!;
    if (typeof t === 'string') throw new Error('object');
    return t.requires!.concurrency!;
  })();
  const inReview = (id: string, files: string[] | null): HolderCandidate => ({
    session_id: id,
    ticket_id: `t-${id}`,
    kind: null,
    workflow_state: 'in_review',
    step: null,
    files,
  });

  /** The held session's holders, fed to apply as the wrapper does. */
  function heldWith(selfFiles: string[] | null, others: HolderCandidate[]): Harness {
    const h = moving();
    const step = h.snap.step as GateStep;
    const holders = holdersOf(
      { session_id: h.snap.id, kind: null, files: selfFiles, started_at: step.started_at },
      rule,
      others,
    );
    checked(
      h,
      holders.map((x) => x.ticket_id),
    );
    return h;
  }

  it('both have files and they intersect: held', () => {
    const h = heldWith(['packages/web/src/**'], [inReview('x', ['packages/web/src/App.tsx'])]);
    expect(h.snap.step!.phase).toBe('held');
  });

  it('both have files, disjoint: not held', () => {
    const h = heldWith(['packages/web/src/**'], [inReview('x', ['packages/daemon/src/a.ts'])]);
    expect(h.snap.step!.phase).toBe('checks');
  });

  it('a session without files is never held', () => {
    const h = heldWith(null, [inReview('x', ['packages/web/src/App.tsx'])]);
    expect(h.snap.step!.phase).toBe('checks');
  });

  it('a holder without files never holds others', () => {
    const h = heldWith(['packages/web/src/**'], [inReview('x', null)]);
    expect(h.snap.step!.phase).toBe('checks');
  });
});
