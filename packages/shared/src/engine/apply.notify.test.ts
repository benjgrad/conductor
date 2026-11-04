import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { Harness } from './apply.testkit.js';
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
