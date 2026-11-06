/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- raw definition edits in tests */
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT } from '../workflow/fixtures.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { freshSnapshot, Harness } from './apply.testkit.js';
import { moveStateLabel, type Effect } from './types.js';

// ADR-0037 P8 (T3): a `handoff: true` transition behaves like `question: true` (result kept,
// `return_to` set, no result-key check), but opens an input_request of kind `handoff`.

const WORKER = 'c1a0de00-0000-4000-8000-00000000000b';
const PR = 'https://github.com/benjgrad/fixture-app/pull/8';

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

/** conductor v2 (draft) with plan_needs_approval and pr_ready_for_review as hand-offs. */
function handoffDef(): WorkflowDefinition {
  const raw = structuredClone(CONDUCTOR_V2_DRAFT) as Record<string, any>;
  for (const [state, name] of [
    ['planning', 'plan_needs_approval'],
    ['implementing', 'pr_ready_for_review'],
  ] as const) {
    const t: Record<string, any> = raw.states[state].on[name];
    delete t.question;
    t.handoff = true;
  }
  const def = WorkflowDefinitionSchema.parse(raw);
  // The v2 draft has unrelated findings of its own: the hand-offs add none (rules 14, 22).
  const errs = (d: WorkflowDefinition) => {
    const v = validateWorkflow(d);
    return v.ok ? [] : v.errors;
  };
  expect(errs(def)).toEqual(errs(WorkflowDefinitionSchema.parse(CONDUCTOR_V2_DRAFT)));
  return def;
}

function planning(def: WorkflowDefinition): Harness {
  const snap = freshSnapshot(def);
  snap.ticket = { ...snap.ticket, kind: 'work' };
  const h = new Harness(def, snap).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
  return h;
}

const take = (
  h: Harness,
  transition: string,
  reason: string | null,
  result: Record<string, string> = {},
) => h.run({ type: 'agent.complete_state', result, transition, reason });

describe('handoff: true (ADR-0037 P8)', () => {
  it('opens a handoff request with the reason, keeps the result, sets return_to', () => {
    const h = planning(handoffDef());
    // `plan` alone: a hand-off's result keys are not checked (`summary` is missing).
    const r = take(h, 'plan_needs_approval', 'Here is the plan.', { plan: '1. add /health' });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'planning',
    });
    expect((r.snapshot.context as Record<string, unknown>).planning).toEqual({
      plan: '1. add /health',
    });
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'handoff',
      question: 'Here is the plan.',
    });
  });

  it('an empty reason gets the hand-off stand-in', () => {
    const r = take(planning(handoffDef()), 'plan_needs_approval', '  ');
    expect(find(r.effects, 'create_input_request')?.question).toBe(
      'The agent handed off "Plan needs approval" without a summary.',
    );
  });

  it('with requires: the move step runs, then the target opens a handoff request', () => {
    const h = planning(handoffDef());
    take(h, 'plan_ready', 'ok', { plan: 'P', summary: 's' });
    expect(h.snap.workflow_state).toBe('implementing');
    h.started();
    const label = moveStateLabel('implementing', 'needs_input', 'pr_ready_for_review');
    let r = take(h, 'pr_ready_for_review', 'Added /health. Look at the route first.');
    expect(r.snapshot).toMatchObject({ workflow_state: label, step: { kind: 'move' } });
    expect(find(r.effects, 'create_input_request')).toBeUndefined();
    h.cmdExit(0);
    r = h.run({
      type: 'action.completed',
      command_id: h.newId(),
      action: 'open_pr',
      result: { pr_url: PR },
      error: null,
    });
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', return_to: 'implementing' });
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'handoff',
      question: 'Added /health. Look at the route first.',
    });
  });

  it('question: true is unchanged: still an agent_question', () => {
    const def = WorkflowDefinitionSchema.parse(structuredClone(CONDUCTOR_V2_DRAFT));
    const r = take(planning(def), 'plan_needs_approval', 'Approve?', { plan: 'P' });
    expect(find(r.effects, 'create_input_request')?.kind).toBe('agent_question');
  });
});
