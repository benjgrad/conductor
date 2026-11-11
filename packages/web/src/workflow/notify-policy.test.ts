import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { effectiveMode, notifyOptions, notifyRows, setTransitionNotify } from './notify-policy.js';

// ADR-0037 P6: the helpers behind the Notifications section's per-transition table.

function def(withPolicy: boolean): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id: 'w',
    version: 1,
    start: 'planning',
    budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
    ...(withPolicy ? { notify: { default: 'once', engine_moves: 'never' } } : {}),
    states: {
      planning: {
        type: 'agent',
        title: 'Planning',
        prompt: 'p',
        timeout: '1h',
        on: {
          timeout: 'needs_input',
          plan_ready: {
            goto: 'review',
            title: 'Plan ready',
            ...(withPolicy ? {} : { notify: true }),
          },
          ask_user: { goto: 'needs_input', notify: withPolicy ? 'every' : false },
        },
      },
      review: {
        type: 'human',
        title: 'Review',
        on: { approve: { goto: 'done', actor: 'human', title: 'Approve' } },
      },
      needs_input: { type: 'human', on: { answer: '$return_to' } },
      done: { type: 'terminal' },
    },
  });
}

describe('notifyRows', () => {
  it('lists every transition by column, with titles, actor and choice', () => {
    expect(notifyRows(def(true))).toEqual([
      expect.objectContaining({
        from: 'planning',
        name: 'timeout',
        toTitle: 'needs_input',
        choice: '',
      }),
      expect.objectContaining({
        from: 'planning',
        name: 'plan_ready',
        title: 'Plan ready',
        fromTitle: 'Planning',
        toTitle: 'Review',
        choice: '',
      }),
      expect.objectContaining({ name: 'ask_user', choice: 'every', actor: 'agent' }),
      expect.objectContaining({ from: 'review', name: 'approve', actor: 'human', toTitle: 'done' }),
      expect.objectContaining({
        from: 'needs_input',
        name: 'answer',
        toTitle: 'The column that asked',
      }),
    ]);
  });

  it('reads the legacy boolean as every / never', () => {
    const rows = notifyRows(def(false));
    expect(rows.find((r) => r.name === 'plan_ready')!.choice).toBe('every');
    expect(rows.find((r) => r.name === 'ask_user')!.choice).toBe('never');
  });
});

describe('setTransitionNotify', () => {
  it('stores a mode under a policy and drops it again for Inherit', () => {
    const d = setTransitionNotify(def(true), 'planning', 'plan_ready', 'never');
    expect(d.states.planning).toMatchObject({ on: { plan_ready: { notify: 'never' } } });
    const back = setTransitionNotify(d, 'planning', 'plan_ready', '');
    const pr = (back.states.planning as { on: Record<string, unknown> }).on.plan_ready;
    expect('notify' in (pr as object)).toBe(false);
  });

  it('turns a string transition into an object and back', () => {
    const d = setTransitionNotify(def(true), 'planning', 'timeout', 'once');
    expect(d.states.planning).toMatchObject({
      on: { timeout: { goto: 'needs_input', notify: 'once' } },
    });
    const back = setTransitionNotify(d, 'planning', 'timeout', '');
    expect((back.states.planning as { on: Record<string, unknown> }).on.timeout).toBe(
      'needs_input',
    );
  });

  it('stores the legacy boolean without a policy', () => {
    const d = setTransitionNotify(def(false), 'planning', 'timeout', 'every');
    expect(d.states.planning).toMatchObject({ on: { timeout: { notify: true } } });
    const off = setTransitionNotify(d, 'planning', 'timeout', 'never');
    expect(off.states.planning).toMatchObject({ on: { timeout: { notify: false } } });
  });
});

describe('notifyOptions / effectiveMode', () => {
  it('names the default on Inherit under a policy; no Once without one', () => {
    expect(notifyOptions(def(true))).toEqual([
      { value: '', text: 'Inherit (once per ticket)' },
      { value: 'once', text: 'Once per ticket' },
      { value: 'every', text: 'Every time' },
      { value: 'never', text: 'Never' },
    ]);
    expect(notifyOptions(def(false)).map((o) => o.value)).toEqual(['', 'every', 'never']);
  });

  it('Inherit is the default under a policy, never without one', () => {
    expect(effectiveMode(def(true), '')).toBe('once');
    expect(effectiveMode(def(false), '')).toBe('never');
    expect(effectiveMode(def(false), 'every')).toBe('every');
  });
});
