import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../workflow/schema.js';
import { apply } from './apply.js';
import { Harness, referenceWorkflow, uuid } from './apply.testkit.js';
import { isOutboxEffect, type EngineEvent, type SessionSnapshot } from './types.js';

// M1-T04 acceptance: "no event sequence leaves a session in an undefined state". Random event
// sequences (biased towards ones the session can actually take) run through apply with the
// wrapper stand-in; after every step the result must parse and the snapshot must be coherent.

const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001';
const REQ = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** Which statuses each state type may be in (plus `failed` anywhere, after a cancel). */
const STATUS_BY_TYPE: Record<string, readonly string[]> = {
  agent: ['queued', 'assigned', 'running'],
  command: ['queued', 'running'],
  connector: ['queued', 'running'],
  event: ['waiting_external'],
  human: ['needs_input'],
  terminal: ['done'],
};

type Gen = (h: Harness, pick: number) => EngineEvent;

/** Event generators; `pick` chooses between plausible and stale ids/values. */
const GENS: Gen[] = [
  (_h, p) => ({ type: 'session.assigned', machine_id: p % 2 ? 'mbp-ben' : 'mini' }),
  (h, p) => ({
    type: 'command.refused',
    command_id: p % 3 === 0 ? uuid(9999) : (h.snap.agent_command_id ?? uuid(1)),
    command_kind: (['start_session', 'send_input', 'run_cmd', 'kill', 'connector_call'] as const)[
      p % 5
    ]!,
    reason: p % 2 ? 'no_live_process' : 'ack_timeout',
  }),
  (h, p) => ({
    type: 'session.started',
    command_id: p % 4 === 0 ? uuid(9998) : (h.snap.agent_command_id ?? uuid(2)),
    worktree_path: '/tmp/wt',
    branch: 'b',
    port_range: { base: 41000, count: 10 },
  }),
  () => ({ type: 'agent.claude_session_id', claude_session_id: CLAUDE }),
  (_h, p) => ({
    type: 'agent.complete_state',
    result: p % 2 ? { pr_url: 'https://x/pull/1' } : {},
  }),
  (_h, p) => ({ type: 'agent.ask_user', question: `q${p}` }),
  (h, p) => ({
    type: 'agent.exited',
    command_id: p % 4 === 0 ? uuid(9997) : (h.snap.agent_command_id ?? uuid(3)),
    code: p % 2,
    signal: null,
  }),
  (_h, p) => ({
    type: 'command.exited',
    command_id: uuid(5000 + p),
    exit_code: p % 3 === 0 ? 0 : p % 3 === 1 ? 1 : null,
    timed_out: p % 7 === 0,
    output_tail: `out ${p}`,
  }),
  (_h, p) => ({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: p / 10 }),
  (h, p) => {
    const states = Object.keys(h.def.states);
    const e: EngineEvent = { type: 'input.provided', input_request_id: REQ, answer: `a${p}` };
    return p % 3 === 0 ? { ...e, goto: states[p % states.length]! } : e;
  },
  (_h, p) => ({
    type: 'external.event',
    name: ['ui.approve', 'pr.approved', 'pr.changes_requested', 'nope'][p % 4]!,
  }),
  (h, p) => ({
    type: 'timer.fired',
    state: p % 5 === 0 ? 'other' : (h.snap.workflow_state ?? 'implement'),
    deadline: p % 5 === 1 ? h.now.toISOString() : (h.snap.state_deadline ?? h.now.toISOString()),
  }),
  (_h, p) => ({
    type: 'budget.exceeded',
    dimension: p % 2 ? 'usd' : 'minutes',
    spent: 3,
    limit: 2,
  }),
  () => ({ type: 'operator.cancel' }),
];

/** The event that moves the session along its happy path (or into a human state and out). */
const progress: Gen = (h, p) => {
  const s = h.snap;
  const state = s.workflow_state === null ? undefined : h.def.states[s.workflow_state];
  if (s.status === 'queued') return { type: 'session.assigned', machine_id: 'mbp-ben' };
  if (s.status === 'assigned') return GENS[2]!(h, 1); // matching started
  if (s.status === 'needs_input') {
    const states = Object.keys(h.def.states);
    const e: EngineEvent = { type: 'input.provided', input_request_id: REQ, answer: `a${p}` };
    return p % 2 ? { ...e, goto: states[Math.floor(p / 2) % states.length]! } : e;
  }
  if (state?.type === 'agent') {
    return p % 5 === 0
      ? { type: 'agent.ask_user', question: `q${p}` }
      : { type: 'agent.complete_state', result: { pr_url: 'https://x/pull/1' } };
  }
  if (state?.type === 'command') {
    return {
      type: 'command.exited',
      command_id: uuid(7000 + p),
      exit_code: p % 3 === 0 ? 1 : 0,
      timed_out: false,
      output_tail: `out ${p}`,
    };
  }
  if (state?.type === 'event') {
    return { type: 'external.event', name: state.wait_for[p % state.wait_for.length]! };
  }
  // connector states have no result event in M1: leave through the budget route
  return { type: 'budget.exceeded', dimension: 'usd', spent: 3, limit: 2 };
};

const CANCEL = GENS.length - 1;
const PROGRESS = GENS.length;

/** Mostly progress, plenty of noise, rare cancels, so sequences get deep into the workflow. */
const stepArb = fc.record({
  gen: fc.oneof(
    { weight: 12, arbitrary: fc.constant(PROGRESS) },
    { weight: 10, arbitrary: fc.integer({ min: 0, max: CANCEL - 1 }) },
    { weight: 1, arbitrary: fc.constant(CANCEL) },
  ),
  pick: fc.noBias(fc.nat({ max: 1000 })),
  seconds: fc.nat({ max: 7200 }),
});

const eventFor = (gen: number, h: Harness, pick: number): EngineEvent =>
  gen === PROGRESS ? progress(h, pick) : GENS[gen]!(h, pick);

function checkInvariants(def: WorkflowDefinition, prev: SessionSnapshot, h: Harness): void {
  const s = h.snap;
  const r = h.last;
  if (r.ignored !== null) {
    expect(r.effects).toEqual([]);
    expect(r.snapshot).toEqual(prev);
  }
  if (s.workflow_state === null) {
    expect(['queued', 'failed']).toContain(s.status);
  } else {
    const state = def.states[s.workflow_state];
    expect(state, `unknown state ${s.workflow_state}`).toBeDefined();
    if (s.status !== 'failed') expect(STATUS_BY_TYPE[state!.type]).toContain(s.status);
    if (state!.type === 'human' && s.status === 'needs_input') {
      // every route into a human state is recorded (null only for an entry from nowhere)
      expect(s.return_to === null || def.states[s.return_to] !== undefined).toBe(true);
    }
  }
  if (s.status === 'done' || s.status === 'failed') expect(s.pending_answer).toBeNull();
  if (s.status === 'queued') {
    expect(s.machine_id).toBeNull();
    expect(s.state_deadline).toBeNull();
  }
  if (r.effects.some(isOutboxEffect)) expect(r.snapshot.machine_id).not.toBeNull();
  for (const [key, n] of Object.entries(s.retry_counters)) {
    const [from = '', to = ''] = key.split('->');
    const t = def.states[from] && 'on' in def.states[from] ? def.states[from].on : undefined;
    const loop = Object.values(t ?? {}).find((x) => typeof x === 'object' && x.goto === to);
    const cap =
      loop && typeof loop === 'object'
        ? (loop.retries ?? def.budget.max_loop_retries)
        : def.budget.max_loop_retries;
    expect(n).toBeLessThanOrEqual(cap);
  }
  expect(s.wall_seconds).toBeGreaterThanOrEqual(prev.wall_seconds);
  expect(s.spend_usd).toBeGreaterThanOrEqual(prev.spend_usd);
}

describe.each(['m1_basic', 'pr_flow'] as const)('apply property: %s', (name) => {
  const def = referenceWorkflow(name);

  it('no event sequence leaves the session undefined', () => {
    const reached = new Set<string>();
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const h = new Harness(def);
        for (const { gen, pick, seconds } of steps) {
          const prev = h.snap;
          h.advance(seconds);
          h.run(eventFor(gen, h, pick));
          checkInvariants(def, prev, h);
          if (h.snap.workflow_state !== null) reached.add(h.snap.workflow_state);
        }
      }),
      { numRuns: 400 },
    );
    // the sequences actually exercise the whole workflow, not just the first state
    expect([...reached].sort()).toEqual(Object.keys(def.states).sort());
  });

  it('terminal sessions ignore every event', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: GENS.length - 1 }), fc.nat(1000), (gen, pick) => {
        const h = new Harness(def).claimAndStart();
        h.run({ type: 'operator.cancel' });
        const snap = h.snap;
        const r = apply(def, snap, GENS[gen]!(h, pick), h.now);
        expect(r).toEqual({ snapshot: snap, effects: [], ignored: 'session_terminal' });
      }),
    );
  });
});
