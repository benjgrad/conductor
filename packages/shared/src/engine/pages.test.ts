import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONDUCTOR_V1,
  CONDUCTOR_V2,
  CONDUCTOR_V3,
  CONDUCTOR_V4,
  CONDUCTOR_V4_DEF,
} from '../workflow/conductor.js';
import {
  AgentStateSchema,
  pagesSpec,
  resultKeys,
  type AgentState,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '../workflow/schema.js';
import { resolveToolPolicy } from '../workflow/tools.js';
import { checkAvailability, validateWorkflow } from '../workflow/validate.js';
import { SNAPSHOT_FIXTURE } from './fixtures.js';
import { IMPLEMENT_TEMPLATE, PAGES_HEADING, PLAN_TEMPLATE, renderPrompt } from './render.js';

// ADR-0038: the `{pages: {max}}` result kind and the `pages` tool (reading pages back:
// api/pages.test.ts).

const base = { type: 'agent', prompt: 'x' } as const;

/** v4 with planning asking for pages and holding the `pages` tool. */
function withPages(): WorkflowDefinition {
  const def = structuredClone(CONDUCTOR_V4_DEF);
  const planning = def.states.planning as AgentState;
  planning.tools = ['read', 'pages'];
  planning.result = ['plan', 'summary', { pages: { max: 3 } }];
  return def;
}

describe('pages result kind and tool: schema', () => {
  it('parses {pages: {max}} next to string keys, max 1..5', () => {
    const s = AgentStateSchema.parse({ ...base, result: ['plan', { pages: { max: 3 } }] });
    expect(resultKeys(s)).toEqual(['plan']);
    expect(pagesSpec(s)).toEqual({ max: 3 });
    for (const max of [0, 6, 1.5]) {
      expect(AgentStateSchema.safeParse({ ...base, result: [{ pages: { max } }] }).success).toBe(
        false,
      );
    }
  });

  it('refuses two pages entries and unknown keys', () => {
    expect(
      AgentStateSchema.safeParse({
        ...base,
        result: [{ pages: { max: 1 } }, { pages: { max: 2 } }],
      }).success,
    ).toBe(false);
    expect(
      AgentStateSchema.safeParse({ ...base, result: [{ pages: { max: 1, x: 1 } }] }).success,
    ).toBe(false);
    expect(AgentStateSchema.safeParse({ ...base, result: [{ other: {} }] }).success).toBe(false);
  });

  it('a state without one has no pages spec', () => {
    expect(pagesSpec({ result: ['plan'] })).toBeNull();
    expect(pagesSpec({})).toBeNull();
  });

  it('the pages tool alias resolves to no built-ins', () => {
    expect(resolveToolPolicy(['read', 'pages'])).toEqual(resolveToolPolicy(['read']));
  });
});

describe('pages: validator', () => {
  it('accepts a definition using both', () => {
    expect(validateWorkflow(withPages()).ok).toBe(true);
  });

  it('rule 14 refuses both while not available yet', () => {
    const errors = checkAvailability(withPages(), {
      tools: ['read', 'edit', 'bash', 'git'],
      resultKinds: [],
    });
    expect(errors).toEqual([
      expect.objectContaining({ rule: 14, path: ['states', 'planning', 'tools', 1] }),
      expect.objectContaining({ rule: 14, path: ['states', 'planning', 'result', 2] }),
    ]);
    expect(
      checkAvailability(withPages(), {
        tools: ['read', 'edit', 'bash', 'git', 'pages'],
        resultKinds: ['pages'],
      }),
    ).toEqual([]);
  });

  it('rule 5: "pages" is never a required string key', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF);
    (def.states.planning as AgentState).result = ['plan', 'summary', 'pages'];
    const res = validateWorkflow(def);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContainEqual(
        expect.objectContaining({ rule: 5, path: ['states', 'planning', 'result', 2] }),
      );
    }
  });

  it('v1–v5 are unchanged: they parse as before, and v4/v5 still validate', () => {
    const v5 = JSON.parse(
      readFileSync(new URL('./fixtures/conductor.v5.live.json', import.meta.url), 'utf8'),
    ) as unknown;
    for (const def of [CONDUCTOR_V4, v5]) {
      const res = validateWorkflow(def);
      expect(res.ok ? [] : res.errors).toEqual([]);
    }
    for (const def of [CONDUCTOR_V1, CONDUCTOR_V2, CONDUCTOR_V3, CONDUCTOR_V4, v5]) {
      const parsed = WorkflowDefinitionSchema.parse(def);
      for (const s of Object.values(parsed.states)) {
        if (s.type === 'agent') {
          expect(pagesSpec(s)).toBeNull();
          expect(resultKeys(s)).toEqual(s.result ?? []);
        }
      }
    }
  });
});

describe('renderPrompt pages section', () => {
  const render = (state: AgentState) =>
    renderPrompt({ stateName: 'planning', state, snapshot: SNAPSHOT_FIXTURE });

  it('absent without a pages result entry (v1–v4 prompts unchanged)', () => {
    expect(render({ type: 'agent', prompt: PLAN_TEMPLATE, result: ['plan'] })).not.toContain(
      PAGES_HEADING,
    );
    expect(render({ type: 'agent', prompt: IMPLEMENT_TEMPLATE })).not.toContain(PAGES_HEADING);
    // A state with the tool but no result entry can't attach pages, so it isn't told how.
    expect(render({ type: 'agent', prompt: PLAN_TEMPLATE, tools: ['pages'] })).not.toContain(
      PAGES_HEADING,
    );
  });

  it('tells how to attach, and how to publish only with the tool', () => {
    const attach = render({
      type: 'agent',
      prompt: PLAN_TEMPLATE,
      result: ['plan', { pages: { max: 2 } }],
    });
    expect(attach).toContain(PAGES_HEADING);
    expect(attach).toContain('at most 2');
    expect(attach).not.toContain('publish_page');
    const publish = render({
      type: 'agent',
      prompt: PLAN_TEMPLATE,
      tools: ['read', 'pages'],
      result: ['plan', { pages: { max: 2 } }],
    });
    expect(publish).toContain('publish_page');
    // The pages section sits before "How to finish"; the result keys list only `plan`.
    expect(publish).toContain('a `result` object containing `plan`, then stop.');
  });
});
