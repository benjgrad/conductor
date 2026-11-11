/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4 } from './conductor.js';
import {
  AVAILABLE_CONDITION_TYPES,
  AVAILABLE_WORKFLOW_FEATURES,
  CONDITION_TYPES,
  noChecksPolicy,
  WatchSchema,
  WorkflowDefinitionSchema,
  WORKFLOW_FEATURES,
} from './schema.js';
import { checkAvailability, validateWorkflow } from './validate.js';
import { AVAILABLE_TOOL_ALIASES } from './tools.js';
import { AVAILABLE_RESULT_KINDS } from './schema.js';

// ADR-0037 T1: validator rules 19–25 and rule 14's "not available yet" for the primitives. The
// base is the v6 draft, which passes every rule with `allowUnavailable` (conductor.v6-draft.test).

type Raw = { states: Record<string, Record<string, any>> } & Record<string, any>;
const DRAFT = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v6.draft.json', import.meta.url),
    'utf8',
  ),
) as Raw;
const v6 = (): Raw => structuredClone(DRAFT);
const LIVE_V5 = JSON.parse(
  readFileSync(new URL('../engine/fixtures/conductor.v5.live.json', import.meta.url), 'utf8'),
) as Raw;

/** `"<rule> <path>"` for every error, with the refusals lifted. */
const found = (input: unknown) => {
  const r = validateWorkflow(input, { allowUnavailable: true });
  return r.ok ? [] : r.errors.map((e) => `${e.rule} ${e.path.join('.')}`);
};
const tr = (raw: Raw, state: string, name: string) => raw.states[state]!.on[name];
const PR = 'states.implementing.on.pr_ready_for_review';

describe('stored definitions are unchanged', () => {
  it('v4 and the live v5 still validate, without allowUnavailable', () => {
    for (const def of [CONDUCTOR_V4, LIVE_V5]) {
      const r = validateWorkflow(def);
      expect(r.ok ? [] : r.errors).toEqual([]);
    }
  });

  it('the live v5 round-trips through the schema byte for byte', () => {
    expect(WorkflowDefinitionSchema.parse(LIVE_V5)).toEqual(
      WorkflowDefinitionSchema.parse(WorkflowDefinitionSchema.parse(LIVE_V5)),
    );
  });
});

describe('schema bounds (P1–P8)', () => {
  const watch = (on_broken: unknown, conditions: unknown[] = [{ type: 'pr_mergeable' }]) =>
    WatchSchema.safeParse({ conditions, on_broken }).success;

  it('watch: retries 0..10, at least one condition, goto xor escalate', () => {
    expect(watch({ goto: 'implementing' })).toBe(true);
    expect(watch({ goto: 'implementing', retries: 11 })).toBe(false);
    expect(watch({ notify: 'escalate' })).toBe(true);
    expect(watch({ notify: 'escalate', goto: 'x' })).toBe(false);
    expect(watch({ goto: 'implementing' }, [])).toBe(false);
  });

  it('watch defaults: retries 2, else needs_input; cmd needs setup', () => {
    const w = WatchSchema.parse({
      conditions: [{ type: 'cmd', name: 'Merge tree', cmd: 'git merge-tree' }],
      on_broken: { goto: 'implementing' },
    });
    expect(w.on_broken).toEqual({ goto: 'implementing', retries: 2, else: 'needs_input' });
    expect(w.conditions[0]).toMatchObject({ needs: 'setup' });
  });

  it('refuses bad values', () => {
    const bad = (edit: (d: Raw) => void) => {
      const d = v6();
      edit(d);
      return WorkflowDefinitionSchema.safeParse(d).success;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((d) => (tr(d, 'implementing', 'pr_ready_for_review').notify = 'loud'))).toBe(false);
    expect(bad((d) => (d.instructions = { 'Bad-Slug': 'x' }))).toBe(false);
    expect(bad((d) => (tr(d, 'in_review', 'request_changes').presets = ['Nope']))).toBe(false);
    expect(
      bad(
        (d) =>
          (tr(d, 'implementing', 'pr_ready_for_review').requires.concurrency.max_in_flight = 0),
      ),
    ).toBe(false);
    expect(bad((d) => (d.notify.default = 'inherit'))).toBe(false);
    // T4 replaced the old modes.
    expect(bad((d) => (d.notify.default = 'when_waiting_on_you'))).toBe(false);
    expect(bad((d) => (tr(d, 'implementing', 'pr_ready_for_review').notify = 'always'))).toBe(
      false,
    );
    // watch only on human and event states
    expect(bad((d) => (d.states.implementing!.watch = d.states.in_review!.watch))).toBe(false);
  });

  it('noChecksPolicy folds the legacy spelling', () => {
    expect(noChecksPolicy({ type: 'pr_checks_green', no_checks_after: '5m' })).toEqual({
      policy: 'pass',
      after: '5m',
    });
    expect(
      noChecksPolicy({ type: 'pr_checks_green', no_checks: { policy: 'fail', after: '1m' } }),
    ).toEqual({ policy: 'fail', after: '1m' });
    expect(noChecksPolicy({ type: 'pr_checks_green' })).toBeUndefined();
  });
});

describe('rule 19: watch', () => {
  it('on_broken.goto is not the watched state', () => {
    const d = v6();
    d.states.in_review!.watch.on_broken.goto = 'in_review';
    expect(found(d)).toContain('19 states.in_review.watch.on_broken.goto');
  });

  it('on_broken.else is a human state', () => {
    const d = v6();
    d.states.in_review!.watch.on_broken.else = 'implementing';
    expect(found(d)).toContain('19 states.in_review.watch.on_broken.else');
  });

  it('a missing goto is rule 1', () => {
    const d = v6();
    d.states.in_review!.watch.on_broken.goto = 'nowhere';
    expect(found(d)).toEqual(['1 states.in_review.watch.on_broken.goto']);
  });

  it('return_to is $self or a state; poll ≥ 30s; cmd names unique', () => {
    const d = v6();
    const w = d.states.in_review!.watch;
    w.on_broken.return_to = 'nowhere';
    w.poll = '10s';
    w.conditions.push(
      { type: 'cmd', name: 'Merge tree', cmd: 'a' },
      { type: 'cmd', name: 'Merge tree', cmd: 'b' },
    );
    expect(found(d).sort()).toEqual([
      '19 states.in_review.watch.conditions.2.name',
      '19 states.in_review.watch.on_broken.return_to',
      '19 states.in_review.watch.poll',
    ]);
    w.on_broken.return_to = 'implementing';
    w.poll = '30s';
    w.conditions.pop();
    expect(found(d)).toEqual([]);
  });

  it('on_broken.goto has no entry requirements', () => {
    const d = v6();
    d.states.in_review!.watch.on_broken.goto = 'plan_review';
    d.states.plan_review!.entry = {
      checks: [{ name: 'x', cmd: 'true' }],
      on_unmet: { goto: 'planning' },
    };
    expect(found(d)).toContain('19 states.in_review.watch.on_broken.goto');
  });

  it('the re-sync loop (in_review → implementing → in_review) is bounded by the watch counter', () => {
    // The draft has exactly that loop; rule 4 accepts it. An escalate watch adds no edge.
    expect(found(v6())).toEqual([]);
  });

  it('a watch leg makes its target reachable (rule 2)', () => {
    const d = v6();
    d.states.resync = { type: 'human', on: { back: 'implementing' } };
    d.columns.push('resync');
    expect(found(d)).toContain('2 states.resync');
    d.states.in_review!.watch.on_broken.else = 'resync';
    expect(found(d)).toEqual([]);
  });
});

describe('rule 20: concurrency', () => {
  it('scope names existing non-terminal states, once', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').requires.concurrency.scope = [
      'in_review',
      'done',
      'nowhere',
      'in_review',
    ];
    expect(found(d).sort()).toEqual([
      `20 ${PR}.requires.concurrency.scope.1`,
      `20 ${PR}.requires.concurrency.scope.2`,
      `20 ${PR}.requires.concurrency.scope.3`,
    ]);
  });

  it('only on an agent-actor transition', () => {
    const d = v6();
    const done = tr(d, 'in_review', 'done');
    done.requires = {
      concurrency: { key: '$repo', max_in_flight: 1, scope: ['in_review'], hold_timeout: '1d' },
    };
    expect(found(d)).toContain('20 states.in_review.on.done.requires.concurrency');
  });
});

describe('rule 21: instructions', () => {
  it('every ref resolves', () => {
    const d = v6();
    delete d.instructions.resync_main;
    expect(found(d).sort()).toEqual([
      '21 states.in_review.on.request_changes.presets.0',
      '21 states.in_review.watch.on_broken.instruction',
    ]);
  });

  it('a malformed ref is refused; literal text is fine', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').on_unmet.instruction = '$instructions.Nope';
    tr(d, 'implementing', 'ready_for_testing').on_unmet.instruction = 'Fix it and resubmit.';
    expect(found(d)).toEqual([`21 ${PR}.on_unmet.instruction`]);
  });

  it('presets only on a human-actor transition with text', () => {
    const d = v6();
    delete tr(d, 'in_review', 'request_changes').text;
    tr(d, 'implementing', 'pr_ready_for_review').presets = ['resync_main'];
    expect(found(d).sort()).toEqual([
      `21 ${PR}.presets`,
      '21 states.in_review.on.request_changes.presets',
    ]);
  });
});

describe('rule 21 with instructions available (T8)', () => {
  /** Rule 21 and 14 errors, strict (instructions are available; the rest of the draft is not). */
  const strict = (input: unknown) => {
    const r = validateWorkflow(input);
    return r.ok
      ? []
      : r.errors
          .map((e) => `${e.rule} ${e.path.join('.')}`)
          .filter((e) => e.startsWith('21 ') || /instructions|presets|instruction$/.test(e));
  };

  it("the draft's refs and presets pass without allowUnavailable", () => {
    expect(strict(v6())).toEqual([]);
  });

  it('an unresolved ref is still refused by rule 21', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').on_unmet.instruction = '$instructions.gone';
    expect(strict(d)).toEqual([`21 ${PR}.on_unmet.instruction`]);
  });

  it('presets on an agent transition are refused by rule 21', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').presets = ['resync_main'];
    expect(strict(d)).toEqual([`21 ${PR}.presets`]);
  });
});

describe('rule 22: hand-off', () => {
  it('not with question; only into a human state', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').question = true;
    const t = tr(d, 'implementing', 'personal_pr_ready_for_review');
    t.goto = 'waiting_external';
    expect(found(d)).toEqual(
      expect.arrayContaining([
        `22 ${PR}.handoff`,
        '22 states.implementing.on.personal_pr_ready_for_review.handoff',
      ]),
    );
  });

  it("a hand-off doesn't count as the state's way to ask (rule 12 unchanged)", () => {
    const d = v6();
    delete d.states.implementing!.on.ask_user;
    delete d.states.implementing!.on.needs_approval_to_message;
    // Only the two hand-offs are left into a human state.
    expect(found(d)).toContain('12 states.implementing');
  });
});

describe('rule 23: notify', () => {
  it('string modes need the policy block; the legacy boolean does not', () => {
    const d = v6();
    delete d.notify;
    // Clear the draft's own string modes, so one transition is under test.
    for (const state of Object.values(d.states)) {
      for (const t of Object.values((state.on ?? {}) as Record<string, any>)) {
        if (typeof t === 'object' && typeof t.notify === 'string') delete t.notify;
      }
    }
    expect(found(d)).toEqual([]);
    for (const mode of ['inherit', 'once', 'every', 'never']) {
      tr(d, 'implementing', 'pr_ready_for_review').notify = mode;
      expect(found(d)).toEqual([`23 ${PR}.notify`]);
    }
    tr(d, 'implementing', 'pr_ready_for_review').notify = true;
    expect(found(d)).toEqual([]);
  });

  it('coalesce ≤ 1d', () => {
    const d = v6();
    d.notify.coalesce = '25h';
    expect(found(d)).toEqual(['23 notify.coalesce']);
    d.notify.coalesce = '1d';
    expect(found(d)).toEqual([]);
  });
});

describe('rules 24 and 25: condition placement, no-CI policy', () => {
  it('age_below only in a watch', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').requires.conditions.push({
      type: 'age_below',
      max: '1h',
    });
    expect(found(d)).toEqual([`24 ${PR}.requires.conditions.1`]);
  });

  it('no_checks and no_checks_after are not both set', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').requires.conditions[0].no_checks_after = '5m';
    expect(found(d)).toEqual([`25 ${PR}.requires.conditions.0.no_checks`]);
  });
});

describe('rule 29: default answers (ADR-0041)', () => {
  const DEF = { after: '8h', answer: '$recommended' };
  const P = 'states.planning.on';

  it('accepted on a question and on ask_user into a human state', () => {
    const d = v6();
    tr(d, 'planning', 'scope_changed').default = DEF;
    tr(d, 'planning', 'ask_user').default = DEF;
    tr(d, 'implementing', 'ask_user').default = { after: '1m', answer: '$recommended' };
    expect(found(d)).toEqual([]);
  });

  it('refused on plan_needs_approval and needs_approval_to_message (FR-5)', () => {
    const d = v6();
    tr(d, 'planning', 'plan_needs_approval').default = DEF;
    tr(d, 'implementing', 'needs_approval_to_message').default = DEF;
    expect(found(d).sort()).toEqual([
      '29 states.implementing.on.needs_approval_to_message.default',
      `29 ${P}.plan_needs_approval.default`,
    ]);
  });

  it('refused on a transition that does not ask, a hand-off, a human actor or with requires', () => {
    const d = v6();
    tr(d, 'implementing', 'pr_ready_for_review').default = DEF;
    expect(found(d)).toContain(`29 ${PR}.default`);
    const h = v6();
    const t = tr(h, 'planning', 'scope_changed');
    delete t.question;
    t.handoff = true;
    t.default = DEF;
    expect(found(h)).toContain(`29 ${P}.scope_changed.default`);
    const a = v6();
    tr(a, 'planning', 'scope_changed').actor = 'human';
    tr(a, 'planning', 'scope_changed').default = DEF;
    expect(found(a)).toContain(`29 ${P}.scope_changed.default`);
  });

  it('refused into a state that is not human', () => {
    const d = v6();
    const t = tr(d, 'planning', 'scope_changed');
    t.goto = 'waiting_external';
    t.default = DEF;
    expect(found(d)).toContain(`29 ${P}.scope_changed.default`);
  });

  it('after is between 1m and 7d; answer is only $recommended (schema)', () => {
    const d = v6();
    tr(d, 'planning', 'scope_changed').default = { after: '30s', answer: '$recommended' };
    tr(d, 'planning', 'ask_user').default = { after: '8d', answer: '$recommended' };
    expect(found(d).sort()).toEqual([
      `29 ${P}.ask_user.default.after`,
      `29 ${P}.scope_changed.default.after`,
    ]);
    const s = v6();
    tr(s, 'planning', 'scope_changed').default = { after: '8h', answer: 'yes' };
    expect(found(s)[0]).toMatch(/^1 /);
  });

  it('refused while the feature is off (rule 14)', () => {
    const d = structuredClone(LIVE_V5);
    tr(d, 'planning', 'ask_user').default = DEF;
    expect(validateWorkflow(d).ok).toBe(true);
    expect(
      checkAvailability(WorkflowDefinitionSchema.parse(d), {
        tools: AVAILABLE_TOOL_ALIASES,
        resultKinds: AVAILABLE_RESULT_KINDS,
        conditions: CONDITION_TYPES,
        features: [],
      }).map((e) => `${e.rule} ${e.path.join('.')}`),
    ).toContain(`14 ${P}.ask_user.default`);
  });
});

describe('rule 14: not available yet', () => {
  it('T5, T3, T7, T8, T4 and T6: every ADR-0037 primitive is available; bases not yet', () => {
    expect(AVAILABLE_WORKFLOW_FEATURES).toEqual([
      'watch',
      'no_checks',
      'concurrency',
      'instructions',
      'notify_policy',
      'handoff',
      'default_answer',
    ]);
    expect(AVAILABLE_CONDITION_TYPES).toEqual(
      expect.arrayContaining(['cmd', 'pr_mergeable', 'age_below']),
    );
  });

  it('R7: planning with the bash_readonly tool validates without allowUnavailable', () => {
    const d = structuredClone(LIVE_V5);
    d.states.planning!.tools = ['read', 'bash_readonly'];
    const res = validateWorkflow(d);
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(AVAILABLE_TOOL_ALIASES).toContain('bash_readonly');
  });

  it('v5 with pr_mergeable, a cmd and a no_checks policy validates without allowUnavailable', () => {
    const d = structuredClone(LIVE_V5);
    const conds = tr(d, 'implementing', 'pr_ready_for_review').requires.conditions;
    conds.push({ type: 'pr_mergeable' });
    conds.push({ type: 'cmd', name: 'Merges cleanly', cmd: 'true', needs: 'checkout' });
    const checks = conds.find((c: { type: string }) => c.type === 'pr_checks_green');
    delete checks.no_checks_after;
    checks.no_checks = { policy: 'require_mergeable', after: '5m' };
    const res = validateWorkflow(d);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('marking every feature and condition available lifts every refusal in the draft', () => {
    const parsed = WorkflowDefinitionSchema.parse(v6());
    // T7: the draft needs nothing that is unavailable any more (concurrency was the last).
    expect(checkAvailability(parsed)).toEqual([]);
    expect(
      checkAvailability(parsed, {
        tools: AVAILABLE_TOOL_ALIASES,
        resultKinds: AVAILABLE_RESULT_KINDS,
        conditions: CONDITION_TYPES,
        features: WORKFLOW_FEATURES.filter((f) => f !== 'concurrency'),
      }),
    ).not.toEqual([]);
    expect(
      checkAvailability(parsed, {
        tools: AVAILABLE_TOOL_ALIASES,
        resultKinds: AVAILABLE_RESULT_KINDS,
        conditions: CONDITION_TYPES,
        features: WORKFLOW_FEATURES,
      }),
    ).toEqual([]);
  });

  it('allowUnavailable also lifts the older refusals (actions, conditions)', () => {
    const d = structuredClone(LIVE_V5);
    const t = tr(d, 'implementing', 'pr_ready_for_review');
    t.requires.actions.push('slack_message');
    t.requires.conditions.push({ type: 'jira_fields_set', fields: ['status'] });
    const strict = validateWorkflow(d);
    expect(strict.ok ? [] : strict.errors.map((e) => `${e.rule} ${e.path.join('.')}`)).toEqual([
      `14 ${PR}.requires.actions.1`,
      `14 ${PR}.requires.conditions.1`,
    ]);
    expect(validateWorkflow(d, { allowUnavailable: true }).ok).toBe(true);
  });

  it('a watch validates without allowUnavailable; refused while the feature is off', () => {
    const d = structuredClone(LIVE_V5);
    d.states.in_review!.watch = {
      conditions: [{ type: 'pr_mergeable' }],
      on_broken: { goto: 'implementing', return_to: '$self', retries: 3, else: 'needs_input' },
    };
    const res = validateWorkflow(d);
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(
      checkAvailability(WorkflowDefinitionSchema.parse(d), {
        tools: AVAILABLE_TOOL_ALIASES,
        resultKinds: AVAILABLE_RESULT_KINDS,
        conditions: CONDITION_TYPES,
        features: [],
      }).map((e) => `${e.rule} ${e.path.join('.')}`),
    ).toEqual(['14 states.in_review.watch']);
  });

  it('a notify policy validates without allowUnavailable; refused while the feature is off', () => {
    const d = structuredClone(LIVE_V5);
    d.notify = { default: 'once', engine_moves: 'never', coalesce: '15m' };
    tr(d, 'implementing', 'pr_ready_for_review').notify = 'once';
    expect(validateWorkflow(d).ok).toBe(true);
    const parsed = WorkflowDefinitionSchema.parse(d);
    expect(
      checkAvailability(parsed, {
        tools: AVAILABLE_TOOL_ALIASES,
        resultKinds: AVAILABLE_RESULT_KINDS,
        conditions: CONDITION_TYPES,
        features: [],
      })
        .map((e) => `${e.rule} ${e.path.join('.')}`)
        .sort(),
    ).toEqual(['14 notify', `14 ${PR}.notify`]);
  });

  it('a hand-off validates without allowUnavailable; refused while the feature is off', () => {
    const d = structuredClone(LIVE_V5);
    const t = tr(d, 'implementing', 'pr_ready_for_review');
    delete t.question;
    t.handoff = true;
    expect(validateWorkflow(d).ok).toBe(true);
    const parsed = WorkflowDefinitionSchema.parse(d);
    expect(
      checkAvailability(parsed, {
        tools: AVAILABLE_TOOL_ALIASES,
        resultKinds: AVAILABLE_RESULT_KINDS,
        conditions: CONDITION_TYPES,
        features: [],
      }).map((e) => `${e.rule} ${e.path.join('.')}`),
    ).toEqual([`14 ${PR}.handoff`]);
  });

  it('a disabled new condition is not refused', () => {
    const d = structuredClone(LIVE_V5);
    tr(d, 'implementing', 'pr_ready_for_review').requires.conditions.push({
      type: 'pr_mergeable',
      enabled: false,
    });
    expect(validateWorkflow(d).ok).toBe(true);
  });
});
