import { describe, expect, it } from 'vitest';
import { PR_CONTEXT_KEY, REVIEW_CONTEXT_KEY, STEP_CONTEXT_KEY } from '../engine/review.js';
import { QA_CONTEXT_KEY } from '../engine/qa.types.js';
import { MACHINE_LOST_CONTEXT_KEY } from '../engine/types.js';
import { WORKING_COPY_CONTEXT_KEY } from '../machines/inventory.js';
import { CONDUCTOR_V1, CONDUCTOR_V2 } from './conductor.js';
import {
  AgentStateSchema,
  AVAILABLE_TRANSITION_ACTIONS,
  OnUnmetSchema,
  RESERVED_CONTEXT_KEYS,
  TransitionActionSchema,
  TransitionObjectSchema,
  TransitionRequiresSchema,
  UNMET_ROUTE_REASONS,
  WorkflowDefinitionSchema,
} from './schema.js';

// M2r-T01 (ADR-0020): the definition fields. Validator rules are M2r-T02's.

const migration = { id: 'migration', label: 'Approve migration', paths: ['**/migrations/**'] };
const qaState = {
  type: 'agent',
  role: 'qa',
  title: 'In QA',
  prompt: 'qa_template',
  tools: ['qa'],
  checkout: { setup: 'pnpm i --frozen-lockfile' },
};

describe('agent state role and checkout', () => {
  it('parses role qa with a checkout setup string, null or absent', () => {
    expect(AgentStateSchema.parse(qaState)).toMatchObject({ role: 'qa' });
    expect(AgentStateSchema.parse({ ...qaState, checkout: { setup: null } }).checkout).toEqual({
      setup: null,
    });
    expect(AgentStateSchema.parse({ ...qaState, checkout: {} }).checkout).toEqual({});
    expect(AgentStateSchema.parse({ type: 'agent', prompt: 'p' })).not.toHaveProperty('role');
  });

  it('refuses another role, an unknown checkout key and a long setup', () => {
    expect(AgentStateSchema.safeParse({ ...qaState, role: 'reviewer' }).success).toBe(false);
    expect(AgentStateSchema.safeParse({ ...qaState, checkout: { sha: 'x' } }).success).toBe(false);
    expect(
      AgentStateSchema.safeParse({ ...qaState, checkout: { setup: 'x'.repeat(2_001) } }).success,
    ).toBe(false);
  });
});

describe('transition text and attach', () => {
  it('accepts attach result and both text values', () => {
    for (const attach of ['output', 'result'] as const) {
      expect(TransitionObjectSchema.parse({ goto: 'implementing', attach }).attach).toBe(attach);
    }
    for (const text of ['required', 'optional'] as const) {
      expect(TransitionObjectSchema.parse({ goto: 'implementing', text }).text).toBe(text);
    }
  });

  it('refuses other values', () => {
    expect(TransitionObjectSchema.safeParse({ goto: 'x', attach: 'reason' }).success).toBe(false);
    expect(TransitionObjectSchema.safeParse({ goto: 'x', text: true }).success).toBe(false);
  });
});

describe('requires.approvals', () => {
  const approvals = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...migration, id: `approval_${i}` }));

  it('accepts 1 to 5 approvals, with optional text', () => {
    expect(TransitionRequiresSchema.parse({ approvals: approvals(1) }).approvals).toHaveLength(1);
    expect(TransitionRequiresSchema.parse({ approvals: approvals(5) }).approvals).toHaveLength(5);
    expect(
      TransitionRequiresSchema.safeParse({ approvals: [{ ...migration, text: 'x'.repeat(500) }] })
        .success,
    ).toBe(true);
    expect(
      TransitionRequiresSchema.safeParse({
        approvals: [{ ...migration, label: 'x'.repeat(60), paths: Array(20).fill('a/**') }],
      }).success,
    ).toBe(true);
  });

  it('refuses the boundary sizes and a non-slug id', () => {
    const bad = [
      { approvals: [] },
      { approvals: approvals(6) },
      { approvals: [{ ...migration, id: 'Migration' }] },
      { approvals: [{ ...migration, id: '1st' }] },
      { approvals: [{ ...migration, id: 'x'.repeat(41) }] },
      { approvals: [{ ...migration, label: 'x'.repeat(61) }] },
      { approvals: [{ ...migration, paths: [] }] },
      { approvals: [{ ...migration, paths: Array(21).fill('a/**') }] },
      { approvals: [{ ...migration, paths: ['x'.repeat(201)] }] },
      { approvals: [{ ...migration, text: 'x'.repeat(501) }] },
      { approvals: [{ ...migration, extra: 1 }] },
    ];
    for (const r of bad)
      expect(TransitionRequiresSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });
});

describe('on_unmet.routes', () => {
  it('maps head_moved and conflict to states', () => {
    expect(UNMET_ROUTE_REASONS).toEqual(['head_moved', 'conflict']);
    expect(
      OnUnmetSchema.parse({ goto: 'implementing', routes: { head_moved: 'in_qa' } }).routes,
    ).toEqual({ head_moved: 'in_qa' });
    expect(OnUnmetSchema.parse({ goto: 'implementing' })).not.toHaveProperty('routes');
  });

  it('refuses an unknown reason or an empty state', () => {
    expect(OnUnmetSchema.safeParse({ goto: 'x', routes: { closed: 'in_qa' } }).success).toBe(false);
    expect(OnUnmetSchema.safeParse({ goto: 'x', routes: { conflict: '' } }).success).toBe(false);
  });
});

describe('actions and reserved keys', () => {
  it('parses the three PR actions, which are not available yet (T02)', () => {
    for (const a of ['inspect_pr', 'merge_pr', 'close_pr'] as const) {
      expect(TransitionActionSchema.parse(a)).toBe(a);
      expect(TransitionRequiresSchema.parse({ actions: [a] }).actions).toEqual([a]);
    }
    expect(AVAILABLE_TRANSITION_ACTIONS).toEqual(['open_pr']);
  });

  it('RESERVED_CONTEXT_KEYS are the engine context keys, __qa included', () => {
    expect([...RESERVED_CONTEXT_KEYS].sort()).toEqual(
      [
        REVIEW_CONTEXT_KEY,
        STEP_CONTEXT_KEY,
        PR_CONTEXT_KEY,
        MACHINE_LOST_CONTEXT_KEY,
        WORKING_COPY_CONTEXT_KEY,
        QA_CONTEXT_KEY,
      ].sort(),
    );
    expect(RESERVED_CONTEXT_KEYS).toContain('__qa');
  });
});

describe('the ADR-0020 v3 sketch parses (shape only)', () => {
  it('in_qa, ready_to_merge and close_without_merging', () => {
    const def = structuredClone(CONDUCTOR_V2) as Record<string, unknown> & {
      states: Record<string, Record<string, unknown>>;
    };
    def.version = 3;
    def.states.in_qa = {
      ...qaState,
      timeout: '40m',
      result: ['verdict', 'summary'],
      on: {
        qa_pass: {
          goto: 'ready_to_merge',
          kinds: ['personal'],
          requires: { actions: ['inspect_pr'] },
          on_unmet: { goto: 'in_qa', retries: 2, else: 'needs_input' },
        },
        qa_fail: { goto: 'implementing', attach: 'result', retries: 3, else: 'needs_input' },
        ask_user: 'needs_input',
        timeout: 'needs_input',
      },
    };
    def.states.ready_to_merge = {
      type: 'human',
      title: 'Ready to merge',
      on: {
        merge: {
          goto: 'done',
          actor: 'human',
          requires: { approvals: [migration], actions: ['merge_pr'] },
          on_unmet: {
            goto: 'implementing',
            retries: 2,
            else: 'needs_input',
            routes: { head_moved: 'in_qa' },
          },
        },
        request_changes: { goto: 'implementing', actor: 'human', text: 'required' },
      },
    };
    def.states.needs_input = {
      type: 'human',
      on: {
        close_without_merging: {
          goto: 'done',
          actor: 'human',
          text: 'required',
          requires: { actions: ['close_pr'] },
          on_unmet: { goto: 'ready_to_merge', retries: 0, else: 'needs_input' },
        },
      },
    };
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('v1 and v2 still parse unchanged (NFR-1)', () => {
    for (const d of [CONDUCTOR_V1, CONDUCTOR_V2]) {
      const parsed = WorkflowDefinitionSchema.parse(d);
      expect(WorkflowDefinitionSchema.parse(parsed)).toEqual(parsed);
    }
  });
});
