import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF, CONDUCTOR_V5_DEF } from '../workflow/conductor.js';
import type { AgentState, WorkflowDefinition } from '../workflow/schema.js';
import { AgentStateSchema } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { Harness } from './apply.testkit.js';
import { SNAPSHOT_FIXTURE } from './fixtures.js';
import {
  FOLLOW_UPS_HEADING,
  followUpsOf,
  parseProposedTickets,
  PROPOSED_TICKETS_KEY,
  withoutProposals,
} from './proposals.js';
import { HOW_TO_FINISH_HEADING, renderPrompt, TICKET_TEMPLATE } from './render.js';
import type { JsonObject } from '../domain.js';

// ADR-0034: follow-up ticket proposals in an agent's `complete_state` result.

const item = (title: string, extra: JsonObject = {}): JsonObject => ({
  title,
  body: 'b',
  ...extra,
});

describe('parseProposedTickets', () => {
  it('reads valid items, trims titles, defaults the body', () => {
    const r = parseProposedTickets(
      { [PROPOSED_TICKETS_KEY]: [{ title: '  Add docs ' }, item('Fix lint', { kind: 'work' })] },
      { max: 3 },
    );
    expect(r).toEqual({
      proposals: [
        { title: 'Add docs', body: '' },
        { title: 'Fix lint', body: 'b', kind: 'work' },
      ],
      dropped: 0,
    });
  });

  it('drops malformed items and repeated titles, and caps at max', () => {
    const r = parseProposedTickets(
      {
        [PROPOSED_TICKETS_KEY]: [
          'not an object',
          { title: '' },
          item('A', { kind: 'bogus' }),
          item('One'),
          item('one'),
          item('Two'),
          item('Three'),
        ],
      },
      { max: 2 },
    );
    expect(r.proposals.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(r.dropped).toBe(5);
  });

  it('a missing key is no proposals; a non-array counts as one dropped', () => {
    expect(parseProposedTickets({}, { max: 3 })).toEqual({ proposals: [], dropped: 0 });
    expect(parseProposedTickets({ [PROPOSED_TICKETS_KEY]: 'x' }, { max: 3 })).toEqual({
      proposals: [],
      dropped: 1,
    });
  });

  it('withoutProposals strips only the key', () => {
    const r = { plan: 'p', [PROPOSED_TICKETS_KEY]: [] };
    expect(withoutProposals(r)).toEqual({ plan: 'p' });
    const same = { plan: 'p' };
    expect(withoutProposals(same)).toBe(same);
  });

  it('followUpsOf: only an enabled config', () => {
    expect(followUpsOf(undefined)).toBeNull();
    expect(followUpsOf({ follow_ups: { enabled: false, max: 3 } })).toBeNull();
    expect(followUpsOf({ follow_ups: { enabled: true, max: 2 } })).toEqual({
      enabled: true,
      max: 2,
    });
  });
});

describe('follow_ups schema and validator', () => {
  it('parses on an agent state with max defaulting to 3, bounded 1..10', () => {
    const base = { type: 'agent', prompt: 'x' };
    expect(AgentStateSchema.parse({ ...base, follow_ups: { enabled: true } }).follow_ups).toEqual({
      enabled: true,
      max: 3,
    });
    expect(
      AgentStateSchema.safeParse({ ...base, follow_ups: { enabled: true, max: 11 } }).success,
    ).toBe(false);
    expect(
      AgentStateSchema.safeParse({ ...base, follow_ups: { enabled: true, x: 1 } }).success,
    ).toBe(false);
  });

  it('is refused on a non-agent state', () => {
    const def = structuredClone(CONDUCTOR_V5_DEF) as unknown as {
      states: Record<string, Record<string, unknown>>;
    };
    def.states.needs_input!.follow_ups = { enabled: true, max: 3 };
    expect(validateWorkflow(def).ok).toBe(false);
  });

  it('rule 5: a state may not require proposed_tickets', () => {
    const def = structuredClone(CONDUCTOR_V5_DEF) as unknown as {
      states: Record<string, { result?: string[] }>;
    };
    def.states.planning!.result = ['plan', 'summary', PROPOSED_TICKETS_KEY];
    const res = validateWorkflow(def);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContainEqual(
        expect.objectContaining({ rule: 5, path: ['states', 'planning', 'result', 2] }),
      );
    }
  });
});

describe('renderPrompt follow-up section', () => {
  const state: AgentState = { type: 'agent', prompt: TICKET_TEMPLATE };

  it('absent unless follow_ups is enabled', () => {
    const off = renderPrompt({ stateName: 'impl', state, snapshot: SNAPSHOT_FIXTURE });
    expect(off).not.toContain(FOLLOW_UPS_HEADING);
    const disabled = renderPrompt({
      stateName: 'impl',
      state: { ...state, follow_ups: { enabled: false, max: 3 } },
      snapshot: SNAPSHOT_FIXTURE,
    });
    expect(disabled).not.toContain(FOLLOW_UPS_HEADING);
  });

  it('names the key, the max and the guidance, before How to finish', () => {
    const p = renderPrompt({
      stateName: 'impl',
      state: { ...state, follow_ups: { enabled: true, max: 2, guidance: 'Only test debt.' } },
      snapshot: SNAPSHOT_FIXTURE,
      transitions: [{ name: 'done', when: 'Finished.', question: false }],
    });
    const at = p.indexOf(FOLLOW_UPS_HEADING);
    expect(at).toBeGreaterThan(0);
    expect(p.indexOf(HOW_TO_FINISH_HEADING)).toBeGreaterThan(at);
    expect(p).toContain(`"${PROPOSED_TICKETS_KEY}"`);
    expect(p).toContain('at most 2');
    expect(p).toContain('Only test debt.');
    expect(p).toContain('A human confirms each one');
  });
});

describe('apply: ticket_proposals effect', () => {
  /** v5 with follow-ups on in Planning too, so its transitions can be exercised. */
  const def = (on: boolean): WorkflowDefinition => {
    const d = structuredClone(on ? CONDUCTOR_V5_DEF : CONDUCTOR_V4_DEF);
    const planning = d.states.planning as AgentState;
    if (on) planning.follow_ups = { enabled: true, max: 2 };
    return d;
  };
  const proposals = [item('Docs'), item('Lint'), item('Third')];

  const complete = (d: WorkflowDefinition, transition: string, result: JsonObject) => {
    const h = new Harness(d).claimAndStart();
    const r = h.run({ type: 'agent.complete_state', transition, result });
    return { h, r, effect: r.effects.find((e) => e.type === 'ticket_proposals') };
  };

  it('a normal transition: capped proposals, and context.<state> without the key', () => {
    const { h, effect } = complete(def(true), 'plan_ready', {
      plan: 'p',
      summary: 's',
      [PROPOSED_TICKETS_KEY]: proposals,
    });
    expect(effect).toEqual({
      type: 'ticket_proposals',
      state: 'planning',
      proposals: [
        { title: 'Docs', body: 'b' },
        { title: 'Lint', body: 'b' },
      ],
    });
    expect(h.snap.context.planning).toEqual({ plan: 'p', summary: 's' });
    expect(h.snap.workflow_state).toBe('implementing');
  });

  it('a question transition and ask_user record them too', () => {
    for (const t of ['plan_needs_approval', 'ask_user']) {
      const { effect, h } = complete(def(true), t, {
        plan: 'p',
        [PROPOSED_TICKETS_KEY]: proposals,
      });
      expect(effect, t).toBeDefined();
      expect(h.snap.workflow_state, t).toBe('needs_input');
      if (h.snap.context.planning !== undefined) {
        expect(h.snap.context.planning).not.toHaveProperty(PROPOSED_TICKETS_KEY);
      }
    }
  });

  it('a result missing its keys still records them', () => {
    const { effect } = complete(def(true), 'plan_ready', { [PROPOSED_TICKETS_KEY]: proposals });
    expect(effect).toBeDefined();
  });

  it('off: no effect, and the result is stored untouched', () => {
    const { effect, h } = complete(def(false), 'plan_ready', {
      plan: 'p',
      summary: 's',
      [PROPOSED_TICKETS_KEY]: proposals,
    });
    expect(effect).toBeUndefined();
    expect(h.snap.context.planning).toHaveProperty(PROPOSED_TICKETS_KEY);
  });

  it('on, with nothing proposed: no effect', () => {
    const { effect } = complete(def(true), 'plan_ready', { plan: 'p', summary: 's' });
    expect(effect).toBeUndefined();
  });
});
