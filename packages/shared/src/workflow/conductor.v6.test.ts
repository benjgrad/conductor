import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';

// ADR-0037 T9: docs/design/workflows/conductor.v6.json is the definition saved as the live
// `conductor` workflow v6. It is the v6 draft without `requires.concurrency` (T7 not available,
// U-120 undecided); a v7 edit adds concurrency back once both land.

const read = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
const saved = read('conductor.v6.json');

describe('conductor v6 (saved, ADR-0037 T9)', () => {
  it('parses with WorkflowDefinitionSchema', () => {
    expect(WorkflowDefinitionSchema.safeParse(saved).error).toBeUndefined();
  });

  it('passes every rule with no options (as the save path checks it)', () => {
    const res = validateWorkflow(saved);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('is the draft minus requires.concurrency on both PR-ready transitions', () => {
    const draft = read('conductor.v6.draft.json') as {
      states: { implementing: { on: Record<string, { requires?: Record<string, unknown> }> } };
    };
    for (const t of ['pr_ready_for_review', 'personal_pr_ready_for_review']) {
      expect(draft.states.implementing.on[t]?.requires?.concurrency).toBeDefined();
      delete draft.states.implementing.on[t]?.requires?.concurrency;
    }
    expect(saved).toEqual(draft);
  });
});
