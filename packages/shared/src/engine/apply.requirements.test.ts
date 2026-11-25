import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '../workflow/schema.js';
import { Harness, referenceWorkflow } from './apply.testkit.js';
import {
  REQUIREMENTS_CONTEXT_KEY,
  REQUIREMENTS_FIXED_INSTRUCTION,
  requirementsOfContext,
} from './requirements.js';
import { reviewStateLabel } from './review.js';
import { GateStepSchema, type Effect } from './types.js';

// ADR-0045: the ticket's requirements checklist in apply (apply.ts §requirements).

const GATE = ['New code paths have unit tests', 'No TODO comments in changed files'];
const REQS = ['GET /health returns 200', 'The README documents /health'];
const LABEL = reviewStateLabel('implement', 'done');
const ACTOR = 'ui';

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

/** m1_reviewed with a `plan` (plan_template) state first and its gate going straight to done. */
function planned(): WorkflowDefinition {
  const raw = structuredClone(referenceWorkflow('m1_reviewed')) as unknown as {
    start: string;
    states: Record<string, Record<string, unknown>>;
  };
  raw.start = 'plan';
  raw.states.plan = {
    type: 'agent',
    prompt: 'plan_template',
    tools: ['read'],
    result: ['plan'],
    on: {
      done: 'implement',
      ask_user: 'needs_input',
      plan_needs_approval: { goto: 'needs_input', question: true },
    },
  };
  const on = raw.states.implement!.on as Record<string, { goto: string }>;
  on.done!.goto = 'done';
  return WorkflowDefinitionSchema.parse(raw);
}

const reqsOf = (h: Harness) => requirementsOfContext(h.snap.context);

/** Planned with REQS and running in implement. */
function implementing(): Harness {
  const h = new Harness(planned()).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: { plan: 'do it', requirements: [...REQS, '  ', REQS[0]!.toUpperCase()] },
  });
  h.started();
  return h;
}

describe('planning sets the checklist', () => {
  it('stores the parsed list, every item pending, and the next prompt lists it as fixed', () => {
    const h = new Harness(planned()).claimAndStart();
    const r = h.run({
      type: 'agent.complete_state',
      result: { plan: 'do it', requirements: [...REQS, '  ', REQS[0]!.toUpperCase()] },
    });
    expect(r.ignored).toBeNull();
    expect(reqsOf(h)).toEqual({
      items: REQS.map((text) => ({ text, status: 'pending', reason: null, checked_in: null })),
      set_by: 'agent',
      set_in: 'plan',
      revision: 1,
      proposed: null,
      ignored: null,
    });
    const prompt = find(r.effects, 'start_session')!.prompt;
    expect(prompt).toContain('1. [ ] not checked yet: GET /health returns 200');
    expect(prompt).toContain(REQUIREMENTS_FIXED_INSTRUCTION);
  });

  it('a question from planning (plan_needs_approval) keeps its list too', () => {
    const h = new Harness(planned()).claimAndStart();
    h.run({
      type: 'agent.complete_state',
      transition: 'plan_needs_approval',
      reason: 'approve?',
      result: { plan: 'do it', requirements: REQS },
    });
    expect(reqsOf(h)?.items.map((i) => i.text)).toEqual(REQS);
  });

  it('a result without a usable list leaves none', () => {
    const h = new Harness(planned()).claimAndStart();
    h.run({ type: 'agent.complete_state', result: { plan: 'do it', requirements: 'no' } });
    expect(h.snap.context[REQUIREMENTS_CONTEXT_KEY]).toBeUndefined();
  });
});

describe('after planning an agent can only propose a change', () => {
  it('a changed list on a non-question transition is ignored (and recorded as such)', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      transition: 'done',
      result: { summary: 'x', requirements: ['Something easier'] },
    });
    const reqs = requirementsOfContext(h.snap.context)!;
    expect(reqs.items.map((i) => i.text)).toEqual(REQS);
    expect(reqs.proposed).toBeNull();
    expect(reqs.ignored).toEqual({
      items: ['Something easier'],
      from_state: 'implement',
      revision_of: 1,
    });
  });

  it('ask_user with proposed_requirements opens a proposal and leaves the list alone', () => {
    const h = implementing();
    const r = h.run({
      type: 'agent.complete_state',
      transition: 'ask_user',
      reason: 'The README item is out of scope; drop it?',
      result: { proposed_requirements: [REQS[0]!] },
    });
    expect(r.snapshot.workflow_state).toBe('needs_input');
    const reqs = reqsOf(h)!;
    expect(reqs.items.map((i) => i.text)).toEqual(REQS);
    expect(reqs.proposed).toEqual({ items: [REQS[0]], from_state: 'implement', revision_of: 1 });
    // A human applies it.
    const applied = h.run({ type: 'human.requirements', apply_proposal: true, actor: ACTOR });
    expect(applied.ignored).toBeNull();
    expect(applied.effects).toEqual([]);
    expect(reqsOf(h)).toMatchObject({
      items: [{ text: REQS[0], status: 'pending' }],
      set_by: 'human',
      set_in: ACTOR,
      revision: 2,
      proposed: null,
    });
  });

  it('the same list is no proposal', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      transition: 'ask_user',
      reason: 'q',
      result: { proposed_requirements: REQS },
    });
    expect(reqsOf(h)?.proposed).toBeNull();
  });
});

describe('a review checks the requirements off', () => {
  it('asks the gate items and the requirements, then records the verdict per item', () => {
    const h = implementing();
    const r = h.complete({ summary: 'added /health' });
    expect(r.snapshot.step?.requirements).toEqual(REQS);
    h.started();
    const start = find(r.effects, 'start_session')!;
    for (const item of [...GATE, ...REQS]) expect(start.prompt).toContain(item);
    // An edit while the reviewer runs is refused.
    expect(h.run({ type: 'human.requirements', items: ['x'], actor: ACTOR }).ignored).toBe(
      'wrong_status',
    );
    const v = h.run({
      type: 'agent.complete_state',
      result: {
        verdict: [
          ...GATE.map((item) => ({ item, met: true, reason: 'ok' })),
          { item: REQS[0]!, met: true, reason: 'test in health.test.ts' },
          { item: REQS[1]!, met: false, reason: 'README unchanged' },
        ],
      },
    });
    expect(v.snapshot.workflow_state).toBe('implement');
    expect(reqsOf(h)?.items).toEqual([
      { text: REQS[0], status: 'met', reason: 'test in health.test.ts', checked_in: LABEL },
      { text: REQS[1], status: 'unmet', reason: 'README unchanged', checked_in: LABEL },
    ]);
    // The unmet requirement goes back to the worker as feedback.
    expect(find(v.effects, 'start_session')?.prompt).toContain(
      'The README documents /health: README unchanged',
    );
  });

  it('without a list the review asks only the gate items', () => {
    const h = new Harness(planned()).claimAndStart();
    h.run({ type: 'agent.complete_state', result: { plan: 'p' } });
    h.started();
    const r = h.complete({ summary: 's' });
    expect(r.snapshot.step?.requirements).toEqual([]);
    expect(find(r.effects, 'start_session')!.prompt).not.toContain(REQS[0]);
  });

  it('an older step without requirements parses', () => {
    const h = implementing();
    h.complete({ summary: 's' });
    const old = structuredClone(h.snap.step) as Record<string, unknown>;
    delete old.requirements;
    expect(GateStepSchema.parse(old).requirements).toEqual([]);
  });
});

describe('human.requirements', () => {
  it('sets the list, keeps statuses of unchanged items and tells a live agent', () => {
    const h = implementing();
    expect(h.snap.agent_process_live).toBe(true);
    const r = h.run({
      type: 'human.requirements',
      items: [REQS[0]!, 'Docs mention the port'],
      actor: ACTOR,
    });
    expect(r.ignored).toBeNull();
    expect(reqsOf(h)?.items.map((i) => i.text)).toEqual([REQS[0], 'Docs mention the port']);
    expect(find(r.effects, 'send_message')?.text).toContain(
      '2. [ ] not checked yet: Docs mention the port',
    );
    expect(r.snapshot.workflow_state).toBe('implement');
  });

  it('refuses an empty list and an apply with nothing proposed', () => {
    const h = implementing();
    expect(h.run({ type: 'human.requirements', items: [' '], actor: ACTOR }).ignored).toBe(
      'invalid_requirements',
    );
    expect(h.run({ type: 'human.requirements', apply_proposal: true, actor: ACTOR }).ignored).toBe(
      'invalid_requirements',
    );
  });
});
