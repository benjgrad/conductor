import { describe, expect, it } from 'vitest';
import { stateTitleOfCard } from './rest.js';

// UXR-30: BoardCard.state_title, so a card never shows an engine id.
describe('stateTitleOfCard', () => {
  const def = {
    states: {
      await_approval: { type: 'human', title: 'Waiting for approval' },
      build_step: { type: 'command' },
    },
  } as never;

  it("a state's title, else its name in words", () => {
    expect(stateTitleOfCard(def, 'await_approval')).toBe('Waiting for approval');
    expect(stateTitleOfCard(def, 'build_step')).toBe('Build step');
  });

  it('null for no state, a synthetic label, a state not in the def, or no def', () => {
    expect(stateTitleOfCard(def, null)).toBeNull();
    expect(stateTitleOfCard(def, 'build_step → done (move: ship)')).toBeNull();
    expect(stateTitleOfCard(def, 'gone')).toBeNull();
    expect(stateTitleOfCard(null, 'build_step')).toBeNull();
  });
});
