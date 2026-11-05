import type { WorkflowDefinition } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  addInstruction,
  instructionIssues,
  instructionSlugProblem,
  removeInstruction,
  renameInstruction,
  setInstructionText,
  setPresets,
  useLabel,
} from './instructions.js';
import { validateTransitions } from './transitions.js';

// ADR-0037 P5 (T8): the Instructions list's pure edits and the client side of rule 21.

const base = (): WorkflowDefinition =>
  ({
    id: 'x',
    version: 1,
    start: 'work',
    budget: { usd: 1, minutes: 60, max_loop_retries: 3 },
    instructions: { resync_main: 'Merge main.' },
    states: {
      work: {
        type: 'agent',
        title: 'Work',
        prompt: 'p',
        tools: ['edit'],
        on: {
          ship: {
            goto: 'review',
            title: 'Ship',
            requires: { checks: [{ name: 'Tests', cmd: 'npm test' }] },
            on_unmet: { goto: 'work', instruction: '$instructions.resync_main', retries: 2, else: 'review' },
          },
          ask_user: 'review',
        },
      },
      review: {
        type: 'human',
        title: 'Review',
        on: {
          request_changes: { goto: '$return_to', actor: 'human', text: 'required', presets: ['resync_main'] },
          done: 'done',
        },
      },
      done: { type: 'terminal' },
    },
  }) as unknown as WorkflowDefinition;

const onOf = (d: WorkflowDefinition, s: string) => {
  const st = d.states[s]!;
  if (st.type === 'terminal') throw new Error('terminal');
  return st.on as Record<string, Record<string, unknown>>;
};

describe('the Instructions list', () => {
  it('add, edit and rename round-trip; a rename rewrites refs and presets', () => {
    const { definition: added, slug } = addInstruction(base());
    expect(slug).toBe('instruction');
    expect(addInstruction(added).slug).toBe('instruction_2');
    const edited = setInstructionText(added, slug, 'Rebase.');
    expect(edited.instructions).toEqual({ resync_main: 'Merge main.', instruction: 'Rebase.' });
    const renamed = renameInstruction(edited, 'resync_main', 'sync');
    expect(Object.keys(renamed.instructions!)).toEqual(['sync', 'instruction']);
    expect(onOf(renamed, 'work').ship!.on_unmet).toMatchObject({ instruction: '$instructions.sync' });
    expect(onOf(renamed, 'review').request_changes!.presets).toEqual(['sync']);
    // The input is not changed.
    expect(onOf(edited, 'review').request_changes!.presets).toEqual(['resync_main']);
  });

  it('a slug must be lower_snake_case and unique', () => {
    const d = setInstructionText(addInstruction(base()).definition, 'instruction', 'x');
    expect(instructionSlugProblem(d, 'instruction', 'Bad Slug')).toMatch(/lower_snake_case/);
    expect(instructionSlugProblem(d, 'instruction', 'resync_main')).toMatch(/already/);
    expect(instructionSlugProblem(d, 'instruction', 'fine_2')).toBeNull();
    expect(() => renameInstruction(d, 'instruction', 'resync_main')).toThrow();
  });

  it('delete is refused while used, and allowed once unused', () => {
    const refused = removeInstruction(base(), 'resync_main');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.uses.map((u) => useLabel(base(), u))).toEqual([
      'Work → Ship (instruction)',
      'Review → Request changes (saved reply)',
    ]);
    const unused = setPresets(
      { ...base(), states: { ...base().states, work: { ...base().states.work!, on: { ask_user: 'review' } } } } as WorkflowDefinition,
      'review',
      'request_changes',
      [],
    );
    expect(onOf(unused, 'review').request_changes!.presets).toBeUndefined();
    const removed = removeInstruction(unused, 'resync_main');
    expect(removed.ok && removed.definition.instructions).toBeUndefined();
  });

  it('an empty instruction is a problem', () => {
    expect(instructionIssues(addInstruction(base()).definition)).toEqual([
      { path: 'instructions.instruction', message: 'instruction "instruction" is empty' },
    ]);
  });
});

describe('rule 21 in the editor', () => {
  const issues = (d: WorkflowDefinition) =>
    validateTransitions(d)
      .filter((i) => /presets|instruction/.test(i.path))
      .map((i) => `${i.path}: ${i.message}`);

  it('the base has none', () => {
    expect(issues(base())).toEqual([]);
  });

  it('presets on a non-human transition, or a missing slug, are refused', () => {
    const d = setPresets(base(), 'work', 'ship', ['resync_main', 'gone']);
    expect(issues(d)).toEqual([
      'states.work.on.ship.presets: saved replies are only for a person’s button that asks for text',
      'states.work.on.ship.presets.1: saved instruction "gone" doesn\'t exist',
    ]);
  });

  it('a ref to a missing instruction is refused', () => {
    const d = structuredClone(base());
    delete d.instructions;
    expect(issues(d)).toContain(
      'states.work.on.ship.on_unmet.instruction: saved instruction "resync_main" doesn\'t exist',
    );
  });
});
