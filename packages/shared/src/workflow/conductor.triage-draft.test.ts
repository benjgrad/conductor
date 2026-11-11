import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';
import { triageLegs, triageSources } from './validate-triage.js';

// ADR-0043 (FR-4): docs/design/workflows/conductor.triage.draft.json is the live conductor v6 plus
// the triage role: each PR gate retries once straight back to Implementing, then goes to Triage,
// whose verdicts are send_back ($return_to), rerun ($gate), fix_env (a command leg that reruns the
// gate) and escalate (Needs input). A draft only: never saved live by this ticket.

const read = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
const draft = read('conductor.triage.draft.json');
const v6 = read('conductor.v6.json');
const GATES = ['ready_for_testing', 'pr_ready_for_review', 'personal_pr_ready_for_review'];

type States = Record<string, { on?: Record<string, { on_unmet?: unknown }> }>;

describe('conductor triage draft (ADR-0043 FR-4)', () => {
  it('passes every rule as is (the triage role needs no unavailable feature)', () => {
    const res = validateWorkflow(draft);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('is v6 plus exactly the triage states, their columns and the three gates’ else', () => {
    const lowered = structuredClone(draft) as Record<string, unknown> & { states: States };
    const base = structuredClone(v6) as Record<string, unknown> & { states: States };
    expect(Object.keys(lowered.states).filter((n) => !(n in base.states))).toEqual([
      'triage',
      'fix_env',
    ]);
    delete lowered.states.triage;
    delete lowered.states.fix_env;
    lowered.columns = (lowered.columns as string[]).filter(
      (c) => c !== 'triage' && c !== 'fix_env',
    );
    for (const g of GATES) {
      expect(lowered.states.implementing!.on![g]!.on_unmet as Record<string, unknown>).toEqual({
        goto: 'implementing',
        instruction: '$instructions.fix_and_resubmit',
        retries: 1,
        else: 'triage',
      });
      lowered.states.implementing!.on![g]!.on_unmet = base.states.implementing!.on![g]!.on_unmet;
    }
    lowered.version = base.version;
    expect(lowered).toEqual(base);
  });

  it('declares the four verdicts, counted where they loop back, and a fix_env leg', () => {
    const def = WorkflowDefinitionSchema.parse(draft);
    const triage = def.states.triage!;
    expect(triage).toMatchObject({ type: 'agent', role: 'triage' });
    expect(triage.type !== 'terminal' && triage.on).toMatchObject({
      send_back: { goto: '$return_to', retries: 2, else: 'needs_input' },
      rerun: { goto: '$gate', retries: 1, else: 'needs_input' },
      fix_env: { goto: 'fix_env' },
      escalate: { goto: 'needs_input' },
    });
    expect(def.states.fix_env).toMatchObject({
      type: 'command',
      on: { exit_0: { goto: '$gate', retries: 1, else: 'needs_input' } },
    });
    expect(triageLegs(def)).toEqual(new Set(['fix_env']));
    expect(triageSources(def, 'triage')).toEqual(['implementing']);
  });
});
