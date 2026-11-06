import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { freshSnapshot, Harness } from './apply.testkit.js';
import { notifyBucketKey, notifyDecision } from './notify.js';
import type { Effect } from './types.js';

// Configurable notifications: `notify: true` on a transition marks the `state_entered` it leads
// to (05 §Transitions). Counted loops, their `else`, and unflagged / unmapped outcomes.

const entered = (effects: Effect[]) =>
  effects.find((e): e is Extract<Effect, { type: 'state_entered' }> => e.type === 'state_entered');

const DEF = WorkflowDefinitionSchema.parse({
  id: 'notify_flow',
  version: 1,
  start: 'build',
  budget: { usd: 5, minutes: 60, max_loop_retries: 3 },
  states: {
    build: {
      type: 'command',
      cmd: 'make',
      on: {
        exit_0: { goto: 'done', notify: true },
        fail: { goto: 'build', retries: 1, else: 'needs_input', notify: true },
      },
    },
    needs_input: { type: 'human', on: { retry: { goto: 'build', actor: 'human' } } },
    done: { type: 'terminal' },
  },
});

describe('notify on transitions', () => {
  it('an exit_0 with notify notifies on entering done', () => {
    const h = new Harness(DEF).claimAndStart();
    const r = h.cmdExit(0);
    expect(entered(r.effects)).toMatchObject({ from: 'build', to: 'done', notify: 'exit_0' });
  });

  it('a counted loop notifies on its goto and on its else when retries run out', () => {
    const h = new Harness(DEF).claimAndStart();
    let r = h.cmdExit(1);
    expect(entered(r.effects)).toMatchObject({ to: 'build', notify: 'fail' });
    r = h.cmdExit(1);
    expect(entered(r.effects)).toMatchObject({ to: 'needs_input', notify: 'fail' });
  });

  it('an unflagged transition and an unmapped outcome (fallback human) never notify', () => {
    const quiet = WorkflowDefinitionSchema.parse({
      ...DEF,
      states: { ...DEF.states, build: { type: 'command', cmd: 'make', on: { exit_0: 'done' } } },
    });
    let h = new Harness(quiet).claimAndStart();
    expect(entered(h.cmdExit(0).effects)).not.toHaveProperty('notify');
    h = new Harness(quiet).claimAndStart();
    const r = h.cmdExit(1); // no `fail` mapping: the fallback human state
    expect(entered(r.effects)).toMatchObject({ to: 'needs_input' });
    expect(entered(r.effects)).not.toHaveProperty('notify');
  });

  it('notify is optional and strict: absent parses; on a state it is rejected', () => {
    expect(DEF.states.build).toMatchObject({ on: { exit_0: { notify: true } } });
    const bad = WorkflowDefinitionSchema.safeParse({
      ...DEF,
      states: { ...DEF.states, done: { type: 'terminal', notify: true } },
    });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------- ADR-0037 P6 (T4)
//
// The workflow `notify` policy: per transition `once` | `every` | `never`, the workflow default for
// `inherit`, engine moves silent unless `engine_moves: inherit`. The decision is recorded on the
// landing's `state_entered` (`notify_decision`) and on the input request it opens.

type Raw = Record<string, unknown>;

/** An agent that hands off a PR (`once`), asks (`every`), and a human review that sends it back. */
function policyDef(policy: Raw = { default: 'once' }, edit?: (states: Raw) => void) {
  const states: Raw = {
    work: {
      type: 'agent',
      prompt: 'implement_template',
      result: ['summary'],
      timeout: '1h',
      on: {
        pr_ready: { goto: 'review', handoff: true, notify: 'once' },
        ask_user: { goto: 'needs_input', question: true, notify: 'every' },
        timeout: 'needs_input',
      },
    },
    review: {
      type: 'human',
      on: {
        request_changes: { goto: 'work', actor: 'human' },
        approve: { goto: 'done', actor: 'human' },
      },
    },
    needs_input: { type: 'human', on: { answer: { goto: '$return_to', actor: 'human' } } },
    done: { type: 'terminal' },
  };
  edit?.(states);
  return WorkflowDefinitionSchema.parse({
    id: 'notify_policy',
    version: 1,
    start: 'work',
    budget: { usd: 5, minutes: 60, max_loop_retries: 3 },
    notify: policy,
    states,
  });
}

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

const agentTakes = (h: Harness, transition: string) =>
  h.run({ type: 'agent.complete_state', result: { summary: 's' }, transition, reason: 'r' });

const humanTakes = (h: Harness, name: string) => {
  const r = h.run({ type: 'human.transition', name, text: 'please fix', actor: 'ui' });
  if (h.snap.agent_command_id !== null && h.snap.status === 'assigned') h.started();
  return r;
};

const decisionOf = (r: { effects: Effect[] }) => find(r.effects, 'state_entered')?.notify_decision;

describe('notify policy (ADR-0037 P6)', () => {
  it('(a) once: the first hand-off pushes; after request_changes and after a reopen it is silent', () => {
    const def = policyDef();
    const h = new Harness(def).claimAndStart();
    let r = agentTakes(h, 'pr_ready');
    const pushed = { via: 'pr_ready', mode: 'once', decision: 'push' };
    expect(decisionOf(r)).toEqual(pushed);
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'handoff',
      notify_decision: pushed,
    });
    expect(find(r.effects, 'state_entered')).not.toHaveProperty('notify');
    expect(r.snapshot.notified_transitions).toEqual(['pr_ready']);

    // Ben's request_changes is a named human move: `inherit` → the default `once`, first take.
    r = humanTakes(h, 'request_changes');
    expect(decisionOf(r)).toEqual({ via: 'request_changes', mode: 'once', decision: 'push' });
    r = agentTakes(h, 'pr_ready');
    const silent = { via: 'pr_ready', mode: 'once', decision: 'silent' };
    expect(decisionOf(r)).toEqual(silent);
    expect(find(r.effects, 'create_input_request')?.notify_decision).toEqual(silent);

    // A reopened session carries `notified_transitions` (reopen.ts): still silent.
    const reopened = freshSnapshot(def);
    reopened.notified_transitions = h.snap.notified_transitions ?? [];
    const h2 = new Harness(def, reopened).claimAndStart();
    expect(decisionOf(agentTakes(h2, 'pr_ready'))).toEqual(silent);
  });

  it('(b) every: each take pushes', () => {
    const def = policyDef({ default: 'once' }, (s) => {
      ((s.work as Raw).on as Raw).pr_ready = { goto: 'review', handoff: true, notify: 'every' };
    });
    const h = new Harness(def).claimAndStart();
    for (let i = 0; i < 3; i++) {
      expect(decisionOf(agentTakes(h, 'pr_ready'))?.decision).toBe('push');
      humanTakes(h, 'request_changes');
    }
  });

  it('(c) ask_user set to every pushes once per question', () => {
    const h = new Harness(policyDef()).claimAndStart();
    for (let i = 0; i < 2; i++) {
      const r = agentTakes(h, 'ask_user');
      expect(find(r.effects, 'create_input_request')?.notify_decision).toEqual({
        via: 'ask_user',
        mode: 'every',
        decision: 'push',
      });
      humanTakes(h, 'answer');
    }
  });

  it('never and the legacy boolean: false is never, true is every', () => {
    const def = policyDef({ default: 'every' }, (s) => {
      const on = (s.work as Raw).on as Raw;
      on.pr_ready = { goto: 'review', handoff: true, notify: false };
      on.ask_user = { goto: 'needs_input', question: true, notify: true };
    });
    const h = new Harness(def).claimAndStart();
    expect(decisionOf(agentTakes(h, 'pr_ready'))).toEqual({
      via: 'pr_ready',
      mode: 'never',
      decision: 'silent',
    });
    humanTakes(h, 'request_changes');
    expect(decisionOf(agentTakes(h, 'ask_user'))?.mode).toBe('every');
  });

  it('engine moves (a timeout) are silent under engine_moves: never', () => {
    const h = new Harness(policyDef()).claimAndStart();
    const r = h.run({ type: 'timer.fired', state: 'work', deadline: h.snap.state_deadline! });
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(decisionOf(r)).toEqual({ via: 'timeout', mode: 'never', decision: 'silent' });
    expect(find(r.effects, 'create_input_request')?.notify_decision?.decision).toBe('silent');
  });

  describe('(d) retries_exhausted into needs_input', () => {
    const build = (policy: Raw, failNotify?: unknown) =>
      WorkflowDefinitionSchema.parse({
        ...DEF,
        notify: policy,
        states: {
          ...DEF.states,
          build: {
            type: 'command',
            cmd: 'make',
            on: {
              exit_0: 'done',
              fail: {
                goto: 'build',
                retries: 0,
                else: 'needs_input',
                ...(failNotify !== undefined ? { notify: failNotify } : {}),
              },
            },
          },
        },
      });

    it('silent under engine_moves: never, whatever the transition says', () => {
      const h = new Harness(build({ default: 'every' }, 'every')).claimAndStart();
      const r = h.cmdExit(1);
      expect(h.snap.workflow_state).toBe('needs_input');
      expect(find(r.effects, 'state_entered')).toMatchObject({ cause: 'retries_exhausted' });
      expect(decisionOf(r)).toEqual({
        via: 'retries_exhausted',
        mode: 'never',
        decision: 'silent',
      });
    });

    it("under engine_moves: inherit, follows the gate's transition mode, else the default", () => {
      const inherit = { default: 'never', engine_moves: 'inherit' };
      let h = new Harness(build(inherit, 'every')).claimAndStart();
      expect(decisionOf(h.cmdExit(1))).toEqual({ via: 'fail', mode: 'every', decision: 'push' });
      h = new Harness(build(inherit, 'never')).claimAndStart();
      expect(decisionOf(h.cmdExit(1))?.decision).toBe('silent');
      h = new Harness(build({ default: 'every', engine_moves: 'inherit' })).claimAndStart();
      expect(decisionOf(h.cmdExit(1))).toEqual({ via: 'fail', mode: 'every', decision: 'push' });
    });
  });

  it('(e) legacy mode: no policy, no decision anywhere; notify: true still marks the move', () => {
    const h = new Harness(DEF).claimAndStart();
    let r = h.cmdExit(1);
    r = h.cmdExit(1);
    for (const e of r.effects) expect(e).not.toHaveProperty('notify_decision');
    expect(entered(r.effects)).toMatchObject({ to: 'needs_input', notify: 'fail' });
    expect(r.snapshot).not.toHaveProperty('notified_transitions');
  });

  it('(f) coalesce: two decisions in one bucket share a push key; the next bucket does not', () => {
    const at = (iso: string) => new Date(iso);
    const key = (iso: string) => notifyBucketKey('t1', 'review', at(iso), 15 * 60);
    expect(key('2026-11-06T10:00:01Z')).toBe(key('2026-11-06T10:14:59Z'));
    expect(key('2026-11-06T10:15:00Z')).not.toBe(key('2026-11-06T10:14:59Z'));
    expect(key('2026-11-06T10:00:01Z')).toMatch(/^notify:t1:review:\d+$/);
  });
});

describe('notifyDecision (pure)', () => {
  const def = policyDef();
  it('null in legacy mode', () => {
    expect(
      notifyDecision(DEF, [], {
        cause: 'transition',
        transition: 'exit_0',
        actor: 'system',
        from: 'build',
      }),
    ).toBeNull();
  });

  it('an unknown transition name takes the default; start and answer_routed are engine moves', () => {
    expect(
      notifyDecision(def, [], {
        cause: 'transition',
        transition: 'nope',
        actor: 'agent',
        from: 'work',
      }),
    ).toEqual({ via: 'nope', mode: 'once', decision: 'push' });
    for (const cause of ['start', 'answer_routed', 'fallback'] as const) {
      expect(
        notifyDecision(def, [], { cause, transition: null, actor: 'system', from: null })?.decision,
      ).toBe('silent');
    }
  });

  it('once remembers by name', () => {
    const move = {
      cause: 'transition',
      transition: 'pr_ready',
      actor: 'agent',
      from: 'work',
    } as const;
    expect(notifyDecision(def, ['pr_ready'], move)?.decision).toBe('silent');
    expect(notifyDecision(def, ['other'], move)?.decision).toBe('push');
  });
});
