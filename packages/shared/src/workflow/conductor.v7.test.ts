import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deadlineFor } from '../engine/apply.js';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';

// Ticket "Improved handoff": docs/design/workflows/conductor.v7.json is v6 without the timeouts
// that stopped a ticket with a technical message: the agent step timeouts (Planning 60m,
// Implementing 2h, and their `on.timeout` edges) and Needs input's 2h escalation watch. The
// budget, a lost machine or the agent's own exit still bound a stuck agent; the PR
// `condition_timeout`s stay (the validator requires them). The v7 bases draft drops the same.

type Raw = {
  version: number;
  states: Record<
    string,
    { type: string; timeout?: string; on?: Record<string, unknown> } & Record<string, unknown>
  >;
};

const read = (name: string): Raw =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  ) as Raw;
const v7 = read('conductor.v7.json');

describe('conductor v7 (no step timeouts, no needs-input escalation)', () => {
  it('parses and passes every rule with no options (as the save path checks it)', () => {
    expect(WorkflowDefinitionSchema.safeParse(v7).error).toBeUndefined();
    const res = validateWorkflow(v7);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('is v6 minus exactly the agent timeouts and the needs_input watch', () => {
    const v6 = read('conductor.v6.json');
    v6.version = 7;
    for (const s of ['planning', 'implementing']) {
      expect(v6.states[s]!.timeout).toBeDefined();
      delete v6.states[s]!.timeout;
      delete v6.states[s]!.on!.timeout;
    }
    expect(v6.states.needs_input!.watch).toBeDefined();
    delete v6.states.needs_input!.watch;
    expect(v7).toEqual(v6);
  });

  it.each([
    ['conductor.v7.json', v7],
    ['conductor.v7.draft.json', read('conductor.v7.draft.json')],
  ])('%s: no agent state times out and nothing escalates an open question', (_n, raw) => {
    const def = WorkflowDefinitionSchema.parse(raw);
    for (const [name, state] of Object.entries(def.states)) {
      if (state.type !== 'agent') continue;
      expect(state.timeout, name).toBeUndefined();
      expect(state.on?.timeout, name).toBeUndefined();
      // No timeout: entering the state arms no deadline, so no timer ever fires.
      expect(deadlineFor(state, new Date()), name).toBeNull();
    }
    expect('watch' in def.states.needs_input!).toBe(false);
  });
});
