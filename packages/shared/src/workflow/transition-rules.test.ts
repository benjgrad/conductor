import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1_DEF } from './conductor.js';
import { CONDUCTOR_V2_DRAFT_DEF } from './fixtures.js';
import { RETURN_TO, type Transition } from './schema.js';
import {
  agentTransitionOptions,
  humanTransitionOptions,
  transitionActor,
  transitionMatchesKind,
  transitionNeedsText,
  transitionsOf,
  transitionTitle,
  isCountedTransition,
} from './transition-rules.js';

// ADR-0011 transition helpers (M1b-T01 contract).

const v2 = CONDUCTOR_V2_DRAFT_DEF;
const on = (state: string, name: string): Transition => {
  const s = v2.states[state];
  if (s === undefined || s.type === 'terminal') throw new Error(state);
  return s.on![name]!;
};

describe('transitionActor (ADR-0011 §Who takes a transition)', () => {
  it.each([
    ['timeout from an agent state → system', 'implementing', 'timeout', 'system'],
    ['ui.approve on an event state → system', 'waiting_external', 'ui.approve', 'system'],
    ['plan_ready on an agent state → agent', 'planning', 'plan_ready', 'agent'],
    ['ask_user on an agent state → agent', 'planning', 'ask_user', 'agent'],
    ['explicit actor on a human state wins', 'needs_input', 'answer', 'human'],
    ['explicit human on an event state wins', 'waiting_external', 'back_to_implementing', 'human'],
  ] as const)('%s', (_label, state, name, actor) => {
    expect(transitionActor(v2, state, name, on(state, name))).toBe(actor);
  });

  it('done on an agent state (conductor v1) → agent; a key on a human state → human', () => {
    expect(transitionActor(CONDUCTOR_V1_DEF, 'implementing', 'done', 'waiting_external')).toBe(
      'agent',
    );
    const def = {
      states: { ask: { type: 'human' as const, on: { skip: 'ask' } } },
    };
    expect(transitionActor(def, 'ask', 'skip', 'ask')).toBe('human');
  });

  it('infers by state type: agent / human (human, event) / system (command, connector)', () => {
    const def = {
      states: {
        a: { type: 'agent' as const, prompt: 'p' },
        h: { type: 'human' as const },
        e: { type: 'event' as const, wait_for: ['ui.approve'] },
        c: { type: 'command' as const, cmd: 'true' },
        k: { type: 'connector' as const, action: 'jira.update' },
      },
    };
    expect(
      Object.keys(def.states).map((s) => [s, transitionActor(def, s, 'custom_move', 'x')]),
    ).toEqual([
      ['a', 'agent'],
      ['h', 'human'],
      ['e', 'human'],
      ['c', 'system'],
      ['k', 'system'],
    ]);
    // wait_for names stay system on an event state; explicit wins everywhere
    expect(transitionActor(def, 'e', 'ui.approve', 'x')).toBe('system');
    expect(transitionActor(def, 'c', 'custom_move', { goto: 'x', actor: 'agent' })).toBe('agent');
  });

  it('explicit actor wins over the name rules', () => {
    expect(
      transitionActor(v2, 'implementing', 'timeout', { goto: 'needs_input', actor: 'agent' }),
    ).toBe('agent');
  });

  it.each(['exit_0', 'fail', 'ok', 'error', 'budget_exceeded'])('%s → system', (name) => {
    expect(transitionActor(v2, 'implementing', name, 'done')).toBe('system');
  });
});

describe('kinds (U-062)', () => {
  it('omitted kinds match both; a null kind matches every transition', () => {
    expect(transitionMatchesKind('x', 'work')).toBe(true);
    expect(transitionMatchesKind({ goto: 'x', kinds: ['work'] }, 'personal')).toBe(false);
    expect(transitionMatchesKind({ goto: 'x', kinds: ['work'] }, 'work')).toBe(true);
    expect(transitionMatchesKind({ goto: 'x', kinds: ['work'] }, null)).toBe(true);
  });

  it('agentTransitionOptions filters by kind and keeps ask_user (U-061)', () => {
    const names = (k: 'work' | 'personal' | null) =>
      agentTransitionOptions(v2, 'implementing', k).map((o) => o.name);
    expect(names('work')).toEqual([
      'needs_approval_to_message',
      'pr_ready_for_review',
      'ready_for_testing',
      'ask_user',
    ]);
    expect(names('personal')).toEqual([
      'needs_approval_to_message',
      'pr_ready_for_review',
      'done',
      'ask_user',
    ]);
    expect(names(null)).toEqual([
      'needs_approval_to_message',
      'pr_ready_for_review',
      'ready_for_testing',
      'done',
      'ask_user',
    ]);
    expect(agentTransitionOptions(v2, 'planning', 'work')[1]).toEqual({
      name: 'scope_changed',
      when: 'A new dependency or finding changes the scope of the ticket.',
      question: true,
    });
    expect(agentTransitionOptions(v2, 'needs_input', 'work')).toEqual([]);
  });

  it('transitionsOf filters by actor', () => {
    expect(transitionsOf(v2, 'waiting_external').map((e) => [e.name, e.actor])).toEqual([
      ['ui.approve', 'system'],
      ['back_to_implementing', 'human'],
    ]);
    expect(transitionsOf(v2, 'done')).toEqual([]);
  });
});

describe('human buttons', () => {
  it('humanTransitionOptions resolves $return_to and flags needs_text', () => {
    expect(humanTransitionOptions(v2, 'needs_input', 'personal', 'planning')).toEqual([
      { name: 'answer', title: 'Back with this answer', goto: 'planning', needs_text: true },
      {
        name: 'waiting_on_someone',
        title: 'Waiting on someone else',
        goto: 'waiting_external',
        needs_text: true,
      },
      { name: 'done', title: 'Done', goto: 'done', needs_text: false },
    ]);
    expect(humanTransitionOptions(v2, 'needs_input', null, null)[0]!.goto).toBe(RETURN_TO);
    expect(humanTransitionOptions(v2, 'waiting_external', 'work', null)).toEqual([
      {
        name: 'back_to_implementing',
        title: 'Back to Implementing',
        goto: 'implementing',
        needs_text: false,
      },
    ]);
  });

  it('transitionTitle defaults to the humanised name', () => {
    expect(transitionTitle('ready_for_testing', 'waiting_external')).toBe('Ready for testing');
    expect(transitionTitle('ui.approve', undefined)).toBe('Ui approve');
    expect(transitionTitle('x', { goto: 'y', title: 'Ship it' })).toBe('Ship it');
  });

  it('transitionNeedsText: $return_to and event targets', () => {
    expect(transitionNeedsText(v2, { goto: RETURN_TO })).toBe(true);
    expect(transitionNeedsText(v2, 'waiting_external')).toBe(true);
    expect(transitionNeedsText(v2, 'done')).toBe(false);
    expect(transitionNeedsText(v2, 'implementing')).toBe(false);
  });
});

describe('isCountedTransition (05 §Counting)', () => {
  const gate = { items: ['x'], on_unmet: { goto: 'a', retries: 1, else: 'h' } };
  it.each<[string, Transition, boolean]>([
    ['a state name', 'build', false],
    ['{goto} only', { goto: 'build' }, false],
    [
      'when / kinds / question / title / actor',
      { goto: 'h', when: 'w', kinds: ['work'], question: true, title: 'T', actor: 'agent' },
      false,
    ],
    [
      'requires + on_unmet',
      {
        goto: 'b',
        requires: { actions: ['open_pr'] },
        on_unmet: { goto: 'a', retries: 3, else: 'h' },
      },
      false,
    ],
    ['ADR-0009 requirements only', { goto: 'b', requirements: gate }, false],
    ['attach', { goto: 'a', attach: 'output' }, true],
    ['retries', { goto: 'a', retries: 3 }, true],
    ['else', { goto: 'a', else: 'h' }, true],
    [
      'retries + requires',
      { goto: 'a', retries: 2, requires: { checks: [{ name: 'T', cmd: 't' }] } },
      true,
    ],
  ])('%s → %s', (_label, t, counted) => {
    expect(isCountedTransition(t)).toBe(counted);
  });
});
