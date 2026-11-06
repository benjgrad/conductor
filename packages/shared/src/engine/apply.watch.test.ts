/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { Harness, freshSnapshot } from './apply.testkit.js';
import { CONDITIONS_NO_MACHINE_NOTE, type ApplyResult, type Effect } from './types.js';
import { watchReturnOf, watchRuntime } from './watch.js';

// ADR-0037 P1 (T6): `watch` on human and event states. A small workflow shaped like the v6 draft:
// implementing hands off to in_review, which watches pr_mergeable (2m, back to implementing with
// the re-sync instruction, come back, 3 retries, else needs_input); needs_input escalates after 2h;
// waiting (an event state) watches pr_mergeable too.

const RESYNC = 'Merge origin/main into the branch, resolve every conflict, then finish again.';
const MIN = 60_000;

const RAW = {
  id: 'watch_flow',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  notify: { default: 'once', engine_moves: 'never' },
  instructions: { resync_main: RESYNC },
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
        },
        hand_to_triage: {
          goto: 'triage',
          title: 'Hand to triage',
          when: 'Someone else should look.',
          handoff: true,
        },
        to_waiting: { goto: 'waiting', title: 'Wait', when: 'Wait for approval.' },
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
      watch: {
        poll: '2m',
        conditions: [{ type: 'pr_mergeable', label: 'Merges cleanly' }],
        on_broken: {
          goto: 'implementing',
          instruction: '$instructions.resync_main',
          return_to: '$self',
          retries: 3,
          else: 'needs_input',
        },
      },
    },
    triage: {
      type: 'human',
      title: 'Triage',
      on: { back: { goto: 'implementing', title: 'Back', actor: 'human' } },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: {
        answer: { goto: '$return_to', title: 'Back with this answer', actor: 'human' },
        done: { goto: 'done', title: 'Done', actor: 'human' },
      },
      watch: {
        poll: '5m',
        conditions: [{ type: 'age_below', max: '2h', label: 'Answered within 2 hours' }],
        on_broken: { notify: 'escalate' },
      },
    },
    waiting: {
      type: 'event',
      title: 'Waiting',
      wait_for: ['ui.approve'],
      on: {
        'ui.approve': { goto: 'done', title: 'Approved' },
      },
      watch: {
        conditions: [{ type: 'pr_mergeable' }],
        on_broken: { goto: 'implementing', retries: 1, else: 'needs_input' },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

const DEF = WorkflowDefinitionSchema.parse(RAW);

function defWith(mutate: (raw: Record<string, any>) => void): WorkflowDefinition {
  const raw = structuredClone(RAW) as Record<string, any>;
  mutate(raw);
  return WorkflowDefinitionSchema.parse(raw);
}

const of = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
const one = <T extends Effect['type']>(effects: Effect[], type: T) => of(effects, type)[0];

/** Running in implementing, then handed off to in_review. */
function inReview(def: WorkflowDefinition = DEF): Harness {
  const h = new Harness(def, freshSnapshot(def)).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: {},
    transition: 'pr_ready',
    reason: 'Ready for review.',
  });
  return h;
}

/** Fire the armed watch timer (the clock moves to it). */
function tick(h: Harness): ApplyResult {
  const deadline = h.snap.watch_deadline!;
  h.now = new Date(deadline);
  return h.run({ type: 'watch.fired', state: h.snap.workflow_state!, deadline });
}

type Status = 'met' | 'pending' | 'failed' | 'unsupported' | 'skipped';

/** The daemon's answer for the watch's one pr_mergeable condition. */
function answer(h: Harness, status: Status, value: string | null = null): ApplyResult {
  return h.run({
    type: 'action.completed',
    command_id: h.newId(),
    action: 'evaluate_conditions',
    result: {
      results: [
        {
          type: 'pr_mergeable',
          status,
          value,
          detail: status === 'failed' ? 'the PR conflicts with its base branch' : null,
        },
      ],
    },
    error: null,
  });
}

const deadlineIn = (h: Harness, ms: number) => new Date(h.now.getTime() + ms).toISOString();

describe('watch: arm and disarm', () => {
  it('the test workflow validates (rules 19, 24 and 4) without allowUnavailable', () => {
    const res = validateWorkflow(RAW);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('entering in_review arms the watch one poll out and sends nothing yet', () => {
    const h = inReview();
    expect(h.snap).toMatchObject({ workflow_state: 'in_review', status: 'needs_input' });
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 2 * MIN));
    expect(of(h.last.effects, 'run_action')).toEqual([]);
    expect(watchRuntime(h.snap.context)).toMatchObject({
      state: 'in_review',
      visit: 1,
      poll_ms: 2 * MIN,
      escalated: false,
      conditions: [{ type: 'pr_mergeable', label: 'Merges cleanly', status: 'todo' }],
    });
  });

  it('a human move out of in_review disarms it; a later tick is stale', () => {
    const h = inReview();
    const deadline = h.snap.watch_deadline!;
    h.run({ type: 'human.transition', name: 'done', text: null, actor: 'ui' });
    expect(h.snap.status).toBe('done');
    expect(h.snap.watch_deadline).toBeNull();
    expect(watchRuntime(h.snap.context)).toBeNull();
    // A done session ignores everything; a moved one finds no matching timer.
    const r = h.run({ type: 'watch.fired', state: 'in_review', deadline });
    expect(r.ignored).toBe('session_terminal');
  });

  it('a timer for another deadline or state is stale', () => {
    const h = inReview();
    const deadline = h.snap.watch_deadline!;
    expect(
      h.run({ type: 'watch.fired', state: 'in_review', deadline: deadlineIn(h, 1) }).ignored,
    ).toBe('stale_timer');
    expect(h.run({ type: 'watch.fired', state: 'needs_input', deadline }).ignored).toBe(
      'stale_timer',
    );
  });

  it('a state without a watch arms nothing', () => {
    const h = new Harness(DEF, freshSnapshot(DEF)).claimAndStart();
    h.run({ type: 'agent.complete_state', result: {}, transition: 'hand_to_triage', reason: 'x' });
    expect(h.snap.workflow_state).toBe('triage');
    expect(h.snap.watch_deadline ?? null).toBeNull();
    expect(watchRuntime(h.snap.context)).toBeNull();
  });
});

describe('watch: evaluation', () => {
  it('a tick sends evaluate_conditions with short_circuit, never pinned to a commit', () => {
    const h = inReview();
    const r = tick(h);
    const action = one(r.effects, 'run_action')!;
    expect(action).toMatchObject({
      state: 'in_review',
      target_state: 'in_review',
      action: 'evaluate_conditions',
      expected_sha: null,
    });
    expect(action.args).toMatchObject({
      conditions: [{ type: 'pr_mergeable' }],
      short_circuit: true,
    });
    expect(action.args).not.toHaveProperty('head_sha');
    expect(watchRuntime(h.snap.context)!.conditions[0]!.status).toBe('running');
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 2 * MIN));
  });

  it('met re-arms at the base, then doubles while unchanged, capped at 15m', () => {
    const h = inReview();
    tick(h);
    answer(h, 'met', 'MERGEABLE');
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 2 * MIN));
    expect(h.snap.workflow_state).toBe('in_review');
    const polls: number[] = [];
    for (let i = 0; i < 5; i++) {
      tick(h);
      answer(h, 'met', 'MERGEABLE');
      polls.push(watchRuntime(h.snap.context)!.poll_ms / MIN);
    }
    expect(polls).toEqual([4, 8, 15, 15, 15]);
    // A changed answer (UNKNOWN after a merge) drops back to the base.
    tick(h);
    answer(h, 'pending', 'UNKNOWN');
    expect(watchRuntime(h.snap.context)!.poll_ms).toBe(2 * MIN);
  });

  it('pending, unsupported, an error, a malformed result: re-armed, never moved', () => {
    const h = inReview();
    tick(h);
    answer(h, 'pending', 'UNKNOWN');
    expect(h.snap).toMatchObject({ workflow_state: 'in_review', status: 'needs_input' });
    tick(h);
    answer(h, 'unsupported');
    expect(h.snap.workflow_state).toBe('in_review');
    tick(h);
    h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'evaluate_conditions',
      result: null,
      error: 'gh exploded',
    });
    expect(h.snap.workflow_state).toBe('in_review');
    expect(watchRuntime(h.snap.context)!.note).toBe('the last check failed: gh exploded');
    tick(h);
    h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'evaluate_conditions',
      result: { results: [] },
      error: null,
    });
    expect(h.snap.workflow_state).toBe('in_review');
    expect(watchRuntime(h.snap.context)!.note).toMatch(/unusable result/);
    expect(h.snap.retry_counters['watch:in_review']).toBeUndefined();
  });

  it('a refused evaluation re-arms with a note', () => {
    const h = inReview();
    tick(h);
    const r = h.run({
      type: 'command.refused',
      command_id: h.newId(),
      command_kind: 'run_action',
      reason: 'unknown action',
    });
    expect(r.ignored).toBeNull();
    expect(watchRuntime(h.snap.context)!.note).toMatch(/refused the check/);
    expect(watchRuntime(h.snap.context)!.conditions[0]!.status).toBe('todo');
  });

  it('no machine, or an evaluation in flight: a note and no second evaluation', () => {
    const h = inReview();
    tick(h);
    const r = tick(h); // the first is still unanswered
    expect(of(r.effects, 'run_action')).toEqual([]);
    expect(watchRuntime(h.snap.context)!.note).toBe(CONDITIONS_NO_MACHINE_NOTE);
    const g = inReview();
    g.snap = { ...g.snap, machine_id: null };
    const r2 = tick(g);
    expect(of(r2.effects, 'run_action')).toEqual([]);
    expect(watchRuntime(g.snap.context)!.note).toBe(CONDITIONS_NO_MACHINE_NOTE);
    expect(g.snap.workflow_state).toBe('in_review');
  });

  it('an answer with no evaluation in flight is unexpected', () => {
    const h = inReview();
    expect(answer(h, 'failed').ignored).toBe('unexpected_event');
  });
});

describe('watch: on_broken, the move form', () => {
  it('failed → implementing as a watch_broken engine move, with the re-sync instruction', () => {
    const h = inReview();
    tick(h);
    const r = answer(h, 'failed', 'CONFLICTING');
    expect(h.snap).toMatchObject({ workflow_state: 'implementing', status: 'running' });
    expect(one(r.effects, 'state_entered')).toMatchObject({
      from: 'in_review',
      to: 'implementing',
      cause: 'watch_broken',
      actor: 'system',
      transition: null,
    });
    expect(one(r.effects, 'state_entered')!.reason).toMatch(/pr_mergeable/);
    const start = one(r.effects, 'start_session')!;
    expect(start.prompt).toContain(RESYNC);
    expect(start.prompt).toContain('While this ticket waited in In review');
    expect(h.snap.retry_counters['watch:in_review']).toBe(1);
    // `return_to: $self`
    expect(h.snap.return_to).toBe('in_review');
    expect(watchReturnOf(h.snap.context)).toEqual({ state: 'in_review', from_watch: 'in_review' });
    // Disarmed: nothing watches implementing.
    expect(h.snap.watch_deadline).toBeNull();
    expect(watchRuntime(h.snap.context)).toBeNull();
    // No kill: a watch never ends a process (the review's agent was already done).
    expect(of(r.effects, 'kill')).toEqual([]);
  });

  it('the agent hand-off comes back to in_review, which re-arms', () => {
    const h = inReview();
    tick(h);
    answer(h, 'failed', 'CONFLICTING');
    h.started();
    h.run({ type: 'agent.complete_state', result: {}, transition: 'pr_ready', reason: 'Merged.' });
    expect(h.snap.workflow_state).toBe('in_review');
    expect(watchReturnOf(h.snap.context)).toBeNull();
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 2 * MIN));
  });

  it('return_to: $self redirects a hand-off that would land elsewhere', () => {
    const h = inReview();
    tick(h);
    answer(h, 'failed', 'CONFLICTING');
    h.started();
    const r = h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'hand_to_triage',
      reason: 'Done with the merge.',
    });
    expect(h.snap.workflow_state).toBe('in_review');
    expect(one(r.effects, 'state_entered')).toMatchObject({
      from: 'implementing',
      to: 'in_review',
      transition: 'hand_to_triage',
    });
    // Used up: the next hand-off goes where it says.
    tick(h);
    answer(h, 'met', 'MERGEABLE');
    h.run({ type: 'human.transition', name: 'request_changes', text: 'more', actor: 'ui' });
    h.started();
    h.run({ type: 'agent.complete_state', result: {}, transition: 'hand_to_triage', reason: 'x' });
    expect(h.snap.workflow_state).toBe('triage');
  });

  it('without return_to there is no way back: the hand-off lands where it says', () => {
    const def = defWith((d) => delete d.states.in_review.watch.on_broken.return_to);
    const h = inReview(def);
    tick(h);
    answer(h, 'failed', 'CONFLICTING');
    expect(h.snap.return_to).toBeNull();
    h.started();
    h.run({ type: 'agent.complete_state', result: {}, transition: 'hand_to_triage', reason: 'x' });
    expect(h.snap.workflow_state).toBe('triage');
  });

  it('bounded: 3 laps, then the 4th break goes to needs_input as retries_exhausted', () => {
    const h = inReview();
    for (let lap = 1; lap <= 3; lap++) {
      tick(h);
      answer(h, 'failed', 'CONFLICTING');
      expect(h.snap.workflow_state).toBe('implementing');
      expect(h.snap.retry_counters['watch:in_review']).toBe(lap);
      h.started();
      h.run({ type: 'agent.complete_state', result: {}, transition: 'pr_ready', reason: 'ok' });
      expect(h.snap.workflow_state).toBe('in_review');
    }
    tick(h);
    const r = answer(h, 'failed', 'CONFLICTING');
    expect(h.snap).toMatchObject({ workflow_state: 'needs_input', status: 'needs_input' });
    expect(one(r.effects, 'state_entered')).toMatchObject({
      from: 'in_review',
      to: 'needs_input',
      cause: 'retries_exhausted',
      actor: 'system',
    });
    const req = one(r.effects, 'create_input_request')!;
    expect(req.kind).toBe('retries_exhausted');
    expect(req.question).toMatch(/broke 4 times \(retry limit 3\)/);
    // needs_input has its own watch, armed fresh.
    expect(watchRuntime(h.snap.context)).toMatchObject({ state: 'needs_input' });
  });

  it('an event state watches the same way (waiting_external)', () => {
    const h = new Harness(DEF, freshSnapshot(DEF)).claimAndStart();
    h.run({ type: 'agent.complete_state', result: {}, transition: 'to_waiting', reason: 'x' });
    expect(h.snap).toMatchObject({ workflow_state: 'waiting', status: 'waiting_external' });
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 2 * MIN)); // the default poll
    tick(h);
    answer(h, 'failed', 'CONFLICTING');
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.retry_counters['watch:waiting']).toBe(1);
  });

  it('a repin to a definition without the watch disarms it on the next tick', () => {
    const h = inReview();
    const plain = defWith((d) => delete d.states.in_review.watch);
    const g = new Harness(plain, h.snap, h.now);
    const r = tick(g);
    expect(r.ignored).toBeNull();
    expect(g.snap.watch_deadline).toBeNull();
    expect(watchRuntime(g.snap.context)).toBeNull();
  });
});

describe('watch: on_broken, the escalate form', () => {
  /** In needs_input through the agent's ask_user. */
  function asking(): Harness {
    const h = new Harness(DEF, freshSnapshot(DEF)).claimAndStart();
    h.run({ type: 'agent.ask_user', question: 'Which branch?' });
    return h;
  }

  it('age_below is evaluated by the engine: nothing is sent to the daemon', () => {
    const h = asking();
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 5 * MIN));
    const r = tick(h);
    expect(of(r.effects, 'run_action')).toEqual([]);
    expect(watchRuntime(h.snap.context)!.conditions[0]).toMatchObject({ status: 'met' });
    expect(h.snap.watch_deadline).toBe(deadlineIn(h, 5 * MIN));
  });

  it('after 2h: one watch_escalated push per stay, no move; re-entry resets it', () => {
    const h = asking();
    h.snap = { ...h.snap, watch_deadline: new Date(h.now.getTime() + 2 * 60 * MIN).toISOString() };
    const r = tick(h);
    const esc = of(r.effects, 'watch_escalated');
    expect(esc).toEqual([
      expect.objectContaining({
        state: 'needs_input',
        visit: 1,
        notify_decision: { via: 'watch_escalate', mode: 'every', decision: 'push' },
      }),
    ]);
    expect(esc[0]!.reason).toMatch(/Waiting in Needs input/);
    expect(h.snap).toMatchObject({ workflow_state: 'needs_input', status: 'needs_input' });
    expect(of(r.effects, 'state_entered')).toEqual([]);
    // Still watching, never again this stay.
    expect(of(tick(h).effects, 'watch_escalated')).toEqual([]);
    // Back to the agent and into needs_input again: a new stay escalates again.
    h.run({ type: 'human.transition', name: 'answer', text: 'main', actor: 'ui' });
    h.started();
    h.run({ type: 'agent.ask_user', question: 'And now?' });
    expect(watchRuntime(h.snap.context)).toMatchObject({ visit: 2, escalated: false });
    h.snap = { ...h.snap, watch_deadline: new Date(h.now.getTime() + 2 * 60 * MIN).toISOString() };
    expect(of(tick(h).effects, 'watch_escalated')).toHaveLength(1);
  });
});

describe('watch: notifications (P6)', () => {
  it('the watch_broken move and the returning once hand-off push nothing', () => {
    const h = inReview();
    // The first hand-off is `once`: it pushed (its question).
    expect(h.snap.notified_transitions).toEqual(['pr_ready']);
    tick(h);
    const broke = answer(h, 'failed', 'CONFLICTING');
    expect(one(broke.effects, 'state_entered')!.notify_decision).toEqual({
      via: 'watch_broken',
      mode: 'never',
      decision: 'silent',
    });
    h.started();
    const back = h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'pr_ready',
      reason: 'ok',
    });
    expect(one(back.effects, 'state_entered')!.notify_decision?.decision).toBe('silent');
    expect(one(back.effects, 'create_input_request')!.notify_decision?.decision).toBe('silent');
  });

  it('the else landing in needs_input is silent (an engine move)', () => {
    const def = defWith((d) => (d.states.in_review.watch.on_broken.retries = 0));
    const h = inReview(def);
    tick(h);
    const r = answer(h, 'failed', 'CONFLICTING');
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(one(r.effects, 'create_input_request')!.notify_decision?.decision).toBe('silent');
  });
});

describe('watch: every path ends at a human (property)', () => {
  it('random answers keep the session in in_review, implementing or a human state, bounded', () => {
    const answers = fc.constantFrom<Status | 'error' | 'handoff'>(
      'met',
      'pending',
      'failed',
      'unsupported',
      'error',
      'handoff',
    );
    fc.assert(
      fc.property(fc.array(answers, { maxLength: 40 }), (seq) => {
        const h = inReview();
        for (const a of seq) {
          const state = h.snap.workflow_state;
          if (state === 'implementing') {
            if (a === 'handoff') {
              if (h.snap.agent_command_id !== null && !h.snap.agent_process_live) h.started();
              h.run({ type: 'agent.complete_state', result: {}, transition: 'pr_ready' });
            }
            continue;
          }
          if (state !== 'in_review' || h.snap.watch_deadline == null) break;
          tick(h);
          if (a === 'error') {
            h.run({
              type: 'action.completed',
              command_id: h.newId(),
              action: 'evaluate_conditions',
              result: null,
              error: 'boom',
            });
          } else if (a !== 'handoff') {
            answer(h, a, null);
          }
        }
        const state = h.snap.workflow_state!;
        expect(['in_review', 'implementing', 'needs_input']).toContain(state);
        expect(h.snap.retry_counters['watch:in_review'] ?? 0).toBeLessThanOrEqual(3);
        if ((h.snap.retry_counters['watch:in_review'] ?? 0) === 3 && state === 'needs_input') {
          expect(DEF.states.needs_input!.type).toBe('human');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every watch move form in a valid definition targets a bounded goto and a human else', () => {
    for (const [name, s] of Object.entries(DEF.states)) {
      if ((s.type !== 'human' && s.type !== 'event') || s.watch === undefined) continue;
      const ob = s.watch.on_broken;
      if (!('goto' in ob)) continue;
      expect(ob.goto).not.toBe(name);
      expect(DEF.states[ob.else]!.type).toBe('human');
      expect(ob.retries).toBeLessThanOrEqual(10);
    }
  });
});
