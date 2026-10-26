/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- raw definition edits in tests */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1, CONDUCTOR_V1_DEF } from './conductor.js';
import { foldLegacyRequirements } from './fold.js';
import { CONDUCTOR_V2_DRAFT } from './fixtures.js';
import { RETURN_TO } from './schema.js';
import { validateWorkflow } from './validate.js';

// M1b-T02: validator rules 10–14 (ADR-0011) and the graph rules' reading of transitions.

const reference = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  );

type Raw = { start: string; columns: string[]; states: Record<string, Record<string, any>> };
const v2 = (): Raw => structuredClone(CONDUCTOR_V2_DRAFT) as Raw;
const on = (raw: Raw, state: string) => raw.states[state]!.on as Record<string, any>;
const paths = (input: unknown) => {
  const r = validateWorkflow(input);
  return r.ok ? [] : r.errors.map((e) => `${e.rule} ${e.path.join('.')}`);
};

describe('shipped workflows still validate', () => {
  it.each(['conductor.v1.json', 'm1_basic.v1.json', 'm1_reviewed.v1.json', 'pr_flow.v1.json'])(
    '%s',
    (name) => {
      expect(paths(reference(name))).toEqual([]);
    },
  );

  it('foldLegacyRequirements(conductor v1) validates', () => {
    const folded = foldLegacyRequirements(CONDUCTOR_V1_DEF);
    expect(folded).not.toBe(CONDUCTOR_V1_DEF);
    expect(paths(folded)).toEqual([]);
  });

  it('foldLegacyRequirements(m1_reviewed) validates', () => {
    const r = validateWorkflow(reference('m1_reviewed.v1.json'));
    if (!r.ok) throw new Error('m1_reviewed is invalid');
    expect(paths(foldLegacyRequirements(r.def))).toEqual([]);
  });

  it('the conductor v2 draft (M1b-T01) validates', () => {
    expect(paths(CONDUCTOR_V2_DRAFT)).toEqual([]);
  });

  it('conductor v1 is still a valid starting point for the raw-edit tests', () => {
    expect(paths(CONDUCTOR_V1)).toEqual([]);
  });
});

const IMPL = 'states.implementing.on';
const PLAN = 'states.planning.on';
const NI = 'states.needs_input.on';
const WE = 'states.waiting_external.on';

// One row per case: a mutation of the v2 draft and the exact errors (`<rule> <path>`) it yields.
const CASES: [string, (raw: Raw) => void, string[]][] = [
  // Rule 10: actor fits the state.
  [
    'explicit actor agent on a human state',
    (r) => (on(r, 'needs_input').done.actor = 'agent'),
    [`10 ${NI}.done.actor`],
  ],
  [
    'explicit actor agent on an event state',
    (r) => (on(r, 'waiting_external').back_to_implementing.actor = 'agent'),
    // No longer a human's move, so the Implementing ↔ Waiting external loop is unbounded too.
    [`10 ${WE}.back_to_implementing.actor`, '4 states.implementing'],
  ],
  [
    'actor human on an agent state',
    (r) => (on(r, 'implementing').needs_approval_to_message.actor = 'human'),
    [`10 ${IMPL}.needs_approval_to_message.actor`],
  ],
  [
    '$return_to on an event state',
    (r) => (on(r, 'waiting_external').back_to_implementing.goto = RETURN_TO),
    [`10 ${WE}.back_to_implementing.goto`],
  ],
  [
    '$return_to on an agent state',
    (r) => (on(r, 'planning').plan_ready = { goto: RETURN_TO }),
    [`10 ${PLAN}.plan_ready.goto`],
  ],
  [
    '$return_to as an on_unmet target',
    (r) => (on(r, 'implementing').done.on_unmet.goto = RETURN_TO),
    [`10 ${IMPL}.done.on_unmet.goto`],
  ],
  [
    '$return_to taken by the system',
    (r) => (on(r, 'needs_input').answer.actor = 'system'),
    [`10 ${NI}.answer.actor`],
  ],
  // Rule 11: questions go to a human state.
  [
    'question into an agent state',
    (r) => (on(r, 'planning').plan_ready.question = true),
    // A question does not complete Planning, so Implementing's `$planning.plan` is unproven.
    [`11 ${PLAN}.plan_ready.question`, '5 states.implementing.input.plan'],
  ],
  [
    'question into a terminal state',
    (r) => (on(r, 'implementing').done.question = true),
    [`11 ${IMPL}.done.question`],
  ],
  [
    'question on $return_to',
    (r) => (on(r, 'needs_input').answer.question = true),
    [`11 ${NI}.answer.question`],
  ],
  // Rule 12: every agent state can ask.
  [
    'no ask_user and no question transition',
    (r) => {
      const o = on(r, 'implementing');
      delete o.ask_user;
      delete o.needs_approval_to_message;
      delete o.pr_ready_for_review;
    },
    [`12 states.implementing`],
  ],
  [
    'ask_user into a non-human state does not count',
    (r) => {
      const o = on(r, 'implementing');
      o.ask_user = 'waiting_external';
      delete o.needs_approval_to_message;
      delete o.pr_ready_for_review;
    },
    [`12 states.implementing`],
  ],
  // Rule 13: bounded requirements.
  [
    'conditions without condition_timeout',
    (r) => delete on(r, 'implementing').ready_for_testing.requires.condition_timeout,
    [`13 ${IMPL}.ready_for_testing.requires.condition_timeout`],
  ],
  [
    'requires without on_unmet',
    (r) => delete on(r, 'implementing').done.on_unmet,
    [`13 ${IMPL}.done.on_unmet`],
  ],
  [
    'on_unmet.else not a human state',
    (r) => (on(r, 'implementing').ready_for_testing.on_unmet.else = 'waiting_external'),
    [`13 ${IMPL}.ready_for_testing.on_unmet.else`],
  ],
  [
    'on_unmet.goto is the transition target',
    (r) => (on(r, 'implementing').ready_for_testing.on_unmet.goto = 'waiting_external'),
    [`13 ${IMPL}.ready_for_testing.on_unmet.goto`],
  ],
  [
    'on_unmet.goto into a state with legacy entry (nested steps)',
    (r) => {
      r.states.implementing!.entry = { actions: ['open_pr'], on_unmet: { goto: 'planning' } };
    },
    [
      `13 ${IMPL}.pr_ready_for_review.on_unmet.goto`,
      `13 ${IMPL}.ready_for_testing.on_unmet.goto`,
      `13 ${IMPL}.done.on_unmet.goto`,
    ],
  ],
  [
    'on_unmet without requires',
    (r) => (on(r, 'planning').plan_ready.on_unmet = { goto: 'planning' }),
    [`13 ${PLAN}.plan_ready.on_unmet`],
  ],
  [
    'requires with nothing to check',
    (r) => (on(r, 'implementing').done.requires = { setup: '' }),
    [`13 ${IMPL}.done.requires`, `13 ${IMPL}.done.requires.setup`],
  ],
  [
    'blank check command and duplicate check / action',
    (r) =>
      (on(r, 'implementing').done.requires = {
        checks: [
          { name: 'a', cmd: ' ' },
          { name: 'a', cmd: 'x' },
        ],
        actions: ['open_pr', 'open_pr'],
      }),
    [
      `13 ${IMPL}.done.requires.checks.0.cmd`,
      `13 ${IMPL}.done.requires.checks.1.name`,
      `13 ${IMPL}.done.requires.actions.1`,
    ],
  ],
  [
    'requires on a fallback route',
    (r) =>
      (on(r, 'implementing').ask_user = {
        goto: 'needs_input',
        requires: { actions: ['open_pr'] },
        on_unmet: { goto: 'planning' },
      }),
    [`13 ${IMPL}.ask_user.requires`],
  ],
  // Rule 14: what M1b can run.
  [
    'update_jira action',
    (r) => (on(r, 'implementing').done.requires.actions = ['open_pr', 'update_jira']),
    [`14 ${IMPL}.done.requires.actions.1`],
  ],
  [
    'slack_message action',
    (r) => (on(r, 'implementing').ready_for_testing.requires.actions = ['slack_message']),
    [`14 ${IMPL}.ready_for_testing.requires.actions.0`],
  ],
  [
    'an enabled M5 condition',
    (r) => (on(r, 'implementing').ready_for_testing.requires.conditions[3].enabled = true),
    [`14 ${IMPL}.ready_for_testing.requires.conditions.3`],
  ],
  [
    'requires on a transition into the start state',
    (r) =>
      (on(r, 'waiting_external').back_to_implementing = {
        goto: 'planning',
        actor: 'human',
        requires: { actions: ['open_pr'] },
        on_unmet: { goto: 'implementing' },
      }),
    [`14 ${WE}.back_to_implementing.requires`],
  ],
];

describe('rules 10–14 on the conductor v2 draft', () => {
  it.each(CASES)('%s', (_name, mutate, expected) => {
    const raw = v2();
    mutate(raw);
    expect(paths(raw)).toEqual(expected);
  });

  it('a disabled M5 condition and an explicit human actor on an event state are fine', () => {
    const raw = v2();
    on(raw, 'waiting_external').back_to_implementing.actor = 'human';
    expect(on(raw, 'implementing').ready_for_testing.requires.conditions[2].enabled).toBe(false);
    expect(paths(raw)).toEqual([]);
  });

  it('an agent-actor question transition satisfies rule 12 without ask_user', () => {
    const raw = v2();
    delete on(raw, 'planning').ask_user;
    expect(paths(raw)).toEqual([]);
  });
});

describe('graph rules read transitions (ADR-0011)', () => {
  it('rule 4: a plain object transition is uncounted (isCountedTransition)', () => {
    const raw = reference('m1_basic.v1.json') as Raw;
    raw.states.build!.on = { exit_0: 'test', fail: { goto: 'implement', when: 'It failed.' } };
    expect(paths(raw)).toEqual(['4 states.implement']);
  });

  it('rule 4: a move on_unmet.goto leg is bounded by its counter', () => {
    // implementing -done-> done, unmet → implementing: a self-loop on the counted leg.
    expect(paths(CONDUCTOR_V2_DRAFT)).toEqual([]);
    const raw = v2();
    on(raw, 'implementing').done.on_unmet.goto = 'planning';
    expect(paths(raw)).toEqual([]);
  });

  it("rule 4: a move's else leg is not bounded", () => {
    const raw = v2();
    // A command state as on_unmet.else is rule 13; give it a loop back so rule 4 sees the leg.
    raw.states.retry = {
      type: 'command',
      cmd: 'true',
      on: { exit_0: 'implementing', fail: 'needs_input' },
    };
    raw.columns = [...raw.columns, 'retry'];
    on(raw, 'implementing').done.on_unmet.else = 'retry';
    expect(paths(raw)).toEqual([`13 ${IMPL}.done.on_unmet.else`, '4 states.implementing']);
  });

  it('rule 4: a human-actor transition out of an event state bounds the loop', () => {
    // implementing -ready_for_testing-> waiting_external -back_to_implementing-> implementing.
    const raw = v2();
    on(raw, 'waiting_external').back_to_implementing.actor = 'system';
    expect(paths(raw)).toEqual(['4 states.implementing']);
  });

  it('rule 1: $return_to is not an unknown target; rule 2 still sees the human edges', () => {
    const raw = v2();
    delete on(raw, 'needs_input').waiting_on_someone;
    on(raw, 'implementing').ready_for_testing.goto = 'done';
    // waiting_external is now reachable only through... nothing.
    expect(paths(raw)).toEqual(['2 states.waiting_external']);
  });

  it('rule 5: the producer completes on a named agent transition, not a question', () => {
    const raw = v2();
    // A path into implementing straight from a planning question would skip the plan.
    on(raw, 'planning').scope_changed.goto = 'implementing';
    delete on(raw, 'planning').scope_changed.question;
    expect(paths(raw)).toEqual([]);
    const raw2 = v2();
    on(raw2, 'planning').ask_user = 'implementing';
    // ask_user into a non-human state: rule 12 no longer satisfied by it, but questions remain.
    expect(paths(raw2)).toEqual(['5 states.implementing.input.plan']);
  });

  it('rule 5: a human move is an override, not a path the ref must hold on', () => {
    // needs_input -waiting_on_someone-> waiting_external -back_to_implementing-> implementing can
    // follow a planning question, before the plan exists; it is a human's choice.
    expect(paths(CONDUCTOR_V2_DRAFT)).toEqual([]);
  });
});
