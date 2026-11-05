// A state's display name, shared by OutputLog's dividers and the Details tab's Steps (steps.ts).
// Its own module so steps.ts doesn't pull in OutputLog (tests mock that module).
import type { WorkflowDefinition } from '@conductor/shared';
import { displayState } from '../workflow/review.js';

/**
 * A state's display name: its workflow title, else `snake_case` as words; a gate step's label as
 * `displayState` words it (UX-6: never the synthetic "→ … (move: …)" label).
 */
export function phaseStateName(state: string, workflow?: WorkflowDefinition): string {
  const title = workflow?.states[state]?.title;
  if (title) return title;
  if (!/^[a-z0-9_]+$/.test(state)) return displayState(state, workflow);
  const words = state.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
