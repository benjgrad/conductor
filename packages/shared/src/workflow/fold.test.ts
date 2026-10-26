import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V1_DEF } from './conductor.js';
import { foldLegacyRequirements } from './fold.js';
import { CONDUCTOR_V2_DRAFT_DEF } from './fixtures.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './schema.js';

// ADR-0011: ADR-0010 `entry` and ADR-0009 `requirements` fold into transition `requires`.

const load = (name: string): WorkflowDefinition =>
  WorkflowDefinitionSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
    ),
  );

describe('foldLegacyRequirements', () => {
  it("puts conductor v1's waiting_external entry on implementing.on.done", () => {
    const before = structuredClone(CONDUCTOR_V1_DEF);
    const folded = foldLegacyRequirements(CONDUCTOR_V1_DEF);
    expect(CONDUCTOR_V1_DEF).toEqual(before); // input untouched
    expect(folded.states.waiting_external?.entry).toBeUndefined();
    const impl = folded.states.implementing;
    expect(impl?.type === 'agent' && impl.on?.done).toEqual({
      goto: 'waiting_external',
      requires: {
        checks: [
          { name: 'Build passes', cmd: 'npm run build', timeout: '10m' },
          { name: 'Tests pass', cmd: 'npm test', timeout: '10m' },
        ],
        actions: ['open_pr'],
      },
      on_unmet: {
        goto: 'implementing',
        instruction: 'Fix what is listed above, commit, then finish the step again.',
        retries: 3,
        else: 'needs_input',
      },
    });
    // fallbacks into needs_input are untouched; nothing else changed
    expect(impl?.type === 'agent' && impl.on?.timeout).toBe('needs_input');
    expect(folded.states.planning).toEqual(CONDUCTOR_V1_DEF.states.planning);
    expect(WorkflowDefinitionSchema.parse(folded)).toEqual(folded);
  });

  it('turns an ADR-0009 gate into requires.review + on_unmet (m1_reviewed)', () => {
    const def = load('m1_reviewed.v1.json');
    const folded = foldLegacyRequirements(def);
    let gates = 0;
    for (const [sn, s] of Object.entries(def.states)) {
      if (s.type === 'terminal') continue;
      for (const [name, t] of Object.entries(s.on ?? {})) {
        if (typeof t !== 'object' || t.requirements === undefined) continue;
        gates++;
        const ft = folded.states[sn]!;
        const out = ft.type !== 'terminal' ? ft.on?.[name] : undefined;
        expect(out).toMatchObject({
          goto: t.goto,
          requires: {
            review: {
              items: t.requirements.items,
              ...(t.requirements.model ? { model: t.requirements.model } : {}),
            },
          },
          on_unmet: t.requirements.on_unmet,
        });
        expect(typeof out === 'object' && out.requirements).toBeUndefined();
      }
    }
    expect(gates).toBeGreaterThan(0);
    expect(WorkflowDefinitionSchema.parse(folded)).toEqual(folded);
  });

  it('returns the definition itself when there is nothing to fold', () => {
    const def = load('m1_basic.v1.json');
    expect(foldLegacyRequirements(def)).toBe(def);
    expect(foldLegacyRequirements(CONDUCTOR_V2_DRAFT_DEF)).toBe(CONDUCTOR_V2_DRAFT_DEF);
  });

  it('merges a gate and an entry on one transition (gate first; existing requires kept)', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'x',
      version: 1,
      start: 'a',
      budget: { usd: 1, minutes: 1, max_loop_retries: 1 },
      states: {
        a: {
          type: 'agent',
          prompt: 'p',
          on: {
            done: {
              goto: 'b',
              requires: { setup: '' },
              requirements: {
                items: ['gate item'],
                model: 'opus',
                on_unmet: { goto: 'a', retries: 1, else: 'h' },
              },
            },
          },
        },
        b: {
          type: 'terminal',
          entry: {
            checks: [{ name: 'T', cmd: 'true' }],
            review: { items: ['entry item'], model: 'haiku' },
            on_unmet: { goto: 'a', retries: 5, else: 'h' },
          },
        },
        h: { type: 'human' },
      },
    });
    const a = foldLegacyRequirements(def).states.a;
    expect(a?.type === 'agent' && a.on?.done).toEqual({
      goto: 'b',
      requires: {
        checks: [{ name: 'T', cmd: 'true' }],
        setup: '',
        review: { items: ['gate item', 'entry item'], model: 'opus' },
      },
      on_unmet: { goto: 'a', retries: 1, else: 'h' },
    });
  });
});
