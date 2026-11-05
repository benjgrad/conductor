import { describe, expect, it } from 'vitest';
import {
  instructionUses,
  offeredPresets,
  presetLabel,
  resolveInstruction,
  resolvePresets,
  transitionPresets,
} from './instructions.js';
import type { WorkflowDefinition } from './schema.js';

// ADR-0037 P5 (T8): the pure helpers over `instructions`.

// Only the fields the helpers read; not a whole valid definition.
const def = {
  id: 'x',
  version: 1,
  start: 'work',
  instructions: { resync_main: 'Merge main.', fix: 'Fix it.' },
  states: {
    work: {
      type: 'agent',
      prompt: 'p',
      tools: ['edit'],
      on: {
        ship: {
          goto: 'review',
          requires: { checks: [{ name: 'Tests', cmd: 'npm test' }] },
          on_unmet: { goto: 'work', instruction: '$instructions.fix', else: 'review' },
        },
        ask_user: 'review',
      },
    },
    review: {
      type: 'human',
      on: {
        request_changes: {
          goto: '$return_to',
          actor: 'human',
          text: 'required',
          presets: ['resync_main', 'gone'],
        },
        done: 'done',
      },
    },
    done: { type: 'terminal' },
  },
} as unknown as WorkflowDefinition;

describe('instructions helpers', () => {
  it('resolveInstruction: literal as is, ref as its text, unresolved as undefined', () => {
    expect(resolveInstruction(def, 'Do it.')).toBe('Do it.');
    expect(resolveInstruction(def, '$instructions.fix')).toBe('Fix it.');
    expect(resolveInstruction(def, '$instructions.gone')).toBeUndefined();
    expect(resolveInstruction(def, '$instructions.Bad')).toBeUndefined();
    expect(resolveInstruction(def, undefined)).toBeUndefined();
  });

  it('presets resolve with a label, skipping a missing slug', () => {
    expect(transitionPresets(def, 'review', 'request_changes')).toEqual([
      { slug: 'resync_main', label: 'Resync main', text: 'Merge main.' },
    ]);
    expect(transitionPresets(def, 'review', 'done')).toEqual([]);
    expect(transitionPresets(def, 'nope', 'x')).toEqual([]);
    expect(resolvePresets(def, {})).toEqual([]);
    expect(presetLabel('fix_and_resubmit')).toBe('Fix and resubmit');
    expect(offeredPresets(def).map((p) => p.slug)).toEqual(['resync_main']);
  });

  it('instructionUses lists refs and presets with their paths', () => {
    expect(instructionUses(def)).toEqual([
      {
        path: ['states', 'work', 'on', 'ship', 'on_unmet', 'instruction'],
        slug: 'fix',
        kind: 'ref',
      },
      {
        path: ['states', 'review', 'on', 'request_changes', 'presets', 0],
        slug: 'resync_main',
        kind: 'preset',
      },
      {
        path: ['states', 'review', 'on', 'request_changes', 'presets', 1],
        slug: 'gone',
        kind: 'preset',
      },
    ]);
  });
});
