import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../domain.js';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import {
  MOVE_CAUSES,
  WorkflowDefinitionSchema,
  type TicketKind,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { transitionObject, transitionsOf } from '../workflow/transition-rules.js';
import { validateWorkflow } from '../workflow/validate.js';
import { apply } from './apply.js';
import {
  freshSnapshot,
  Harness,
  HEAD_SHA,
  qaDefinition,
  referenceWorkflow,
  uuid,
} from './apply.testkit.js';
import { QA_RESULT_FIXTURES } from './fixtures.js';
import { isQaState } from './qa.js';
import { QA_CONTEXT_KEY, QaContextSchema } from './qa.types.js';
import { entryStateLabel, reviewStateLabel } from './review.js';
import { lostAnswerOf, machineLostMarkOf } from './machine-lost.js';
import { defaultRuntime } from './default-answer.js';
import {
  isEngineMove,
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
    // M2r-T03: a QA start whose checkout failed.
    reason: p % 5 === 0 ? 'checkout_failed: x' : p % 2 ? 'no_live_process' : 'ack_timeout',
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
  // ADR-0041: the default sweep (the armed deadline, or a stale one) and a human's overrule.
  (h, p) => {
    const rt = defaultRuntime(h.snap.context);
    return {
      type: 'default.fired',
      state: p % 5 === 0 ? 'other' : (rt?.state ?? h.snap.workflow_state ?? 'implement'),
      deadline: p % 3 === 0 || rt === null ? h.now.toISOString() : rt.at,
      input_request_id: REQ,
    };
  },
  (_h, p) => ({
    type: 'human.overrule',
    input_request_id: p % 4 === 0 ? uuid(9996) : REQ,
    text: `o${p}`,
    actor: 'ui',
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
  // ADR-0041: now and then nobody answers and the armed default is taken.
  const armed = defaultRuntime(s.context);
  if (s.status === 'needs_input' && armed !== null && p % 4 === 3) {
    return {
      type: 'default.fired',
      state: armed.state,
      deadline: armed.at,
      input_request_id: REQ,
    };
  }
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
  if (isQaState(state) && p % 4 !== 0) {
    // M2r-T03: a QA reports a result that matches its transition (now and then one that doesn't).
    const pick = (['qa_pass', 'qa_fail', 'qa_needs_human'] as const)[p % 3]!;
    const result =
      pick === 'qa_fail'
        ? QA_RESULT_FIXTURES.fail
        : p % 11 === 0
          ? QA_RESULT_FIXTURES.fail
          : QA_RESULT_FIXTURES.pass;
    return {
      type: 'agent.complete_state',
      result: result as unknown as JsonObject,
      transition: pick,
      reason: `r${p}`,
    };
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
        result: { plan: 'P', summary: 's', pr_url: 'https://x/pull/1', recommended: `R${p}` },
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
  // BUG-1: terminal ⇒ no agent process left attached, and a live one was killed on the way.
  const terminal = (x: SessionSnapshot) => ['done', 'failed', 'lost'].includes(x.status);
  if (terminal(s)) {
    expect(s.agent_process_live).toBe(false);
    expect(s.agent_command_id).toBeNull();
  }
  if (!terminal(prev) && terminal(s) && prev.machine_id !== null && prev.agent_process_live) {
    expect(r.effects.some((e) => e.type === 'kill')).toBe(true);
  }
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
  // M2r-T03: `__qa` is always well formed (round ≤ max_rounds), and only a QA definition has one.
  const qa = s.context[QA_CONTEXT_KEY];
  if (qa !== undefined) {
    expect(Object.values(def.states).some(isQaState)).toBe(true);
    expect(QaContextSchema.safeParse(qa).success).toBe(true);
  }
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

/**
 * The live `conductor` v5 definition (plan_review, in_review), a snapshot of what the orchestrator
 * stores, fetched 2026-11-04 with the conductor MCP `get_workflow` (WF-T06). Not a shipped
 * default, so it lives here rather than in docs/design/workflows. Refresh it when v5 is edited.
 */
function conductorV5Live(): WorkflowDefinition {
  const url = new URL('./fixtures/conductor.v5.live.json', import.meta.url);
  const result = validateWorkflow(JSON.parse(readFileSync(url, 'utf8')));
  if (!result.ok) throw new Error(`conductor.v5.live.json: ${JSON.stringify(result.errors)}`);
  return result.def;
}

/**
 * ADR-0041: the live v5 with an 8h `default` on every question rule 29 allows (ask_user and the
 * `question: true` transitions into a human state, but plan_needs_approval and anything with
 * `requires`).
 */
function conductorV5Defaults(): WorkflowDefinition {
  const url = new URL('./fixtures/conductor.v5.live.json', import.meta.url);
  const raw = JSON.parse(readFileSync(url, 'utf8')) as {
    states: Record<string, { type: string; on?: Record<string, unknown> }>;
  };
  let armed = 0;
  for (const st of Object.values(raw.states)) {
    if (st.type !== 'agent') continue;
    for (const [name, t] of Object.entries(st.on ?? {})) {
      if (typeof t !== 'object' || t === null) continue;
      const o = t as Record<string, unknown>;
      const target = raw.states[o.goto as string];
      if (
        target?.type === 'human' &&
        (o.question === true || name === 'ask_user') &&
        o.requires === undefined &&
        o.handoff === undefined &&
        name !== 'plan_needs_approval' &&
        name !== 'needs_approval_to_message'
      ) {
        o.default = { after: '8h', answer: '$recommended' };
        armed++;
      }
    }
  }
  if (armed === 0) throw new Error('no question to give a default');
  const result = validateWorkflow(raw);
  if (!result.ok) throw new Error(`v5 with defaults: ${JSON.stringify(result.errors)}`);
  return result.def;
}

// ---------------------------------------------------------------- seed (WF-T06, TD-163)

/**
 * Every run draws a fresh seed (so runs keep exploring new sequences) and prints it; set
 * APPLY_PROPERTY_SEED to replay one exactly. APPLY_PROPERTY_PATH (fast-check's `path` from a
 * failure report) jumps straight to the shrunk counterexample.
 */
function resolveSeed(raw: string | undefined): number {
  if (raw === undefined || raw === '') return Math.floor(Math.random() * 2 ** 31);
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`APPLY_PROPERTY_SEED must be an integer, got ${raw}`);
  return n;
}
const SEED = resolveSeed(process.env.APPLY_PROPERTY_SEED);
const PATH = process.env.APPLY_PROPERTY_PATH;
const REPLAY = `APPLY_PROPERTY_SEED=${SEED} pnpm vitest run --project shared src/engine/apply.property.test.ts`;
// Straight to stderr: vitest's default reporter hides console output of passing tests.
process.stderr.write(`apply.property seed=${SEED}  replay: ${REPLAY}\n`);

/** fast-check parameters for every property here: seeded, replayable. */
const fcParams = (numRuns?: number): fc.Parameters<unknown> => ({
  seed: SEED,
  ...(numRuns === undefined ? {} : { numRuns }),
  ...(PATH === undefined || PATH === '' ? {} : { path: PATH, endOnFailure: true }),
});

/** fc.assert, with the replay command in the failure message. */
function assertProperty<T>(name: string, property: fc.IProperty<T>, numRuns?: number): void {
  try {
    fc.assert(property, fcParams(numRuns));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[${name}] replay: ${REPLAY}\n${message}`, { cause: err });
  }
}

// ---------------------------------------------------------------- one step, every check

/** Where a snapshot is, for coverage: a state name, or `(gate step)` while a step runs. */
function placeOf(def: WorkflowDefinition, s: SessionSnapshot): string | null {
  const at = s.workflow_state;
  if (at !== null && def.states[at] !== undefined) return at;
  if (at !== null && s.step !== null) return GATE_STEP;
  return null;
}
const GATE_STEP = '(gate step)';

/**
 * Apply one event and check everything the property asserts: the snapshot invariants, BUG-1's
 * kill on a human move off a live agent, and the lost-machines oracle.
 */
function runStep(def: WorkflowDefinition, h: Harness, event: EngineEvent): void {
  const prev = h.snap;
  h.run(event);
  checkInvariants(def, prev, h);
  // ADR-0037 P7: every entry says why; an engine move (and only one) is by `system`, else the
  // start (system), an answer (human), or a transition by its own actor.
  for (const e of h.last.effects) {
    if (e.type !== 'state_entered') continue;
    expect(MOVE_CAUSES, JSON.stringify(e)).toContain(e.cause);
    if (isEngineMove({ cause: e.cause })) expect(e.actor, JSON.stringify(e)).toBe('system');
    if (e.cause === 'start') expect(e.actor).toBe('system');
    if (e.cause === 'answer_routed') expect(e.actor).toBe('human');
    if (e.cause === 'transition') expect(e.transition, JSON.stringify(e)).not.toBeNull();
  }
  // BUG-1: a human move off a parked agent into a state that runs no agent kills it.
  const landed = h.snap.workflow_state;
  const landedType = landed === null ? undefined : def.states[landed]?.type;
  if (
    (event.type === 'human.transition' || event.type === 'input.provided') &&
    h.last.ignored === null &&
    prev.machine_id !== null &&
    prev.agent_process_live &&
    landedType !== undefined &&
    landedType !== 'agent'
  ) {
    expect(h.last.effects.some((e) => e.type === 'kill')).toBe(true);
    expect(h.snap.agent_process_live).toBe(false);
  }
  if (event.type === 'machine.lost') {
    const [row, ignored] = lostRow(prev, event);
    expect(h.last.ignored, row).toBe(ignored);
    if (ignored === null) {
      // A park keeps the answer the agent never ran on (it is delivered on Continue).
      expect(h.snap.status).toBe('needs_input');
      if (prev.pending_answer !== null) {
        expect(lostAnswerOf(h.snap.context)).toEqual(prev.pending_answer);
      }
    }
  }
}

// ---------------------------------------------------------------- targeted coverage (WF-T06)

/**
 * Does a session of `kind` meet a gate step in `def`: a state with `entry` requirements, or a
 * transition it can take with `requires` / `requirements`?
 */
function hasGate(def: WorkflowDefinition, kind: TicketKind | null): boolean {
  return Object.keys(def.states).some((name) => {
    const st = def.states[name]!;
    if (st.entry !== undefined) return true;
    return transitionsOf(def, name, { kind }).some(
      (t) => t.transition.requires !== undefined || t.transition.requirements !== undefined,
    );
  });
}

/** Every place a session of `kind` must be shown to reach. */
function expectedTargets(def: WorkflowDefinition, kind: TicketKind | null): string[] {
  return [...Object.keys(def.states), ...(hasGate(def, kind) ? [GATE_STEP] : [])].sort();
}

/** `progress` picks 0..23 cover every modulus it branches on (2, 3, 4, 5, 7, 11). */
const NATURAL_PICKS = Array.from({ length: 24 }, (_, p) => p);
const BFS_MAX_DEPTH = 30;
const BFS_MAX_NODES = 5000;

/** The deterministic moves the search tries from `h`: `progress`, plus (phase 2) gotos. */
function moves(h: Harness, withGoto: boolean): EngineEvent[] {
  const out = NATURAL_PICKS.map((p) => progress(h, p));
  if (withGoto && h.snap.status === 'needs_input') {
    for (const goto of Object.keys(h.def.states)) {
      out.push({ type: 'input.provided', input_request_id: REQ, answer: 'a', goto });
    }
  }
  return out;
}

const nodeKey = (s: SessionSnapshot): string =>
  [
    s.workflow_state,
    s.status,
    s.step === null ? '-' : `${s.step.kind}:${s.step.phase}`,
    s.agent_command_id !== null,
    s.agent_process_live,
    s.machine_id !== null,
  ].join('|');

/**
 * A shortest event path from a fresh session to each target place, by breadth-first search over
 * `moves`. Phase 1 uses only `progress` (the routes real sessions take); phase 2, only for the
 * places phase 1 missed, also lets a human route an answer anywhere (pr_flow's connectors have no
 * result event, so `jira_docs` is reached no other way). Bounded by depth and node count.
 */
function pathsTo(
  def: WorkflowDefinition,
  start: () => Harness,
  targets: readonly string[],
): Map<string, EngineEvent[]> {
  const found = new Map<string, EngineEvent[]>();
  for (const withGoto of [false, true]) {
    if (targets.every((t) => found.has(t))) break;
    const root = start();
    const seen = new Set([nodeKey(root.snap)]);
    let frontier: [Harness, EngineEvent[]][] = [[root, []]];
    for (let depth = 0; depth < BFS_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: [Harness, EngineEvent[]][] = [];
      for (const [h, path] of frontier) {
        for (const event of moves(h, withGoto)) {
          const child = h.clone();
          child.run(event);
          if (child.last.ignored !== null) continue;
          const key = nodeKey(child.snap);
          if (seen.has(key)) continue;
          seen.add(key);
          const childPath = [...path, event];
          const place = placeOf(def, child.snap);
          if (place !== null && !found.has(place)) found.set(place, childPath);
          if (seen.size < BFS_MAX_NODES) next.push([child, childPath]);
        }
      }
      frontier = next;
    }
  }
  return found;
}

const WORKFLOWS: [string, () => WorkflowDefinition, TicketKind | null][] = [
  ['m1_basic', () => referenceWorkflow('m1_basic'), null],
  ['pr_flow', () => referenceWorkflow('pr_flow'), null],
  ['agent_chain', agentChain, null],
  // ADR-0011: named transitions, kinds, human moves and move steps.
  ['conductor v2 (work)', () => CONDUCTOR_V2_DRAFT_DEF, 'work'],
  ['conductor v2 (personal)', () => CONDUCTOR_V2_DRAFT_DEF, 'personal'],
  ['conductor v2 (no kind)', () => CONDUCTOR_V2_DRAFT_DEF, null],
  // ADR-0020 §2 (M2r-T03): a `role: 'qa'` state behind a move step.
  ['qa flow', qaDefinition, null],
  // WF-T06: the definition tickets actually run on (plan_review, in_review).
  ['conductor v5 live (work)', conductorV5Live, 'work'],
  ['conductor v5 live (personal)', conductorV5Live, 'personal'],
  ['conductor v5 live (no kind)', conductorV5Live, null],
  // ADR-0041: default answers taken and overruled.
  ['conductor v5 defaults (work)', conductorV5Defaults, 'work'],
];

describe.each(WORKFLOWS)('apply property: %s', (name, load, kind) => {
  const def = load();
  const fresh = (): SessionSnapshot => {
    const snap = freshSnapshot(def);
    return { ...snap, ticket: { ...snap.ticket, kind } };
  };

  it('no event sequence leaves the session undefined', () => {
    // Invariants only (and the lost-row oracle per event). Coverage is not asserted here: it is
    // probabilistic (TD-163) and comes from the targeted test below.
    const property = fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
      const h = new Harness(def, fresh());
      for (const { gen, pick, seconds } of steps) {
        h.advance(seconds);
        runStep(def, h, eventFor(gen, h, pick));
      }
    });
    // M2-T33: `pnpm test:all` runs the full 1000.
    assertProperty(name, property, process.env.CONDUCTOR_TEST_ALL === '1' ? 1000 : 200);
    // 1000 runs take ~5 s on their own; more when every package's tests run in parallel.
  }, 60_000);

  it('every state is reached by a targeted case (deterministic)', () => {
    // WF-T06 (TD-163): random sequences reached rare states (pr_flow `jira_docs`, qa flow `done`)
    // only by chance. Each place gets its own shortest path instead, replayed through every check.
    const expected = expectedTargets(def, kind);
    const paths = pathsTo(def, () => new Harness(def, fresh()), expected);
    const missing = expected.filter((t) => !paths.has(t));
    expect(
      missing,
      `no path within depth ${BFS_MAX_DEPTH}: unreachable, or extend moves()`,
    ).toEqual([]);
    const reached = new Set<string>();
    for (const target of expected) {
      const h = new Harness(def, fresh());
      for (const event of paths.get(target)!) {
        runStep(def, h, event);
        expect(h.last.ignored).toBeNull();
        const place = placeOf(def, h.snap);
        if (place !== null) reached.add(place);
      }
      expect(placeOf(def, h.snap), `path to ${target}`).toBe(target);
    }
    expect([...reached].sort()).toEqual(expected);
  });

  it('every lost-machines row is hit (deterministic)', () => {
    const lost = (machine_id: string, reason: LostEvent['reason']): LostEvent => ({
      type: 'machine.lost',
      machine_id,
      reason,
    });
    const queued = () => new Harness(def, fresh());
    const onMachine = () => new Harness(def, fresh()).claimAndStart('mbp-ben');
    const cases: [string, () => Harness, LostEvent][] = [
      [
        'terminal',
        () => {
          const h = onMachine();
          h.run({ type: 'operator.cancel' });
          return h;
        },
        lost('mbp-ben', 'lease_expired'),
      ],
      ['(A) on machine', onMachine, lost('mbp-ben', 'lease_expired')],
      ['mismatch', onMachine, lost('mini', 'lease_expired')],
      ['(A) queued pinned', queued, lost('mbp-ben', 'pinned_machine_offline')],
      [
        '(B) revoked, marked',
        () => {
          const h = onMachine();
          h.run(lost('mbp-ben', 'lease_expired'));
          expect(h.snap.status).toBe('needs_input');
          expect(machineLostMarkOf(h.snap.context)?.machine_id).toBe('mbp-ben');
          return h;
        },
        lost('mbp-ben', 'revoked'),
      ],
      ['(A) queued revoked, no mark', queued, lost('mbp-ben', 'revoked')],
      ['other', queued, lost('mbp-ben', 'lease_expired')],
    ];
    const hit = new Set<string>();
    for (const [expected, setup, event] of cases) {
      const h = setup();
      const prev = h.snap;
      h.run(event);
      checkInvariants(def, prev, h);
      const [row, ignored] = lostRow(prev, event);
      expect(row).toBe(expected);
      expect(h.last.ignored, row).toBe(ignored);
      if (ignored === null) expect(h.snap.status).toBe('needs_input');
      hit.add(row);
    }
    expect([...hit].sort()).toEqual([...LOST_ROWS].sort());
  });

  it('terminal sessions ignore every event', () => {
    assertProperty(
      name,
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

describe('apply property: replay', () => {
  it('a seed replays the same cases', () => {
    const arb = fc.array(stepArb, { minLength: 1, maxLength: 60 });
    const a = fc.sample(arb, { seed: SEED, numRuns: 5 });
    const b = fc.sample(arb, { seed: SEED, numRuns: 5 });
    expect(a).toEqual(b);
    expect(fc.sample(arb, { seed: SEED + 1, numRuns: 5 })).not.toEqual(a);
  });
});
