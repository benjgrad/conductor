import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateWorkflow } from './validate.js';

// ADR-0037 spike: docs/design/workflows/conductor.v6.draft.json is the definition the builder would
// save once P1–P8 land. The proposed fields aren't in WorkflowDefinitionSchema yet, so this test
// folds them back to today's equivalents (`lowerToV5Schema`) and checks that everything else is a
// valid definition now. It also hand-checks the proposed validator rules (ADR-0037 §Validation) that
// can be read off the JSON. When T1 lands the schema, replace it with
// `validateWorkflow(draft, {allowUnavailable: true})` (T1's acceptance).

type Json = Record<string, unknown>;
const draft = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v6.draft.json', import.meta.url),
    'utf8',
  ),
) as Json;

const INSTRUCTION_REF = /^\$instructions\.([a-z][a-z0-9_]*)$/;

/** Every ADR-0037 field found, as `path: field`, and the definition without them. */
function lowerToV5Schema(def: Json): { def: Json; proposed: string[] } {
  const out = structuredClone(def);
  const proposed: string[] = [];
  const instructions = (out.instructions ?? {}) as Record<string, string>;
  for (const key of ['instructions', 'notify'] as const) {
    if (key in out) {
      proposed.push(key);
      delete out[key];
    }
  }
  const resolve = (text: string): string => {
    const m = INSTRUCTION_REF.exec(text);
    return m ? (instructions[m[1]!] ?? text) : text;
  };
  for (const [sName, state] of Object.entries(out.states as Record<string, Json>)) {
    if ('watch' in state) {
      proposed.push(`${sName}: watch`);
      delete state.watch;
    }
    for (const [tName, t] of Object.entries((state.on ?? {}) as Record<string, unknown>)) {
      if (typeof t !== 'object' || t === null) continue;
      const tr = t as Json;
      const at = `${sName}.${tName}`;
      if (tr.handoff === true) {
        proposed.push(`${at}: handoff`);
        delete tr.handoff;
        tr.question = true; // today's spelling of a hand-off
      }
      if (typeof tr.notify === 'string') {
        proposed.push(`${at}: notify=${tr.notify}`);
        delete tr.notify;
      }
      if ('presets' in tr) {
        proposed.push(`${at}: presets`);
        delete tr.presets;
      }
      const onUnmet = tr.on_unmet as Json | undefined;
      if (typeof onUnmet?.instruction === 'string' && INSTRUCTION_REF.test(onUnmet.instruction)) {
        proposed.push(`${at}: on_unmet.instruction ref`);
        onUnmet.instruction = resolve(onUnmet.instruction);
      }
      const req = tr.requires as Json | undefined;
      if (req === undefined) continue;
      if ('concurrency' in req) {
        proposed.push(`${at}: requires.concurrency`);
        delete req.concurrency;
      }
      for (const c of (req.conditions ?? []) as Json[]) {
        if (c.type === 'pr_checks_green' && typeof c.no_checks === 'object') {
          proposed.push(`${at}: no_checks`);
          c.no_checks_after = (c.no_checks as Json).after;
          delete c.no_checks;
        }
      }
    }
  }
  return { def: out, proposed };
}

describe('conductor v6 draft (ADR-0037)', () => {
  it('is the live v5 plus only ADR-0037 fields: lowered, it validates today', () => {
    const { def, proposed } = lowerToV5Schema(draft);
    const result = validateWorkflow(def);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(proposed.sort()).toEqual(
      [
        'instructions',
        'notify',
        'planning.plan_needs_approval: notify=always',
        'in_review: watch',
        'needs_input: watch',
        'in_review.request_changes: presets',
        'implementing.pr_ready_for_review: handoff',
        'implementing.personal_pr_ready_for_review: handoff',
        'implementing.pr_ready_for_review: requires.concurrency',
        'implementing.personal_pr_ready_for_review: requires.concurrency',
        'implementing.pr_ready_for_review: no_checks',
        'implementing.personal_pr_ready_for_review: no_checks',
        'implementing.ready_for_testing: no_checks',
        'implementing.pr_ready_for_review: on_unmet.instruction ref',
        'implementing.personal_pr_ready_for_review: on_unmet.instruction ref',
        'implementing.ready_for_testing: on_unmet.instruction ref',
      ].sort(),
    );
  });

  it('meets the proposed rules 19–22 that the JSON alone can show', () => {
    const states = draft.states as Record<string, Json>;
    const instructions = draft.instructions as Record<string, string>;
    const isHuman = (s: unknown) => typeof s === 'string' && states[s]?.type === 'human';
    const refs: string[] = [];
    for (const [sName, state] of Object.entries(states)) {
      const watch = state.watch as Json | undefined;
      if (watch !== undefined) {
        // Rule 19: watch only on human / event states; a move needs a bounded leg to a human.
        expect(['human', 'event']).toContain(state.type);
        const onBroken = watch.on_broken as Json;
        if ('goto' in onBroken) {
          expect(onBroken.goto).not.toBe(sName);
          expect(states[onBroken.goto as string]).toBeDefined();
          expect(isHuman(onBroken.else)).toBe(true);
          expect(onBroken.retries).toBeLessThanOrEqual(10);
        } else {
          expect(onBroken.notify).toBe('escalate');
        }
        if (typeof onBroken.instruction === 'string') refs.push(onBroken.instruction);
      }
      for (const t of Object.values((state.on ?? {}) as Record<string, unknown>)) {
        if (typeof t !== 'object' || t === null) continue;
        const tr = t as Json;
        // Rule 22: question and handoff are exclusive; handoff only into a human state.
        if (tr.handoff === true) {
          expect(tr.question).toBeUndefined();
          expect(isHuman(tr.goto)).toBe(true);
        }
        // Rule 21: presets only on a human-actor transition with a text box.
        if ('presets' in tr) {
          expect(tr.actor).toBe('human');
          expect(['required', 'optional']).toContain(tr.text);
          for (const p of tr.presets as string[]) refs.push(`$instructions.${p}`);
        }
        const req = tr.requires as Json | undefined;
        const conc = req?.concurrency as Json | undefined;
        // Rule 20: concurrency has a hold timeout and its scope names existing states.
        if (conc !== undefined) {
          expect(conc.hold_timeout).toBeTypeOf('string');
          for (const s of conc.scope as string[]) expect(states[s]).toBeDefined();
        }
        const instr = (tr.on_unmet as Json | undefined)?.instruction;
        if (typeof instr === 'string' && instr.startsWith('$')) refs.push(instr);
      }
    }
    // Rule 21: every `$instructions.<slug>` resolves.
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs)
      expect(instructions[INSTRUCTION_REF.exec(r)?.[1] ?? '']).toBeTypeOf('string');
  });
});
