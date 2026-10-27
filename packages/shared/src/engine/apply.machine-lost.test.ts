import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import type { WorkflowDefinition } from '../workflow/schema.js';
import { apply } from './apply.js';
import { freshSnapshot, Harness, referenceWorkflow } from './apply.testkit.js';
import { MACHINE_LOST_EVENT_FIXTURES } from './fixtures.js';
import { machineLostMarkOf } from './machine-lost.js';
import {
  ApplyResultSchema,
  MACHINE_LOST_CONTEXT_KEY,
  type ApplyResult,
  type Effect,
  type EngineEvent,
  type MachineLostReason,
} from './types.js';

// M2-T06 (U-068): `machine.lost` per 10-contracts §Machines protocol v2, "Lost machines". One
// case per row of its status × event table, then "Continue", Cancel only, and the mark's life.

const MBP = 'mbp-ben';
const REQ = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const LOST = MACHINE_LOST_EVENT_FIXTURES;

type Lost = Extract<EngineEvent, { type: 'machine.lost' }>;
const lost = (reason: MachineLostReason, extra: Partial<Lost> = {}): Lost => ({
  ...LOST[reason],
  ...extra,
});

const all = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
const find = <T extends Effect['type']>(effects: Effect[], type: T) => all(effects, type)[0];

/** Runs `e`; asserts the result parses and apply left `fencing_token` alone (T20 bumps it). */
function run(h: Harness, e: EngineEvent): ApplyResult {
  const before = h.snap;
  const r = h.run(e);
  expect(ApplyResultSchema.parse(r)).toEqual(r);
  expect(r.snapshot.fencing_token).toBe(before.fencing_token);
  return r;
}

function expectIgnored(h: Harness, e: EngineEvent, reason: string): void {
  const before = h.snap;
  const r = apply(h.def, before, e, h.now);
  expect(r).toEqual({ snapshot: before, effects: [], ignored: reason });
}

/** m1_basic, claimed on mbp-ben and running `implement`. */
function running(def: WorkflowDefinition = referenceWorkflow('m1_basic')): Harness {
  return new Harness(def).claimAndStart(MBP);
}

/** conductor v2 (work), planned and running `implementing` on mbp-ben. */
function implementing(): Harness {
  const snap = freshSnapshot(CONDUCTOR_V2_DRAFT_DEF);
  snap.ticket = { ...snap.ticket, kind: 'work' };
  const h = new Harness(CONDUCTOR_V2_DRAFT_DEF, snap).claimAndStart(MBP);
  h.run({ type: 'agent.claude_session_id', claude_session_id: 'claude-worker' });
  h.run({
    type: 'agent.complete_state',
    result: { plan: 'P', summary: 'plan' },
    transition: 'plan_ready',
    reason: 'ok',
  });
  h.started();
  return h;
}

/** A queued session whose ticket was never started (as the claim INSERTs it). */
const queued = (def: WorkflowDefinition = referenceWorkflow('m1_basic')) => new Harness(def);

describe('(A) assigned / running / waiting_external on the event machine', () => {
  it('running + lease_expired → needs_input, the question names the machine, one kill', () => {
    const h = running();
    h.advance(60);
    const r = run(h, LOST.lease_expired);
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      status: 'needs_input',
      workflow_state: 'needs_input',
      return_to: 'implement',
      machine_id: MBP,
      agent_process_live: false,
      state_deadline: null,
    });
    expect(all(r.effects, 'kill')).toEqual([{ type: 'kill', reason: 'machine_lost' }]);
    expect(all(r.effects, 'create_input_request')).toEqual([
      {
        type: 'create_input_request',
        kind: 'machine_lost',
        question: "Ben's MacBook stopped responding",
        return_to: 'implement',
      },
    ]);
    expect(find(r.effects, 'session_status')).toEqual({
      type: 'session_status',
      from: 'running',
      to: 'needs_input',
    });
    expect(find(r.effects, 'ticket_status')).toBeUndefined();
    expect(machineLostMarkOf(r.snapshot.context)).toEqual({
      machine_id: MBP,
      machine_name: "Ben's MacBook",
      reason: 'lease_expired',
      state: 'implement',
      at: h.now.toISOString(),
    });
    // apply's other effects are the park's: no start_session, no outbox command but the kill.
    expect(all(r.effects, 'start_session')).toEqual([]);
  });

  it('pinned_machine_offline while running there: a kill and the offline question', () => {
    const r = run(running(), LOST.pinned_machine_offline);
    expect(all(r.effects, 'kill')).toHaveLength(1);
    expect(find(r.effects, 'create_input_request')?.question).toBe(
      "Ben's MacBook has been offline for 15 minutes",
    );
    const r2 = run(running(), lost('pinned_machine_offline', { offline_ms: 3_600_000 }));
    expect(find(r2.effects, 'create_input_request')?.question).toBe(
      "Ben's MacBook has been offline for 1 hour",
    );
  });

  it('revoked while running: parked with no kill, the mark says revoked', () => {
    const r = run(running(), LOST.revoked);
    expect(r.snapshot.status).toBe('needs_input');
    expect(all(r.effects, 'kill')).toEqual([]);
    expect(find(r.effects, 'create_input_request')?.question).toBe('mbp-ben was revoked');
    expect(machineLostMarkOf(r.snapshot.context)?.reason).toBe('revoked');
  });

  it('without machine_name the question uses the machine id', () => {
    const r = run(running(), lost('lease_expired', { machine_name: undefined }));
    expect(find(r.effects, 'create_input_request')?.question).toBe('mbp-ben stopped responding');
    expect(machineLostMarkOf(r.snapshot.context)?.machine_name).toBe(MBP);
  });

  it('assigned (before started) is parked too', () => {
    const h = new Harness(referenceWorkflow('m1_basic'));
    h.run({ type: 'session.assigned', machine_id: MBP });
    expect(h.snap.status).toBe('assigned');
    const r = run(h, LOST.lease_expired);
    expect(r.snapshot.status).toBe('needs_input');
    expect(all(r.effects, 'kill')).toHaveLength(1);
  });

  it('a running gate step is left: return_to is its source state, one kill', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      result: { summary: 's' },
      transition: 'ready_for_testing',
      reason: 'Ready.',
    });
    expect(h.snap.step?.phase).toBe('checks');
    const r = run(h, LOST.lease_expired);
    expect(r.snapshot).toMatchObject({
      step: null,
      workflow_state: 'needs_input',
      return_to: 'implementing',
      status: 'needs_input',
    });
    expect(all(r.effects, 'kill')).toEqual([{ type: 'kill', reason: 'machine_lost' }]);
    expect(machineLostMarkOf(r.snapshot.context)?.state).toBe('implementing');
  });

  it('waiting_external (the conditions phase) on the machine: parked with a kill', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      result: { summary: 's' },
      transition: 'ready_for_testing',
      reason: 'Ready.',
    });
    h.cmdExit(0);
    h.cmdExit(0);
    h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'open_pr',
      result: { pr_url: 'https://github.com/benjgrad/fixture-app/pull/7' },
      error: null,
    });
    expect(h.snap.status).toBe('waiting_external');
    const r = run(h, LOST.pinned_machine_offline);
    expect(r.snapshot).toMatchObject({ status: 'needs_input', return_to: 'implementing' });
    expect(all(r.effects, 'kill')).toHaveLength(1);
  });
});

describe('machine_mismatch: the same statuses on another machine', () => {
  it.each(['lease_expired', 'revoked', 'pinned_machine_offline'] as const)(
    'running on another machine + %s → ignored machine_mismatch',
    (reason) => {
      expectIgnored(running(), lost(reason, { machine_id: 'mini' }), 'machine_mismatch');
    },
  );
});

describe('queued sessions (the reaper trusts its pin SQL)', () => {
  it('queued + pinned_machine_offline → needs_input, ticket in_progress, no kill', () => {
    const h = queued();
    const r = run(h, LOST.pinned_machine_offline);
    expect(r.snapshot).toMatchObject({
      status: 'needs_input',
      workflow_state: 'needs_input',
      return_to: null, // never started
      machine_id: MBP,
      state_deadline: null,
    });
    expect(find(r.effects, 'ticket_status')).toEqual({ type: 'ticket_status', to: 'in_progress' });
    expect(all(r.effects, 'kill')).toEqual([]);
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'machine_lost',
      return_to: null,
    });
  });

  it('queued + revoked without a mark → needs_input, no kill, Cancel only', () => {
    const r = run(queued(), LOST.revoked);
    expect(r.snapshot.status).toBe('needs_input');
    expect(find(r.effects, 'ticket_status')?.to).toBe('in_progress');
    expect(all(r.effects, 'kill')).toEqual([]);
    expect(machineLostMarkOf(r.snapshot.context)?.reason).toBe('revoked');
  });

  it('queued + lease_expired → ignored wrong_status', () => {
    expectIgnored(queued(), LOST.lease_expired, 'wrong_status');
  });
});

/** Parked by a lease_expired on mbp-ben (m1_basic, from `implement`). */
function parkedLost(): Harness {
  const h = running();
  run(h, LOST.lease_expired);
  return h;
}

/** Parked, then "Continue": queued in `implement`, waiting for mbp-ben. */
function continued(): Harness {
  const h = parkedLost();
  run(h, { type: 'input.provided', input_request_id: REQ, answer: 'go on' });
  expect(h.snap.status).toBe('queued');
  return h;
}

describe('(B) revoked while parked or pinned to the machine', () => {
  it('parked with a mark + revoked → a new revoked question, return_to unchanged, no kill', () => {
    const h = parkedLost();
    h.advance(30);
    const r = run(h, LOST.revoked);
    expect(r.ignored).toBeNull();
    expect(r.effects).toEqual([
      {
        type: 'create_input_request',
        kind: 'machine_lost',
        question: "Ben's MacBook was revoked",
        return_to: 'implement',
      },
    ]);
    expect(r.snapshot.status).toBe('needs_input');
    expect(r.snapshot.return_to).toBe('implement');
    expect(machineLostMarkOf(r.snapshot.context)).toMatchObject({
      reason: 'revoked',
      machine_id: MBP,
      state: 'implement',
      at: h.now.toISOString(),
    });
  });

  it('queued with a mark (after Continue) + revoked → needs_input in the human state', () => {
    const h = continued();
    const r = run(h, LOST.revoked);
    expect(r.snapshot).toMatchObject({
      status: 'needs_input',
      workflow_state: 'needs_input',
      return_to: 'implement',
    });
    expect(find(r.effects, 'ticket_status')?.to).toBe('in_progress');
    expect(all(r.effects, 'kill')).toEqual([]);
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'machine_lost',
      question: "Ben's MacBook was revoked",
      return_to: 'implement',
    });
  });

  it('a mark for another machine + revoked → wrong_status', () => {
    expectIgnored(parkedLost(), lost('revoked', { machine_id: 'mini' }), 'wrong_status');
    expectIgnored(continued(), lost('revoked', { machine_id: 'mini' }), 'wrong_status');
  });

  it('needs_input: without a mark, or with any other reason → wrong_status', () => {
    const h = running();
    h.run({ type: 'agent.ask_user', question: 'which?' });
    expect(h.snap.status).toBe('needs_input');
    for (const reason of ['lease_expired', 'revoked', 'pinned_machine_offline'] as const) {
      expectIgnored(h, lost(reason), 'wrong_status');
    }
    expectIgnored(parkedLost(), LOST.lease_expired, 'wrong_status');
    expectIgnored(parkedLost(), LOST.pinned_machine_offline, 'wrong_status');
  });
});

describe('terminal sessions', () => {
  it('done → ignored session_terminal', () => {
    const h = running();
    h.complete({});
    h.cmdExit(0);
    h.cmdExit(0);
    expect(h.snap.status).toBe('done');
    for (const e of Object.values(LOST)) expectIgnored(h, e, 'session_terminal');
  });

  it('failed (cancelled) → ignored session_terminal', () => {
    const h = running();
    h.run({ type: 'operator.cancel' });
    for (const e of Object.values(LOST)) expectIgnored(h, e, 'session_terminal');
  });
});

describe('revoked: Cancel only', () => {
  it('after a revoked lost, human.transition → transition_not_allowed, input.provided → wrong_status', () => {
    const def = CONDUCTOR_V2_DRAFT_DEF;
    const h = implementing();
    run(h, LOST.revoked);
    expect(h.snap.workflow_state).toBe('needs_input');
    expectIgnored(
      h,
      { type: 'human.transition', name: 'answer', text: 'go', actor: 'ui', input_request_id: REQ },
      'transition_not_allowed',
    );
    expectIgnored(
      h,
      { type: 'input.provided', input_request_id: REQ, answer: 'go' },
      'wrong_status',
    );
    expect(def.states.needs_input?.type).toBe('human');
    const r = run(h, { type: 'operator.cancel' });
    expect(r.snapshot.status).toBe('failed');
  });
});

describe('"Continue on <machine>" and the mark', () => {
  it('$return_to requeues (machine_id null, ticket ready), keeps the mark; started clears it', () => {
    const h = implementing();
    run(h, LOST.lease_expired);
    const r = run(h, {
      type: 'human.transition',
      name: 'answer',
      text: null,
      actor: 'ui',
      input_request_id: REQ,
    });
    expect(r.snapshot).toMatchObject({
      status: 'queued',
      workflow_state: 'implementing',
      machine_id: null,
      state_deadline: null,
      pending_answer: { input_request_id: REQ, answer: '[answer]' },
    });
    expect(find(r.effects, 'ticket_status')?.to).toBe('ready');
    expect(all(r.effects, 'start_session')).toEqual([]);
    expect(machineLostMarkOf(r.snapshot.context)?.machine_id).toBe(MBP);

    const a = run(h, { type: 'session.assigned', machine_id: MBP });
    expect(find(a.effects, 'start_session')).toMatchObject({
      state: 'implementing',
      resume_claude_session_id: 'claude-worker',
      prompt: '[answer]',
    });
    expect(machineLostMarkOf(a.snapshot.context)).not.toBeNull(); // not running yet
    const s = run(h, {
      type: 'session.started',
      command_id: h.agentCmd,
      worktree_path: '/tmp/wt',
      branch: 'b',
      port_range: { base: 41000, count: 10 },
    });
    expect(s.snapshot.status).toBe('running');
    expect(MACHINE_LOST_CONTEXT_KEY in s.snapshot.context).toBe(false);
  });

  it('return_to null (a never-started session): Continue requeues in def.start', () => {
    const h = queued();
    run(h, LOST.pinned_machine_offline);
    const r = run(h, { type: 'input.provided', input_request_id: REQ, answer: 'go on' });
    expect(r.snapshot).toMatchObject({
      status: 'queued',
      workflow_state: 'implement',
      machine_id: null,
    });
    expect(machineLostMarkOf(r.snapshot.context)).not.toBeNull();
  });

  it('a re-emit that is not an agent start (a command state) clears the mark at assignment', () => {
    const h = running();
    h.complete({});
    expect(h.snap.workflow_state).toBe('build');
    run(h, LOST.lease_expired);
    expect(h.snap.return_to).toBe('build');
    run(h, { type: 'input.provided', input_request_id: REQ, answer: 'retry' });
    expect(h.snap).toMatchObject({ status: 'queued', workflow_state: 'build' });
    const a = run(h, { type: 'session.assigned', machine_id: MBP });
    expect(find(a.effects, 'run_cmd')).toBeDefined();
    expect(MACHINE_LOST_CONTEXT_KEY in a.snapshot.context).toBe(false);
  });

  it('a move into a state that needs no machine clears the mark', () => {
    const h = implementing();
    run(h, LOST.lease_expired);
    const r = run(h, {
      type: 'human.transition',
      name: 'waiting_on_someone',
      text: 'Ben',
      actor: 'ui',
      input_request_id: REQ,
    });
    expect(r.snapshot.status).toBe('waiting_external');
    expect(MACHINE_LOST_CONTEXT_KEY in r.snapshot.context).toBe(false);
  });
});
