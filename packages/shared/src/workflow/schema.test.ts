import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT, CONDUCTOR_V2_DRAFT_DEF } from './fixtures.js';
import {
  CONDITION_TYPES,
  ConditionSchema,
  RETURN_TO,
  TicketKindSchema,
  TransitionObjectSchema,
  conditionEnabled,
  conditionLabel,
  parseDuration,
  WorkflowDefinitionSchema,
} from './schema.js';

const load = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  );

describe('WorkflowDefinition', () => {
  it.each(['m1_basic.v1.json', 'pr_flow.v1.json'])('parses reference workflow %s', (name) => {
    const def = WorkflowDefinitionSchema.parse(load(name));
    expect(def.states[def.start]).toBeDefined();
    expect(def.on_budget_exceeded).toBe('needs_input');
  });

  it('defaults on_budget_exceeded to needs_input', () => {
    const raw = load('m1_basic.v1.json') as Record<string, unknown>;
    delete raw.on_budget_exceeded;
    expect(WorkflowDefinitionSchema.parse(raw).on_budget_exceeded).toBe('needs_input');
  });

  it('rejects unknown keys (typos) and unknown state types', () => {
    const raw = load('m1_basic.v1.json') as { states: Record<string, Record<string, unknown>> };
    raw.states.build!.timout = '10m';
    expect(WorkflowDefinitionSchema.safeParse(raw).success).toBe(false);
    const raw2 = load('m1_basic.v1.json') as { states: Record<string, Record<string, unknown>> };
    raw2.states.build!.type = 'shell';
    expect(WorkflowDefinitionSchema.safeParse(raw2).success).toBe(false);
  });

  it('requires exactly one of prompt/skill on agent states', () => {
    const raw = load('m1_basic.v1.json') as { states: Record<string, Record<string, unknown>> };
    raw.states.implement!.skill = 'x';
    expect(WorkflowDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a bad duration', () => {
    const raw = load('m1_basic.v1.json') as { states: Record<string, Record<string, unknown>> };
    raw.states.build!.timeout = '10 minutes';
    expect(WorkflowDefinitionSchema.safeParse(raw).success).toBe(false);
  });
});

describe('ADR-0011 transitions (M1b-T01)', () => {
  it.each(['conductor.v1.json', 'm1_basic.v1.json', 'm1_reviewed.v1.json', 'pr_flow.v1.json'])(
    'old definition %s parses unchanged',
    (name) => {
      const raw = load(name);
      const parsed = WorkflowDefinitionSchema.parse(raw);
      // parse only adds defaults: re-parsing the output is a fixed point
      expect(WorkflowDefinitionSchema.parse(parsed)).toEqual(parsed);
      expect(parsed.states).toMatchObject((raw as { states: object }).states);
    },
  );

  it('the draft v2 fixture parses, with every new transition field', () => {
    const d = WorkflowDefinitionSchema.parse(CONDUCTOR_V2_DRAFT);
    expect(d).toEqual(CONDUCTOR_V2_DRAFT_DEF);
    const impl = d.states.implementing;
    const rft = impl?.type === 'agent' ? impl.on?.ready_for_testing : undefined;
    expect(rft).toMatchObject({
      kinds: ['work'],
      requires: { condition_timeout: '3d', actions: ['open_pr'] },
      on_unmet: { retries: 3, else: 'needs_input' },
    });
    const ni = d.states.needs_input;
    expect(ni?.type === 'human' && ni.on?.answer).toMatchObject({
      goto: RETURN_TO,
      actor: 'human',
    });
  });

  it('ConditionTypeSchema lists exactly the ConditionSchema variants', () => {
    expect(ConditionSchema.options.map((o) => o.shape.type.value)).toEqual([...CONDITION_TYPES]);
  });

  it.each([
    [{ type: 'pr_approvals', min: 0 }],
    [{ type: 'pr_approvals' }],
    [{ type: 'jira_fields_set', fields: [] }],
    [{ type: 'azure_pipeline_succeeded' }],
    [{ type: 'pr_merged', extra: 1 }],
    [{ type: 'webhook' }],
  ])('rejects condition %j', (c) => {
    expect(ConditionSchema.safeParse(c).success).toBe(false);
  });

  it('conditions: enabled defaults to true; labels', () => {
    const c = ConditionSchema.parse({ type: 'pr_approvals', min: 2 });
    expect(conditionEnabled(c)).toBe(true);
    expect(conditionEnabled({ ...c, enabled: false })).toBe(false);
    expect(conditionLabel(c)).toBe('PR approvals ≥ 2');
    expect(conditionLabel({ ...c, label: 'Two reviews' })).toBe('Two reviews');
  });

  it('parses update_jira / slack_message actions (the validator refuses them until M5)', () => {
    expect(
      TransitionObjectSchema.safeParse({
        goto: 'x',
        requires: { actions: ['open_pr', 'update_jira', 'slack_message'] },
      }).success,
    ).toBe(true);
    expect(
      TransitionObjectSchema.safeParse({ goto: 'x', requires: { actions: ['deploy'] } }).success,
    ).toBe(false);
  });

  it('rejects empty kinds, an unknown actor and a bad condition_poll', () => {
    expect(TransitionObjectSchema.safeParse({ goto: 'x', kinds: [] }).success).toBe(false);
    expect(TransitionObjectSchema.safeParse({ goto: 'x', actor: 'bot' }).success).toBe(false);
    expect(
      TransitionObjectSchema.safeParse({ goto: 'x', requires: { condition_poll: '0s' } }).success,
    ).toBe(false);
    expect(TicketKindSchema.options).toEqual(['work', 'personal']);
  });
});

describe('parseDuration', () => {
  it.each([
    ['250ms', 250],
    ['90s', 90_000],
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['3d', 259_200_000],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['', '0m', '1.5h', '10', 'm', '-1s', '1w'])('rejects %j', (text) => {
    expect(() => parseDuration(text)).toThrow();
  });
});
