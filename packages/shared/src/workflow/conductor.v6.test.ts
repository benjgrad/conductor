import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';

// ADR-0037 T9: docs/design/workflows/conductor.v6.json is the definition saved as the live
// `conductor` workflow v6 (2026-11-11, change proposal 3185248c). It is the v6 draft without
// `requires.concurrency` (U-120 undecided; a v7 edit adds it back), plus two edits from the
// workflow retrospective: the planner's default policy on `scope_changed` and
// `needs_product_context` (R7), and three reviewer items on `personal_pr_ready_for_review` (R8).

const SCOPE_CHANGED_WHEN =
  "A finding changes what the ticket can deliver, the milestone spec doesn't settle it, and no reasonable default exists. If one does, don't ask: plan your recommended option, list it under an 'Assumptions' heading at the top of the plan, take plan_ready, and put the alternative in proposed_tickets. If the ticket only bundles several tasks ('finish the remaining work'), don't ask: plan the first task and put the rest in proposed_tickets. Before asking whether something already exists, search the repo for it and state what you found.";
const NEEDS_PRODUCT_CONTEXT_WHEN =
  "You need product context that neither the ticket, the repo's docs and ADRs, nor a reasonable default can supply. If a reasonable default exists, plan it, list it under 'Assumptions' at the top of the plan and take plan_ready instead.";
const PERSONAL_PR_REVIEW_ITEMS = [
  'Every functional requirement in the ticket body is met by the diff, or the summary says plainly which one is not and why.',
  "The diff changes nothing the ticket's Out of scope section excludes; extra work is listed as proposed follow-ups instead of committed.",
  'The summary is a hand-off of finished work, not a question for the reviewer: it asks Ben for no decision or information.',
];

type Transition = { when?: string; requires?: Record<string, unknown> };
type Def = {
  states: {
    planning: { on: Record<string, Transition> };
    implementing: { on: Record<string, Transition> };
  };
};

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

  it('is the draft minus requires.concurrency, plus the 2026-11-11 retrospective edits (R7, R8)', () => {
    const draft = read('conductor.v6.draft.json') as Def;
    const { planning, implementing } = draft.states;
    for (const t of ['pr_ready_for_review', 'personal_pr_ready_for_review']) {
      expect(implementing.on[t]?.requires?.concurrency).toBeDefined();
      delete implementing.on[t]?.requires?.concurrency;
    }

    // The draft predates the retrospective edits.
    expect(planning.on.scope_changed?.when).not.toBe(SCOPE_CHANGED_WHEN);
    expect(planning.on.needs_product_context?.when).not.toBe(NEEDS_PRODUCT_CONTEXT_WHEN);
    const personal = implementing.on.personal_pr_ready_for_review?.requires;
    expect(personal?.review).toBeUndefined();

    if (!planning.on.scope_changed || !planning.on.needs_product_context || !personal) {
      throw new Error('the v6 draft lost a transition this test edits');
    }
    planning.on.scope_changed.when = SCOPE_CHANGED_WHEN;
    planning.on.needs_product_context.when = NEEDS_PRODUCT_CONTEXT_WHEN;
    personal.review = { items: PERSONAL_PR_REVIEW_ITEMS };

    expect(saved).toEqual(draft);
  });
});
