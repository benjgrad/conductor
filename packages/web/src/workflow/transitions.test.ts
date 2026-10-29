import {
  CONDUCTOR_V1_DEF,
  CONDUCTOR_V2_DRAFT_DEF,
  foldLegacyRequirements,
  type TransitionObject,
  type WorkflowDefinition,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { columnStates, validateColumns } from './columns.js';
import {
  addTransition,
  arrowTransitions,
  conditionOfType,
  getTransitionObject,
  normalizeRequires,
  patchTransition,
  removeTransition,
  renameTransition,
  setRequires,
  transitionNameProblem,
  transitionNames,
  validateTransitions,
} from './transitions.js';

const V2 = CONDUCTOR_V2_DRAFT_DEF;

/** Replace one transition (test fixtures). */
function withT(
  def: WorkflowDefinition,
  from: string,
  name: string,
  t: TransitionObject,
): WorkflowDefinition {
  const out = structuredClone(def);
  const s = out.states[from]!;
  if (s.type === 'terminal') throw new Error('terminal');
  s.on = { ...s.on, [name]: t };
  return out;
}

const issues = (def: WorkflowDefinition) =>
  validateTransitions(def).map((i) => [i.path, i.message]);

describe('transition edits', () => {
  it('list an arrow’s transitions in definition order', () => {
    expect(arrowTransitions(V2, 'implementing', 'needs_input')).toEqual([
      'needs_approval_to_message',
      'pr_ready_for_review',
      'ask_user',
      'timeout',
    ]);
    expect(transitionNames(V2, 'done')).toEqual([]);
  });

  it('rename in place, keep order, and refuse duplicates and spaces', () => {
    const def = renameTransition(V2, 'planning', 'plan_ready', 'ready');
    expect(transitionNames(def, 'planning')[0]).toBe('ready');
    expect(getTransitionObject(def, 'planning', 'ready')?.goto).toBe('implementing');
    expect(transitionNameProblem(V2, 'planning', 'plan_ready', 'impossible')).toMatch(/already/);
    expect(transitionNameProblem(V2, 'planning', 'plan_ready', 'two words')).toMatch(/spaces/);
    expect(transitionNameProblem(V2, 'planning', 'plan_ready', '')).toMatch(/empty/);
    expect(() => renameTransition(V2, 'planning', 'plan_ready', 'impossible')).toThrow();
    // The input is untouched.
    expect(transitionNames(V2, 'planning')[0]).toBe('plan_ready');
  });

  it('store a bare {goto} as a string, and drop cleared fields', () => {
    const def = patchTransition(V2, 'planning', 'plan_ready', {
      title: undefined,
      when: undefined,
    });
    const planning = def.states.planning!;
    if (planning.type === 'terminal') throw new Error('fixture');
    expect(planning.on?.plan_ready).toBe('implementing');
  });

  it('add with a fresh name, going to the next column; remove', () => {
    const { definition, name } = addTransition(V2, 'implementing', columnStates(V2));
    expect(name).toBe('new_transition');
    expect(getTransitionObject(definition, 'implementing', name)?.goto).toBe('needs_input');
    expect(addTransition(definition, 'implementing', columnStates(V2)).name).toBe(
      'new_transition_2',
    );
    expect(
      transitionNames(removeTransition(definition, 'implementing', name), 'implementing'),
    ).toEqual(transitionNames(V2, 'implementing'));
  });

  it('requires: the first requirement brings a default on_unmet, none left drops it', () => {
    let def = setRequires(V2, 'planning', 'plan_ready', { checks: [{ name: 'Lint', cmd: 'x' }] });
    expect(getTransitionObject(def, 'planning', 'plan_ready')).toMatchObject({
      requires: { checks: [{ name: 'Lint', cmd: 'x' }] },
      on_unmet: { goto: 'planning', retries: 3, else: 'needs_input' },
    });
    def = setRequires(def, 'planning', 'plan_ready', { checks: [] });
    const t = getTransitionObject(def, 'planning', 'plan_ready')!;
    expect(t.requires).toBeUndefined();
    expect(t.on_unmet).toBeUndefined();
  });

  it('normalize: setup only with checks, timeout and poll only with conditions', () => {
    expect(normalizeRequires({ setup: 'npm ci', condition_timeout: '1d' })).toBeUndefined();
    expect(
      normalizeRequires({
        checks: [{ name: 'a', cmd: 'b' }],
        setup: '',
        review: { items: [] },
        conditions: [{ type: 'pr_merged' }],
        condition_timeout: '1d',
      }),
    ).toEqual({
      checks: [{ name: 'a', cmd: 'b' }],
      setup: '',
      conditions: [{ type: 'pr_merged' }],
      condition_timeout: '1d',
    });
  });

  it('change a condition’s type, keeping enabled and label', () => {
    expect(
      conditionOfType('pr_approvals', { type: 'pr_merged', enabled: false, label: 'L' }),
    ).toEqual({ type: 'pr_approvals', min: 1, enabled: false, label: 'L' });
    expect(conditionOfType('jira_fields_set')).toEqual({ type: 'jira_fields_set', fields: [] });
    // U-072: re-picking PR checks keeps its no-CI grace; another type drops it.
    const graced = { type: 'pr_checks_green', no_checks_after: '5m' } as const;
    expect(conditionOfType('pr_checks_green', graced)).toEqual(graced);
    expect(conditionOfType('pr_merged', graced)).toEqual({ type: 'pr_merged' });
  });
});

describe('client validation (ADR-0011 rules 10–14)', () => {
  it('passes the v2 draft, v1, and v1 folded', () => {
    expect(issues(V2)).toEqual([]);
    expect(validateColumns(V2)).toEqual([]);
    expect(issues(CONDUCTOR_V1_DEF)).toEqual([]);
    expect(validateColumns(foldLegacyRequirements(CONDUCTOR_V1_DEF))).toEqual([]);
  });

  it('rule 10: the actor fits the state; $return_to only out of a human column', () => {
    let def = withT(V2, 'needs_input', 'go', { goto: 'done', actor: 'agent' });
    def = withT(def, 'planning', 'by_hand', { goto: 'implementing', actor: 'human' });
    def = withT(def, 'planning', 'back', { goto: '$return_to' });
    expect(issues(def)).toEqual([
      [
        'states.planning.on.by_hand.actor',
        'only human and waiting columns have transitions a person takes',
      ],
      [
        'states.planning.on.back.goto',
        '"back to the state that asked" is only for a human column’s transitions',
      ],
      [
        'states.needs_input.on.go.actor',
        'only an agent column’s transitions can be taken by the agent',
      ],
    ]);
  });

  it('rule 11: a question goes to a human column', () => {
    const def = withT(V2, 'planning', 'plan_ready', { goto: 'implementing', question: true });
    expect(issues(def)).toEqual([
      [
        'states.planning.on.plan_ready.question',
        'only a transition to a human column can ask a question',
      ],
    ]);
  });

  it('rule 12: every agent column can ask', () => {
    const def = structuredClone(V2);
    const impl = def.states.implementing!;
    if (impl.type !== 'agent') throw new Error('fixture');
    impl.on = { done: 'done' };
    expect(issues(def).map(([p]) => p)).toEqual(['states.implementing.on']);
  });

  it('rule 13: conditions need a timeout; requirements need on_unmet with a human else', () => {
    let def = withT(V2, 'implementing', 'ready_for_testing', {
      goto: 'waiting_external',
      requires: { conditions: [{ type: 'pr_checks_green' }] },
      on_unmet: { goto: 'implementing', retries: 3, else: 'planning' },
    });
    def = withT(def, 'planning', 'plan_ready', {
      goto: 'implementing',
      requires: { actions: ['open_pr'] },
    });
    expect(issues(def)).toEqual([
      ['states.planning.on.plan_ready.on_unmet', 'requirements need a "when not met"'],
      [
        'states.implementing.on.ready_for_testing.requires.condition_timeout',
        'conditions need a timeout (how long to wait for them)',
      ],
      ['states.implementing.on.ready_for_testing.on_unmet.else', '"then" must be a human column'],
    ]);
  });

  it('rule 14: unavailable actions and enabled conditions, requirements into the start', () => {
    let def = withT(V2, 'implementing', 'ready_for_testing', {
      goto: 'waiting_external',
      requires: {
        actions: ['open_pr', 'slack_message'],
        conditions: [{ type: 'jira_fields_set', fields: ['status'] }],
        condition_timeout: '3d',
      },
      on_unmet: { goto: 'implementing', retries: 3, else: 'needs_input' },
    });
    def = withT(def, 'waiting_external', 'restart', {
      goto: 'planning',
      actor: 'human',
      requires: { checks: [{ name: 'x', cmd: 'y' }] },
      on_unmet: { goto: 'implementing', retries: 1, else: 'needs_input' },
    });
    expect(issues(def)).toEqual([
      [
        'states.implementing.on.ready_for_testing.requires.actions.1',
        '"Send a Slack message" is not available yet',
      ],
      [
        'states.implementing.on.ready_for_testing.requires.conditions.0',
        '"Jira fields set" is not available yet: disable it',
      ],
      [
        'states.waiting_external.on.restart.requires',
        'a move into the first column cannot have requirements',
      ],
    ]);
  });

  it('field limits: kinds, durations, condition args, empty checks', () => {
    const def = withT(V2, 'implementing', 'ready_for_testing', {
      goto: 'waiting_external',
      kinds: [],
      requires: {
        checks: [{ name: '', cmd: ' ', timeout: 'soon' }],
        conditions: [
          { type: 'pr_approvals', min: 0 },
          { type: 'azure_pipeline_succeeded', pipeline: ' ', enabled: false },
        ],
        condition_timeout: '3 days',
      },
      on_unmet: { goto: 'done', retries: 11, else: 'needs_input' },
    });
    expect(issues(def).map(([p]) => p)).toEqual([
      'states.implementing.on.ready_for_testing.kinds',
      'states.implementing.on.ready_for_testing.requires.checks.0.name',
      'states.implementing.on.ready_for_testing.requires.checks.0.cmd',
      'states.implementing.on.ready_for_testing.requires.checks.0.timeout',
      'states.implementing.on.ready_for_testing.requires.conditions.0.min',
      'states.implementing.on.ready_for_testing.requires.conditions.1.pipeline',
      'states.implementing.on.ready_for_testing.requires.condition_timeout',
      'states.implementing.on.ready_for_testing.on_unmet.goto',
      'states.implementing.on.ready_for_testing.on_unmet.retries',
    ]);
  });

  it('feed validateColumns with the transition attached', () => {
    const def = withT(V2, 'planning', 'plan_ready', { goto: 'implementing', question: true });
    expect(validateColumns(def)).toEqual([
      {
        state: 'planning',
        path: 'states.planning.on.plan_ready.question',
        message: 'only a transition to a human column can ask a question',
        transition: { from: 'planning', name: 'plan_ready' },
      },
    ]);
  });
});
