import { describe, expect, it } from 'vitest';
import { PROPOSED_TICKETS_KEY } from '../api/proposals.js';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import type { AgentState } from '../workflow/schema.js';
import { AgentStateSchema } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import { SNAPSHOT_FIXTURE } from './fixtures.js';
import {
  FOLLOW_UPS_HEADING,
  HOW_TO_FINISH_HEADING,
  IMPLEMENT_TEMPLATE,
  PROPOSALS_HINT,
  renderPrompt,
  TICKET_TEMPLATE,
} from './render.js';

// ADR-0034: an agent state's `follow_ups` setting (proposals themselves: api/proposals.test.ts).

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
    const def = structuredClone(CONDUCTOR_V4_DEF) as unknown as {
      states: Record<string, Record<string, unknown>>;
    };
    def.states.needs_input!.follow_ups = { enabled: true, max: 3 };
    expect(validateWorkflow(def).ok).toBe(false);
  });

  it('rule 5: a state may not require proposed_tickets', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF) as unknown as {
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
  const ticket: AgentState = { type: 'agent', prompt: TICKET_TEMPLATE };
  const implement: AgentState = { type: 'agent', prompt: IMPLEMENT_TEMPLATE };
  const render = (state: AgentState) =>
    renderPrompt({ stateName: 'impl', state, snapshot: SNAPSHOT_FIXTURE });

  it('unset: no section; the built-in templates keep their one-line hint', () => {
    expect(render(ticket)).not.toContain(FOLLOW_UPS_HEADING);
    expect(render(implement)).not.toContain(FOLLOW_UPS_HEADING);
    expect(render(implement)).toContain(PROPOSALS_HINT);
  });

  it('off: no section and no hint', () => {
    const p = render({ ...implement, follow_ups: { enabled: false, max: 3 } });
    expect(p).not.toContain(FOLLOW_UPS_HEADING);
    expect(p).not.toContain(PROPOSALS_HINT);
    expect(p).not.toContain(PROPOSED_TICKETS_KEY);
  });

  it('on: the section replaces the hint, with the max, the repo and the guidance, before How to finish', () => {
    const p = renderPrompt({
      stateName: 'impl',
      state: { ...implement, follow_ups: { enabled: true, max: 2, guidance: 'Only test debt.' } },
      snapshot: SNAPSHOT_FIXTURE,
      transitions: [{ name: 'done', when: 'Finished.', question: false }],
    });
    expect(p).not.toContain(PROPOSALS_HINT);
    const at = p.indexOf(FOLLOW_UPS_HEADING);
    expect(at).toBeGreaterThan(0);
    expect(p.indexOf(HOW_TO_FINISH_HEADING)).toBeGreaterThan(at);
    expect(p).toContain(`"${PROPOSED_TICKETS_KEY}"`);
    expect(p).toContain(JSON.stringify(SNAPSHOT_FIXTURE.ticket.repo));
    expect(p).toContain('at most 2');
    expect(p).toContain('Only test debt.');
  });

  it('on: a custom prompt gets the section too', () => {
    expect(render({ ...ticket, follow_ups: { enabled: true, max: 3 } })).toContain(
      FOLLOW_UPS_HEADING,
    );
  });
});
