import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import {
  WorkflowDefinitionSchema,
  type TicketKind,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { transitionObject, transitionsOf } from '../workflow/transition-rules.js';
import { apply } from './apply.js';
import { freshSnapshot, Harness, HEAD_SHA, referenceWorkflow, uuid } from './apply.testkit.js';
import { entryStateLabel, reviewStateLabel } from './review.js';
import { lostAnswerOf, machineLostMarkOf } from './machine-lost.js';
import {
  isOutboxEffect,
  moveStateLabel,
  type ApplyIgnoreReason,
  type EngineEvent,
  type SessionSnapshot,
} from './types.js';

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
    command_kind: (
      ['start_session', 'send_input', 'send_message', 'run_cmd', 'kill', 'connector_call'] as const
    )[p % 6]!,
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
  (_h, p) => ({ type: 'agent.no_outcome', last_output: `o${p}` }),
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
  (_h, p) => ({ type: 'operator.message', text: p % 2 ? '/context' : `m${p}` }),
  // ADR-0011 (M1b-T03): named agent transitions (declared or not), human moves, action results.
  (h, p) => ({
    type: 'agent.complete_state',
    result: p % 2 ? { plan: 'P', summary: 's' } : {},
    transition: anyName(h, p),
    reason: p % 5 === 0 ? null : `r${p}`,
  }),
  (h, p) => ({
    type: 'human.transition',
    name: anyName(h, p),
    text: p % 3 === 0 ? null : `t${p}`,
    actor: 'ui',
    input_request_id: p % 2 ? REQ : null,
  }),
  (_h, p) => ({
    type: 'action.completed',
    command_id: uuid(6000 + p),
    action: p % 4 === 0 ? 'evaluate_conditions' : 'open_pr',
    result: p % 3 === 0 ? null : { pr_url: 'https://github.com/o/r/pull/1' },
    error: p % 3 === 0 ? 'gh failed' : null,
  }),
  // M2-T06 (U-068): a lost machine, the session's own or another one, every reason (machine and
  // reason vary independently).
  (h, p) => ({
    type: 'machine.lost',
    machine_id:
      p % 3 === 0
        ? 'mini'
        : (machineLostMarkOf(h.snap.context)?.machine_id ?? h.snap.machine_id ?? 'mbp-ben'),
    reason: (['lease_expired', 'pinned_machine_offline', 'revoked'] as const)[
      Math.floor(p / 3) % 3
    ]!,
    ...(p % 2 ? { machine_name: 'Ben' } : {}),
    ...(p % 5 === 0 ? { offline_ms: 3_600_000 } : {}),
  }),
  () => ({ type: 'operator.cancel' }),
];

type LostEvent = Extract<EngineEvent, { type: 'machine.lost' }>;

/**
 * The 10-contracts "Lost machines" table as an oracle, written apart from machine-lost.ts: the
 * row `e` falls in for snapshot `s`, and the ignore reason it must give (null = applied).
 */
function lostRow(s: SessionSnapshot, e: LostEvent): [string, ApplyIgnoreReason | null] {
  if (['done', 'failed', 'lost'].includes(s.status)) return ['terminal', 'session_terminal'];
  if (['assigned', 'running', 'waiting_external'].includes(s.status)) {
    return s.machine_id === e.machine_id
      ? ['(A) on machine', null]
      : ['mismatch', 'machine_mismatch'];
  }
  const mark = machineLostMarkOf(s.context);
  if (s.status === 'queued' && e.reason === 'pinned_machine_offline') {
    return ['(A) queued pinned', null];
  }
  if (e.reason === 'revoked' && mark !== null && mark.machine_id === e.machine_id) {
    return ['(B) revoked, marked', null];
  }
  if (e.reason === 'revoked' && s.status === 'queued' && mark === null) {
    return ['(A) queued revoked, no mark', null];
  }
  return ['other', 'wrong_status'];
}
const LOST_ROWS = [
  'terminal',
  '(A) on machine',
  'mismatch',
  '(A) queued pinned',
  '(B) revoked, marked',
  '(A) queued revoked, no mark',
  'other',
];

/** A transition name of any state (or a made-up one), so allowed and refused names both occur. */
function anyName(h: Harness, p: number): string {
  const names = Object.values(h.def.states).flatMap((st) =>
    st.type === 'terminal' ? [] : Object.keys(st.on ?? {}),
  );
  return p % 7 === 0 ? 'nope' : (names[p % Math.max(1, names.length)] ?? 'nope');
}

/** The event that moves the session along its happy path (or into a human state and out). */
const progress: Gen = (h, p) => {
  const s = h.snap;
  const state = s.workflow_state === null ? undefined : h.def.states[s.workflow_state];
  // U-068: now and then the lost machine of a parked or pinned session is revoked (row B).
  const mark = machineLostMarkOf(s.context);
  if (
    mark !== null &&
    mark.reason !== 'revoked' &&
    (s.status === 'needs_input' || s.status === 'queued') &&
    p % 7 === 0
  ) {
    return { type: 'machine.lost', machine_id: mark.machine_id, reason: 'revoked' };
  }
  if (s.status === 'queued') return { type: 'session.assigned', machine_id: 'mbp-ben' };
  if (s.status === 'assigned') return GENS[2]!(h, 1); // matching started
  if (s.step !== null) {
    // A gate step: pass (or fail) its current phase.
    if (s.step.phase === 'checks') {
      return {
        type: 'command.exited',
        command_id: uuid(8000 + p),
        exit_code: p % 4 === 0 ? 1 : 0,
        timed_out: false,
        output_tail: `out ${p}`,
        head_sha: HEAD_SHA,
      };
    }
    if (s.step.phase === 'review') {
      return { type: 'agent.complete_state', result: { verdict: [] } };
    }
    return {
      type: 'action.completed',
      command_id: uuid(8500 + p),
      action: 'open_pr',
      result: { pr_url: 'https://github.com/o/r/pull/1' },
      error: null,
    };
  }
  const kind = s.ticket.kind ?? null;
  if (s.status === 'needs_input' || (state?.type === 'event' && p % 3 === 0)) {
    const humans =
      s.workflow_state === null
        ? []
        : transitionsOf(h.def, s.workflow_state, { actor: 'human', kind });
    if (humans.length > 0 && p % 3 !== 2) {
      const t = humans[p % humans.length]!;
      return {
        type: 'human.transition',
        name: t.name,
        text: `t${p}`,
        actor: 'ui',
        input_request_id: REQ,
      };
    }
    if (s.status === 'needs_input') {
      const states = Object.keys(h.def.states);
      const e: EngineEvent = { type: 'input.provided', input_request_id: REQ, answer: `a${p}` };
      return p % 2 ? { ...e, goto: states[Math.floor(p / 2) % states.length]! } : e;
    }
  }
  if (state?.type === 'agent') {
    const agents =
      s.workflow_state === null
        ? []
        : transitionsOf(h.def, s.workflow_state, { actor: 'agent', kind });
    if (agents.length > 0 && p % 4 !== 0) {
      const t = agents[p % agents.length]!;
      return {
        type: 'agent.complete_state',
        result: { plan: 'P', summary: 's', pr_url: 'https://x/pull/1' },
        transition: t.name,
        reason: `r${p}`,
      };
    }
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
  // apply never changes the fencing token (the wrapper bumps it, 10-contracts §Lost machines).
  expect(r.snapshot.fencing_token).toBe(prev.fencing_token);
  if (s.step !== null && s.status !== 'failed') {
    // A gate step: its synthetic label, in the source state's column.
    const r = s.step;
    const label =
      r.kind === 'move'
        ? moveStateLabel(r.from, r.to, r.transition ?? r.outcome)
        : r.kind === 'entry'
          ? entryStateLabel(r.from, r.to)
          : reviewStateLabel(r.from, r.to);
    expect(s.workflow_state).toBe(label);
    expect(def.states[r.from]).toBeDefined();
    expect(def.states[r.to]).toBeDefined();
    expect(['queued', 'assigned', 'running', 'waiting_external']).toContain(s.status);
  } else if (s.workflow_state === null) {
    expect(['queued', 'failed']).toContain(s.status);
  } else if (s.status === 'failed' && def.states[s.workflow_state] === undefined) {
    // cancelled during a gate step: the session ends on the step's label
    expect(s.workflow_state).toMatch(/ \((move: .+|entry|review)\)$/);
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
  // §Pending answer: cleared when apply enters a different state, unless it delivers an answer
  // (an `input.provided`, or a human's text delivered to an agent by a transition or a move).
  // A requeue into an agent state (U-068: an answer out of a lost-machine park) keeps the answer
  // for the re-claim's start_session.
  const requeuedAgent =
    s.status === 'queued' &&
    s.workflow_state !== null &&
    def.states[s.workflow_state]?.type === 'agent';
  const delivers =
    requeuedAgent || r.effects.some((e) => e.type === 'start_session' || e.type === 'send_input');
  if (s.workflow_state !== prev.workflow_state && !delivers) {
    expect(s.pending_answer).toBeNull();
  }
  if (s.status === 'queued') {
    expect(s.machine_id).toBeNull();
    expect(s.state_deadline).toBeNull();
  }
  // Every outbox command but connector_call (target `connector:<name>`) goes to the machine.
  if (r.effects.some((e) => isOutboxEffect(e) && e.type !== 'connector_call')) {
    expect(r.snapshot.machine_id).not.toBeNull();
  }
  for (const [key, n] of Object.entries(s.retry_counters)) {
    const move = /^move:([^:]+):(.+)$/.exec(key);
    if (move !== null) {
      // a move's unmet loop is capped at its transition's on_unmet.retries
      const st = def.states[move[1]!];
      const raw = st !== undefined && st.type !== 'terminal' ? st.on?.[move[2]!] : undefined;
      expect(raw).toBeDefined();
      expect(n).toBeLessThanOrEqual(transitionObject(raw!).on_unmet?.retries ?? 0);
      continue;
    }
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

/**
 * m1_basic plus a direct agent→agent edge (implement.timeout → review → implement): the
 * reference workflows always pass through a human/command state between agents.
 */
function agentChain(): WorkflowDefinition {
  const m1 = referenceWorkflow('m1_basic');
  return WorkflowDefinitionSchema.parse({
    ...m1,
    states: {
      ...m1.states,
      implement: {
        ...m1.states.implement,
        on: { done: 'build', ask_user: 'needs_input', timeout: 'review' },
      },
      review: {
        type: 'agent',
        prompt: 'Review the change for {{ticket.title}}.',
        timeout: '30m',
        on: { done: 'build', ask_user: 'needs_input', timeout: 'implement' },
      },
    },
  });
}

const WORKFLOWS: [string, () => WorkflowDefinition, TicketKind | null][] = [
  ['m1_basic', () => referenceWorkflow('m1_basic'), null],
  ['pr_flow', () => referenceWorkflow('pr_flow'), null],
  ['agent_chain', agentChain, null],
  // ADR-0011: named transitions, kinds, human moves and move steps.
  ['conductor v2 (work)', () => CONDUCTOR_V2_DRAFT_DEF, 'work'],
  ['conductor v2 (personal)', () => CONDUCTOR_V2_DRAFT_DEF, 'personal'],
  ['conductor v2 (no kind)', () => CONDUCTOR_V2_DRAFT_DEF, null],
];

describe.each(WORKFLOWS)('apply property: %s', (_name, load, kind) => {
  const def = load();
  const fresh = (): SessionSnapshot => {
    const snap = freshSnapshot(def);
    return { ...snap, ticket: { ...snap.ticket, kind } };
  };

  it('no event sequence leaves the session undefined', () => {
    const reached = new Set<string>();
    const lostRows = new Set<string>();
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const h = new Harness(def, fresh());
        for (const { gen, pick, seconds } of steps) {
          const prev = h.snap;
          h.advance(seconds);
          const event = eventFor(gen, h, pick);
          h.run(event);
          checkInvariants(def, prev, h);
          if (event.type === 'machine.lost') {
            const [row, ignored] = lostRow(prev, event);
            lostRows.add(row);
            expect(h.last.ignored, row).toBe(ignored);
            if (ignored === null) {
              // A park keeps the answer the agent never ran on (it is delivered on Continue).
              expect(h.snap.status).toBe('needs_input');
              if (prev.pending_answer !== null) {
                expect(lostAnswerOf(h.snap.context)).toEqual(prev.pending_answer);
              }
            }
          }
          const at = h.snap.workflow_state;
          if (at !== null && def.states[at] !== undefined) reached.add(at);
          else if (at !== null && h.snap.step !== null) reached.add('(gate step)');
        }
      }),
      { numRuns: 1000 },
    );
    // the sequences actually exercise the whole workflow, not just the first state
    // (and a workflow with `requires` gets into its move steps)
    const gated = def.id === CONDUCTOR_V2_DRAFT_DEF.id && def.version === 2;
    expect([...reached].sort()).toEqual(
      [...Object.keys(def.states), ...(gated ? ['(gate step)'] : [])].sort(),
    );
    // every row of the lost-machines table is exercised
    expect([...lostRows].sort()).toEqual([...LOST_ROWS].sort());
  });

  it('terminal sessions ignore every event', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: GENS.length - 1 }), fc.nat(1000), (gen, pick) => {
        const h = new Harness(def, fresh()).claimAndStart();
        h.run({ type: 'operator.cancel' });
        const snap = h.snap;
        const r = apply(def, snap, GENS[gen]!(h, pick), h.now);
        expect(r).toEqual({ snapshot: snap, effects: [], ignored: 'session_terminal' });
      }),
    );
  });
});
