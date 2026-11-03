import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requiredCapabilitiesOf } from './capabilities.js';
import { ROUTINE_V1, ROUTINE_V1_DEF, ROUTINE_WORKFLOW_ID } from './routine.js';
import { transitionsOf } from './transition-rules.js';
import { validateWorkflow } from './validate.js';

// ADR-0032: the shipped `routine` workflow of recurring tickets.

const DOC = new URL('../../../../docs/design/workflows/routine.v1.json', import.meta.url);

describe('routine v1 (ADR-0032)', () => {
  it('the code copy equals docs/design/workflows/routine.v1.json', () => {
    // CONDUCTOR_WRITE_WORKFLOW_DOCS=1 rewrites the doc from the code (after an edit).
    if (process.env.CONDUCTOR_WRITE_WORKFLOW_DOCS === '1') {
      writeFileSync(DOC, JSON.stringify(ROUTINE_V1, null, 2) + '\n');
    }
    expect(ROUTINE_V1).toEqual(JSON.parse(readFileSync(DOC, 'utf8')));
  });

  it('passes every validator rule', () => {
    const r = validateWorkflow(ROUTINE_V1);
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(ROUTINE_V1_DEF.id).toBe(ROUTINE_WORKFLOW_ID);
  });

  it('needs only claude on the machine, for either kind', () => {
    expect(requiredCapabilitiesOf(ROUTINE_V1_DEF, 'work')).toEqual(['claude']);
    expect(requiredCapabilitiesOf(ROUTINE_V1_DEF, 'personal')).toEqual(['claude']);
  });

  it('the agent can finish, or escalate to a person with a question', () => {
    expect(ROUTINE_V1_DEF.states.running?.type).toBe('agent');
    const names = transitionsOf(ROUTINE_V1_DEF, 'running').map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['done', 'needs_decision', 'ask_user']));
    expect(ROUTINE_V1_DEF.states.needs_input?.type).toBe('human');
    expect(ROUTINE_V1_DEF.states.done?.type).toBe('terminal');
  });
});
