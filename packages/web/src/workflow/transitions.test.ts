import {
  CONDUCTOR_V1_DEF,
  CONDUCTOR_V2_DRAFT_DEF,
  CONDUCTOR_V4_DEF,
  foldLegacyRequirements,
  TransitionActionSchema,
  type TransitionObject,
  type WorkflowDefinition,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { columnStates, validateColumns } from './columns.js';
import {
  ACTION_SHORT,
  ACTION_TEXT,
  addCondition,
  addTransition,
  arrowTransitions,
  checkListIssues,
  conditionOfType,
  describeTransition,
  getTransitionObject,
  humanDuration,
  kindsText,
  normalizeRequires,
  parentOf,
  ruleCount,
  rulesText,
  patchTransition,
  removeTransition,
  renameTransition,
  sectionOfPath,
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

  it('add going to a given column (a transition drawn onto it, UXR-67)', () => {
    const { definition, name } = addTransition(V2, 'planning', columnStates(V2), 'done');
    expect(getTransitionObject(definition, 'planning', name)?.goto).toBe('done');
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
        'Condition 1: "Jira fields are set" is not available yet: skip it or remove it',
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

describe('checkListIssues (shared with the Repo checks page, ADR-0030)', () => {
  it('names unique (trimmed), commands not blank, timeouts as durations', () => {
    expect(
      checkListIssues(
        [
          { name: 'Build', cmd: 'npm run build', timeout: '10m' },
          { name: ' Build ', cmd: ' ' },
          { name: '', cmd: 'npm test', timeout: '10 min' },
        ],
        undefined,
      ),
    ).toEqual([
      { suffix: 'checks.1.name', message: 'Check 2: Name "Build" is used by another check' },
      { suffix: 'checks.1.cmd', message: 'Check 2: Command is required' },
      { suffix: 'checks.2.name', message: 'Check 3: Name is required' },
      {
        suffix: 'checks.2.timeout',
        message: 'Check 3: Timeout: use a duration like "30m", "2h" or "3d"',
      },
    ]);
  });

  it('setup only with checks, at most 2000 characters; none and auto are fine', () => {
    const one = [{ name: 'Tests', cmd: 'npm test' }];
    expect(checkListIssues([], 'npm ci')).toEqual([
      {
        suffix: 'setup',
        message: 'Setup runs before the checks: add a check, or remove the setup',
      },
    ]);
    expect(checkListIssues(one, 'x'.repeat(2_001))).toEqual([
      { suffix: 'setup', message: 'Setup: the command is too long' },
    ]);
    expect(checkListIssues(one, '')).toEqual([]);
    expect(checkListIssues(one, undefined)).toEqual([]);
    expect(
      checkListIssues(
        Array(21)
          .fill(null)
          .map((_, i) => ({ name: `c${i}`, cmd: 'x' })),
        undefined,
      ),
    ).toEqual([{ suffix: 'checks', message: 'At most 20 checks' }]);
  });
});

describe('describeTransition (UXR-60)', () => {
  const V4 = CONDUCTOR_V4_DEF;
  const rft = () => getTransitionObject(V4, 'implementing', 'ready_for_testing')!;

  it('says what ready_for_testing does, as in the UI review', () => {
    expect(describeTransition(V4, 'implementing', 'ready_for_testing')).toBe(
      'When the agent says **Ready for testing** (work tickets): set up with auto-detect, run ' +
        'Build passes and Tests pass, have a reviewer check 1 item, open a PR, then wait up to ' +
        '3 days for PR checks and 1 approval → **Waiting external**. If not met: back to ' +
        'Implementing with your instruction, up to 3 times, then **Needs input**.',
    );
  });

  it('a question with a non-default poll', () => {
    expect(describeTransition(V4, 'implementing', 'personal_pr_ready_for_review')).toBe(
      'When the agent says **PR ready for review** (personal tickets), asking a question: set up ' +
        'with auto-detect, run Build passes and Tests pass, open a PR, then wait up to 2 hours ' +
        'for PR checks (checked every 1 minute) → **Needs input**. If not met: back to ' +
        'Implementing with your instruction, up to 3 times, then **Needs input**.',
    );
  });

  it('no requirements: the move happens straight away', () => {
    expect(describeTransition(V4, 'planning', 'plan_ready')).toBe(
      'When the agent says **Plan ready**: move straight → **Implementing**.',
    );
    expect(describeTransition(V4, 'needs_input', 'answer')).toBe(
      'When a person picks **Back with this answer**: move straight → **the column that asked**.',
    );
    expect(describeTransition(V4, 'waiting_external', 'ui.approve')).toBe(
      'When **Approved** happens: move straight → **Done**.',
    );
    expect(describeTransition(V4, 'planning', 'nope')).toBe('');
  });

  it('custom setup, labels, no retries, and a half-typed draft', () => {
    const t = rft();
    const def = withT(V4, 'implementing', 'ready_for_testing', {
      ...t,
      requires: {
        ...t.requires!,
        setup: 'pnpm i --frozen-lockfile',
        review: undefined,
        actions: undefined,
        conditions: [
          { type: 'pr_approvals', min: NaN },
          { type: 'pr_merged', label: 'Merged by a person' },
        ],
        condition_timeout: '3x',
      },
      on_unmet: { goto: 'implementing', retries: 0, else: 'needs_input' },
    });
    expect(describeTransition(def, 'implementing', 'ready_for_testing')).toBe(
      'When the agent says **Ready for testing** (work tickets): set up with ' +
        '`pnpm i --frozen-lockfile`, run Build passes and Tests pass, then wait up to 3x for ' +
        '? approvals and Merged by a person → **Waiting external**. If not met: straight to ' +
        '**Needs input**.',
    );
  });

  it('names every action, PR actions included (UXR-61 FR-4)', () => {
    for (const a of TransitionActionSchema.options) {
      expect(ACTION_TEXT[a]).toBeTruthy();
      expect(ACTION_SHORT[a]).toBeTruthy();
    }
    expect([ACTION_TEXT.inspect_pr, ACTION_TEXT.merge_pr, ACTION_TEXT.close_pr]).toEqual([
      'Check the pull request',
      'Merge the pull request',
      'Close the pull request',
    ]);
    const def = withT(V4, 'planning', 'plan_ready', {
      goto: 'implementing',
      requires: { actions: ['inspect_pr', 'merge_pr'] },
      on_unmet: { goto: 'planning', retries: 1, else: 'needs_input' },
    });
    expect(describeTransition(def, 'planning', 'plan_ready')).toContain(
      ': check the PR, merge the PR → **Implementing**.',
    );
  });

  it('conditions alone, without a timeout', () => {
    const def = withT(V4, 'planning', 'plan_ready', {
      goto: 'implementing',
      requires: { conditions: [{ type: 'pr_checks_green' }] },
      on_unmet: { goto: 'planning', retries: 1, else: 'needs_input' },
    });
    expect(describeTransition(def, 'planning', 'plan_ready')).toBe(
      'When the agent says **Plan ready**: wait for PR checks → **Implementing**. If not met: ' +
        'back to Planning, up to 1 time, then **Needs input**.',
    );
  });

  it('humanDuration', () => {
    expect(['3d', '1m', '2h', '30s', '1d', '500ms', '3x', ''].map(humanDuration)).toEqual([
      '3 days',
      '1 minute',
      '2 hours',
      '30 seconds',
      '1 day',
      '500 milliseconds',
      '3x',
      '',
    ]);
  });

  it('sectionOfPath maps a problem to the section that shows it', () => {
    expect(sectionOfPath('')).toBe('who');
    expect(sectionOfPath('.kinds')).toBe('who');
    expect(sectionOfPath('.requires.checks.0.name')).toBe('checks');
    expect(sectionOfPath('.requires.setup')).toBe('checks');
    expect(sectionOfPath('.requires.review.items')).toBe('review');
    expect(sectionOfPath('.requires.actions.1')).toBe('actions');
    expect(sectionOfPath('.requires.conditions.2.min')).toBe('conditions');
    expect(sectionOfPath('.requires.condition_timeout')).toBe('conditions');
    expect(sectionOfPath('.on_unmet.retries')).toBe('unmet');
    expect(sectionOfPath('.requires')).toBeNull();
  });
});

describe('addCondition (UXR-71)', () => {
  it('appends the condition and waits 3d when no timeout is set', () => {
    expect(addCondition({}, { type: 'pr_checks_green' })).toEqual({
      conditions: [{ type: 'pr_checks_green' }],
      condition_timeout: '3d',
    });
  });
  it('keeps an existing timeout', () => {
    expect(
      addCondition(
        { conditions: [{ type: 'pr_merged' }], condition_timeout: '1h' },
        { type: 'pr_checks_green' },
      ),
    ).toEqual({
      conditions: [{ type: 'pr_merged' }, { type: 'pr_checks_green' }],
      condition_timeout: '1h',
    });
  });
});

describe('transition lists (UXR-64, UXR-66)', () => {
  it('counts rules: checks, review items, actions and enabled conditions', () => {
    expect(ruleCount({ goto: 'x' })).toBe(0);
    expect(
      ruleCount({
        goto: 'x',
        requires: {
          checks: [{ name: 'Build', cmd: 'make' }],
          review: { items: ['a', 'b'] },
          actions: ['open_pr'],
          conditions: [{ type: 'pr_checks_green' }, { type: 'pr_merged', enabled: false }],
          condition_timeout: '1d',
        },
      }),
    ).toBe(5);
    expect([0, 1, 3].map(rulesText)).toEqual(['No rules', '1 rule', '3 rules']);
  });

  it('says which tickets a transition is for', () => {
    expect(kindsText({ goto: 'x' })).toBe('All tickets');
    expect(kindsText({ goto: 'x', kinds: ['work', 'personal'] })).toBe('All tickets');
    expect(kindsText({ goto: 'x', kinds: ['work'] })).toBe('Work only');
    expect(kindsText({ goto: 'x', kinds: ['personal'] })).toBe('Personal only');
    expect(kindsText({ goto: 'x', kinds: [] })).toBe('No tickets');
  });

  it('Back goes to the arrow when it stands for several, else to the column', () => {
    expect(parentOf(V2, 'implementing', 'ask_user')).toEqual({
      kind: 'arrow',
      from: 'implementing',
      to: 'needs_input',
    });
    const lone = arrowTransitions(V2, 'planning', 'implementing');
    expect(lone).toHaveLength(1);
    expect(parentOf(V2, 'planning', lone[0]!)).toEqual({ kind: 'column', state: 'planning' });
    // `$return_to` has no arrow.
    const back = withT(V2, 'needs_input', 'answer', { goto: '$return_to' });
    expect(parentOf(back, 'needs_input', 'answer')).toEqual({
      kind: 'column',
      state: 'needs_input',
    });
  });
});
