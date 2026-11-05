import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PIN_CHECK } from '../engine/move-step.js';
import { entryStateLabel, reviewStateLabel } from '../engine/review.js';
import { moveStateLabel } from '../engine/types.js';
import { CONDUCTOR_V2_DEF, CONDUCTOR_V3_DEF, CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import type { WorkflowDefinition } from '../workflow/schema.js';
import { validateWorkflow } from '../workflow/validate.js';
import {
  checkIdentity,
  gateSource,
  inputClass,
  isHandoffTransition,
  stateKey,
  waitsOnOthers,
} from './gates.js';

/** The live conductor v5 (PR gates go to `in_review`), the engine tests' snapshot. */
function v5(): WorkflowDefinition {
  const url = new URL('../engine/fixtures/conductor.v5.live.json', import.meta.url);
  const r = validateWorkflow(JSON.parse(readFileSync(url, 'utf8')));
  if (!r.ok) throw new Error('conductor.v5.live.json is invalid');
  return r.def;
}

describe('stateKey', () => {
  it('keys a gate step on its source and transition, whatever its target', () => {
    const v4 = moveStateLabel('implementing', 'needs_input', 'personal_pr_ready_for_review');
    const v5 = moveStateLabel('implementing', 'in_review', 'personal_pr_ready_for_review');
    expect(stateKey(v4)).toBe('implementing.personal_pr_ready_for_review');
    expect(stateKey(v5)).toBe(stateKey(v4));
    expect(stateKey(entryStateLabel('implementing', 'qa'))).toBe('qa.entry');
    expect(stateKey(reviewStateLabel('implement', 'build'))).toBe('implement.review');
    expect(stateKey('implementing')).toBe('implementing');
    expect(gateSource(v5)).toBe('implementing');
    expect(gateSource('needs_input')).toBe('needs_input');
  });
});

describe('isHandoffTransition / inputClass', () => {
  it('a question: true gate that ships work is a hand-off; ask_user and approvals stay questions', () => {
    for (const def of [CONDUCTOR_V2_DEF, CONDUCTOR_V3_DEF, CONDUCTOR_V4_DEF, v5()]) {
      expect(isHandoffTransition(def, 'implementing', 'personal_pr_ready_for_review')).toBe(true);
      expect(isHandoffTransition(def, 'implementing', 'pr_ready_for_review')).toBe(true);
      expect(isHandoffTransition(def, 'implementing', 'needs_approval_to_message')).toBe(false);
      expect(isHandoffTransition(def, 'implementing', 'ask_user')).toBe(false);
      expect(isHandoffTransition(def, 'planning', 'scope_changed')).toBe(false);
      expect(isHandoffTransition(def, 'implementing', 'nope')).toBe(false);
    }
  });

  it('classes inputs as question, hand-off or engine stop', () => {
    const def = v5();
    const gate = moveStateLabel('implementing', 'in_review', 'personal_pr_ready_for_review');
    const row = (kind: string, transition: string | null, from: string | null) => ({
      kind,
      transition,
      from,
    });
    expect(inputClass(row('agent_question', 'personal_pr_ready_for_review', gate), def)).toBe(
      'handoff',
    );
    expect(inputClass(row('agent_question', 'ask_user', 'implementing'), def)).toBe('question');
    expect(
      inputClass(row('agent_question', 'needs_approval_to_message', 'implementing'), def),
    ).toBe('question');
    expect(inputClass(row('agent_question', null, 'implementing'), def)).toBe('question');
    expect(inputClass(row('retries_exhausted', null, gate), def)).toBe('stop');
    expect(inputClass(row('timeout', 'timeout', 'implementing'), def)).toBe('stop');
    // No definition: the name decides.
    expect(inputClass(row('agent_question', 'pr_ready_for_review', gate), undefined)).toBe(
      'handoff',
    );
    // ADR-0037 P7: an engine route carries the gate's name, but no one took it.
    expect(
      inputClass(
        { ...row('agent_question', 'pr_ready_for_review', gate), cause: 'fallback' },
        undefined,
      ),
    ).toBe('question');
    expect(
      inputClass(
        { ...row('agent_question', 'personal_pr_ready_for_review', gate), cause: 'transition' },
        def,
      ),
    ).toBe('handoff');
    expect(inputClass(row('agent_question', 'ask_user', 'implementing'), undefined)).toBe(
      'question',
    );
  });
});

describe('waitsOnOthers', () => {
  it('flags event states and gates that wait on an approval, with their ceiling', () => {
    const defs = [CONDUCTOR_V4_DEF, v5()];
    expect(waitsOnOthers(defs, 'waiting_external')).toEqual({ ceiling_minutes: null });
    expect(waitsOnOthers(defs, 'implementing.ready_for_testing')).toEqual({
      ceiling_minutes: 3 * 24 * 60,
    });
    // CI and agents are conductor's own: not waiting on others.
    expect(waitsOnOthers(defs, 'implementing.personal_pr_ready_for_review')).toBeNull();
    expect(waitsOnOthers(defs, 'implementing')).toBeNull();
    // A human state is the user's own wait: real friction, not excluded.
    expect(waitsOnOthers(defs, 'needs_input')).toBeNull();
    expect(waitsOnOthers([], 'waiting_external')).toBeNull();
  });

  it('ignores a disabled approval condition', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF);
    const t = def.states.implementing!;
    if (t.type !== 'agent') throw new Error('implementing is an agent state');
    const rt = t.on!.ready_for_testing!;
    if (typeof rt === 'string') throw new Error('ready_for_testing is an object');
    rt.requires!.conditions = rt.requires!.conditions!.map((c) =>
      c.type === 'pr_approvals' ? { ...c, enabled: false } : c,
    );
    expect(waitsOnOthers([def], 'implementing.ready_for_testing')).toBeNull();
  });
});

describe('checkIdentity', () => {
  const repoChecks = {
    setup: 'make deps',
    checks: [{ name: 'Backend builds', cmd: 'mtd build' }],
  };
  const gateKey = 'implementing.personal_pr_ready_for_review';

  it('names a run from the repo override, the workflow gate, the pin check, else the command', () => {
    const def = CONDUCTOR_V4_DEF;
    const base = { setup_failed: false, gateKey, def, repoChecks };
    expect(checkIdentity({ ...base, cmd: 'mtd build' })).toEqual({
      name: 'Backend builds',
      role: 'check',
      source: 'repo',
    });
    expect(checkIdentity({ ...base, repoChecks: null, cmd: 'npm run build' })).toMatchObject({
      role: 'check',
      source: 'workflow',
    });
    expect(checkIdentity({ ...base, cmd: PIN_CHECK.cmd })).toEqual({
      name: PIN_CHECK.name,
      role: 'pin',
      source: 'workflow',
    });
    const long = `MSB="/c/Program Files (x86)/${'x'.repeat(200)}"`;
    const unknown = checkIdentity({ ...base, cmd: long });
    expect(unknown.source).toBe('unknown');
    expect(unknown.name.length).toBeLessThanOrEqual(80);
  });

  it('a failed setup is the setup, not the check it ran before', () => {
    const base = { cmd: 'mtd build', setup_failed: true, gateKey, def: CONDUCTOR_V4_DEF };
    expect(checkIdentity({ ...base, repoChecks })).toEqual({
      name: 'Repo setup',
      role: 'setup',
      source: 'repo',
    });
    expect(checkIdentity({ ...base, repoChecks: null })).toEqual({
      name: 'Workflow setup',
      role: 'setup',
      source: 'workflow',
    });
  });
});
