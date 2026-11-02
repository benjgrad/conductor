import type { Approval, Transition, WorkflowDefinition } from './schema.js';
import { transitionGoto, transitionObject, transitionsOf } from './transition-rules.js';

// ADR-0030 amendment (save_workflow): a workflow saved over MCP may not remove or weaken a human
// checkbox (`requires.approvals`, ADR-0020 §5) that the previous version had, because MCP must never
// take a move a human has to approve (ADR-0014 §5). Heuristic: it checks the transition itself and
// every other transition out of the same state to the same target; a detour through another state
// is not detected (the admin-only gate is the main control). Pure.

type Def = Pick<WorkflowDefinition, 'states'>;

const approvalsOf = (t: Transition | undefined): readonly Approval[] =>
  t === undefined ? [] : (transitionObject(t).requires?.approvals ?? []);

/** An approval as JSON with sorted keys (shared runs in the browser too: no node:util). */
const key = (a: Approval): string => JSON.stringify(a, Object.keys(a).sort());

const covers = (have: readonly Approval[], need: readonly Approval[]): boolean => {
  const keys = new Set(have.map(key));
  return need.every((a) => keys.has(key(a)));
};

/**
 * The `state.transition` names of `next` that lost an approval `prev` required: the approval-gated
 * human transition is gone or misses one of its approvals, or another transition out of the same
 * state now reaches the same target without them. Empty = nothing weakened.
 */
export function approvalsWeakened(prev: Def, next: Def): string[] {
  const out = new Set<string>();
  for (const state of Object.keys(prev.states)) {
    for (const e of transitionsOf(prev, state, { actor: 'human' })) {
      const need = e.transition.requires?.approvals ?? [];
      if (need.length === 0) continue;
      const s = next.states[state];
      const on = s !== undefined && 'on' in s ? (s.on ?? {}) : {};
      if (!covers(approvalsOf(on[e.name]), need)) out.add(`${state}.${e.name}`);
      const target = e.transition.goto;
      for (const [name, t] of Object.entries(on)) {
        if (name === e.name || transitionGoto(t) !== target) continue;
        if (!covers(approvalsOf(t), need)) out.add(`${state}.${name}`);
      }
    }
  }
  return [...out].sort();
}
