import { describe, expect, it } from 'vitest';
import { CapabilityRequirementSchema, isCapabilityRequirement } from '../machines/capabilities.js';
import { requiredCapabilities } from '../machines/required.js';
import {
  ACTION_CAPABILITIES,
  CONDITION_CAPABILITIES,
  requiredCapabilitiesOf,
} from './capabilities.js';
import { CONDUCTOR_V2, CONDUCTOR_V2_DEF } from './conductor.js';
import {
  CONDITION_TYPES,
  TransitionActionSchema,
  WorkflowDefinitionSchema,
  type Condition,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from './schema.js';

// M2-T06: the capability registry and requiredCapabilities (ADR-0013 §Routing, ADR-0016).

/** conductor v2 with extra transitions out of `implementing`. */
function v2With(on: Record<string, unknown>): WorkflowDefinition {
  const input = structuredClone(CONDUCTOR_V2) as WorkflowDefinitionInput & {
    states: Record<string, { on?: Record<string, unknown> }>;
  };
  const impl = input.states.implementing!;
  impl.on = { ...impl.on, ...on };
  return WorkflowDefinitionSchema.parse(input);
}

const onUnmet = { goto: 'implementing', retries: 1, else: 'needs_input' };

function withCondition(c: Condition, kinds?: ('work' | 'personal')[]): WorkflowDefinition {
  return v2With({
    ship_it: {
      goto: 'waiting_external',
      ...(kinds !== undefined ? { kinds } : {}),
      requires: { conditions: [c], condition_timeout: '1d' },
      on_unmet: onUnmet,
    },
  });
}

describe('requiredCapabilities (M2-T06)', () => {
  it('conductor v2 for work needs cli:gh:authed and claude (Jira / Azure are disabled)', () => {
    expect(requiredCapabilities(CONDUCTOR_V2_DEF, 'work')).toEqual(['claude', 'cli:gh:authed']);
    expect(requiredCapabilities(CONDUCTOR_V2_DEF, 'personal')).toEqual(['claude', 'cli:gh:authed']);
    expect(requiredCapabilities(CONDUCTOR_V2_DEF, null)).toEqual(['claude', 'cli:gh:authed']);
  });

  it('an enabled azure_pipeline_succeeded adds cli:az:authed; a disabled one does not', () => {
    const enabled = withCondition({ type: 'azure_pipeline_succeeded', pipeline: 'ci' });
    expect(requiredCapabilities(enabled, 'work')).toEqual([
      'claude',
      'cli:az:authed',
      'cli:gh:authed',
    ]);
    const disabled = withCondition({
      type: 'azure_pipeline_succeeded',
      pipeline: 'ci',
      enabled: false,
    });
    expect(requiredCapabilities(disabled, 'work')).toEqual(['claude', 'cli:gh:authed']);
  });

  it("a personal-only transition's needs don't appear for work", () => {
    const def = v2With({
      tell_slack: {
        goto: 'needs_input',
        kinds: ['personal'],
        requires: { actions: ['slack_message'] },
        on_unmet: onUnmet,
      },
    });
    expect(requiredCapabilities(def, 'work')).toEqual(['claude', 'cli:gh:authed']);
    expect(requiredCapabilities(def, 'personal')).toEqual(['claude', 'cli:gh:authed', 'mcp:slack']);
    // A null kind matches both (U-062).
    expect(requiredCapabilities(def, null)).toContain('mcp:slack');
    const jira = withCondition({ type: 'jira_fields_set', fields: ['resolution'] }, ['personal']);
    expect(requiredCapabilities(jira, 'work')).not.toContain('cli:jira:authed');
    expect(requiredCapabilities(jira, 'personal')).toContain('cli:jira:authed');
  });

  it('a workflow without agents or capabilities needs nothing; entry actions count', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'cmd',
      version: 1,
      start: 'build',
      budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
      on_budget_exceeded: 'ask',
      states: {
        build: { type: 'command', cmd: 'make', on: { exit_0: 'done', fail: 'ask' } },
        ask: { type: 'human', on: { retry: 'build' } },
        done: {
          type: 'terminal',
          entry: { actions: ['open_pr'], on_unmet: { goto: 'build', retries: 1, else: 'ask' } },
        },
      },
    });
    expect(requiredCapabilitiesOf(def, 'work')).toEqual(['cli:gh:authed']);
    const bare = WorkflowDefinitionSchema.parse({
      ...def,
      states: { ...def.states, done: { type: 'terminal' } },
    });
    expect(requiredCapabilitiesOf(bare, null)).toEqual([]);
  });

  it('the registry covers every condition and action; every key is a valid requirement', () => {
    expect(Object.keys(CONDITION_CAPABILITIES).sort()).toEqual([...CONDITION_TYPES].sort());
    expect(Object.keys(ACTION_CAPABILITIES).sort()).toEqual(
      [...TransitionActionSchema.options].sort(),
    );
    for (const key of [
      ...Object.values(CONDITION_CAPABILITIES),
      ...Object.values(ACTION_CAPABILITIES),
      'claude',
    ]) {
      expect(CapabilityRequirementSchema.safeParse(key).success, key).toBe(true);
    }
  });
});

describe('CapabilityRequirementSchema: the key grammar (TD-114)', () => {
  it('accepts every key form of the 10-contracts table', () => {
    for (const ok of [
      'claude',
      'cli:gh',
      'cli:gh:authed',
      'mcp:slack',
      'skill:review',
      'agent:planner',
      'skill:deploy@github.com/benjgrad/fixture-app',
      'agent:implementer@github.com/benjgrad/conductor',
      'skill:x@dev.azure.com/org/proj/repo',
    ]) {
      expect(isCapabilityRequirement(ok), ok).toBe(true);
      expect(CapabilityRequirementSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'claude:2',
      'gpu:x',
      'cli:',
      'cli:a:b:c',
      'cli:gh:foo',
      'cli:gh:authed:x',
      'mcp:a:b',
      'mcp:',
      'skill:',
      'skill:x@',
      'skill:x@https://github.com/o/r',
      'skill:x@github.com/o/r.git',
      'agent:a b',
      'cli:g@h',
    ]) {
      expect(CapabilityRequirementSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
