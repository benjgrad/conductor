import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDuration, WorkflowDefinitionSchema } from './schema.js';

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
