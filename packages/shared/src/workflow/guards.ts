import type { JsonObject } from '../domain.js';
import type { SessionSnapshot } from '../engine/types.js';
import type { WorkflowDefinition } from './schema.js';

// Guard registry (05 §Outcomes, not opinions; 10-contracts §Guards). A state's `guard` names an
// evaluator here. apply (T04) runs it on `agent.complete_state` before leaving the state; false →
// the state's `fail` outcome, or `needs_input` if it has none. Evaluators are pure: whatever a
// guard needs from the machine (e.g. commit counts) must arrive in the event, not via I/O.

export interface GuardInput {
  def: WorkflowDefinition;
  /** The snapshot before the transition (current state = the guarded one). */
  snapshot: SessionSnapshot;
  /** The `complete_state` result being checked. */
  result: JsonObject;
}

export type GuardEvaluator = (input: GuardInput) => boolean;

/** Guard name → evaluator. */
export type GuardRegistry = Readonly<Record<string, GuardEvaluator>>;

// TD-017: the M1 registry is empty and an unregistered guard *passes* (evaluateGuard returns
// true), so the validator (T03) accepts any guard name. `branch_has_commits` (pr_flow open_pr)
// needs commit facts from the daemon in the complete_state event, which M1 doesn't carry; pr_flow
// isn't an M1 workflow. Payoff: register it (and make unregistered names a validator error) when
// commit facts reach complete_state (M2 / pr_flow).
export const GUARD_REGISTRY: GuardRegistry = Object.freeze({});

export function isRegisteredGuard(name: string, registry: GuardRegistry = GUARD_REGISTRY): boolean {
  return Object.prototype.hasOwnProperty.call(registry, name);
}

/**
 * The guard check apply (T04) runs on `agent.complete_state` for a state with a `guard`.
 * Registered → the evaluator's verdict; unregistered → true (passes in M1, TD-017).
 */
export function evaluateGuard(
  name: string,
  input: GuardInput,
  registry: GuardRegistry = GUARD_REGISTRY,
): boolean {
  const evaluator = isRegisteredGuard(name, registry) ? registry[name] : undefined;
  return evaluator ? evaluator(input) : true;
}
