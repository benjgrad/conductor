import {
  conditionEnabled,
  type Condition,
  type EntryCheck,
  type OnUnmet,
  type TransitionAction,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { transitionObject, transitionTitle } from '../workflow/transition-rules.js';
import { fallbackHumanState } from './transitions.js';
import { moveCounterKey, type GateStep } from './types.js';

// ADR-0011 (M1b-T03): the `requires` of a taken transition, run as a gate step of kind `move`
// with the ADR-0010 entry-step machinery in apply.ts (fresh-checkout checks, the fenced reviewer,
// `run_action` actions, the worker kill, `head_sha` binding). This file holds what differs for a
// move: where its spec comes from, its counter, its wording, and the conditions phase (a stub
// here; M1b-T08 builds the real one).

/** What a gate step checks, from the pinned definition (ADR-0009 review, ADR-0010 entry, ADR-0011 move). */
export interface GateSpec {
  /** The target's column title (entry), the target's name (ADR-0009), or the transition's title (move). */
  title: string;
  /** How the step's questions name what it tries to do, e.g. `enter "Waiting external"`. */
  goal: string;
  checks: readonly EntryCheck[];
  /** The fresh checkout's setup: a command, '' (none), or null (auto-detect by the daemon). */
  setup: string | null;
  review: { items: readonly string[]; model?: string | undefined } | null;
  actions: readonly TransitionAction[];
  /** ADR-0011: the external conditions (every declared one, disabled included); [] before ADR-0011. */
  conditions: readonly Condition[];
  on_unmet: OnUnmet;
}

/** ADR-0010: the implicit check of a step without checks: a clean tree, and its HEAD. */
export const PIN_CHECK: EntryCheck = { name: 'Committed work', cmd: 'true' };

/** The transition a move step takes (`transition`, else the `outcome` it was started with). */
export function moveName(r: GateStep): string {
  return r.transition ?? r.outcome;
}

/** `retry_counters` key of a move step's unmet loop: `move:<from>:<name>`. */
export function moveCounter(r: GateStep): string {
  return moveCounterKey(r.from, moveName(r));
}

/**
 * The spec of a move step: the `requires` and `on_unmet` of transition `moveName(r)` out of
 * `r.from`; null when the pinned definition has no such transition with `requires`.
 * - checks: `requires.checks`; without any, a step that reviews or acts still pins the commit
 *   first (PIN_CHECK, as ADR-0010); a step with only conditions runs no command at all.
 * - on_unmet: the transition's; without one (the validator requires it, T02 rule 13) every unmet
 *   requirement goes straight to the fallback human state (retries 0), so the loop stays bounded.
 */
export function moveSpecOf(def: WorkflowDefinition, r: GateStep): GateSpec | null {
  const state = def.states[r.from];
  if (state === undefined || state.type === 'terminal') return null;
  const name = moveName(r);
  const raw = state.on?.[name];
  if (raw === undefined) return null;
  const t = transitionObject(raw);
  const req = t.requires;
  if (req === undefined) return null;
  const review = req.review ?? null;
  const actions = req.actions ?? [];
  const checks =
    req.checks !== undefined && req.checks.length > 0
      ? req.checks
      : review !== null || actions.length > 0
        ? [PIN_CHECK]
        : [];
  const title = transitionTitle(name, t);
  return {
    title,
    goal: `take "${title}" (${r.from} → ${r.to})`,
    checks,
    setup: req.setup ?? null,
    review,
    actions,
    conditions: req.conditions ?? [],
    on_unmet: t.on_unmet ?? {
      goto: r.from,
      retries: 0,
      else: fallbackHumanState(def) ?? 'needs_input',
    },
  };
}

/** What the conditions phase does once checks, review and actions have passed. */
export type ConditionsPhase =
  | { type: 'pass' }
  /** A human decides (`on_unmet.else`): the conditions can't be evaluated. */
  | { type: 'unavailable'; question: string };

/**
 * M1b-T03 stub of the conditions phase: no enabled condition → pass. Enabled conditions can't be
 * evaluated before M1b-T08, so the move goes to `on_unmet.else` (a human) rather than skipping
 * them; T08 replaces this with the polling phase (`evaluate_conditions`, 10 §Transitions).
 */
// TD: conditions phase stubbed until M1b-T08 (enabled conditions → on_unmet.else).
export function conditionsPhase(spec: GateSpec): ConditionsPhase {
  const enabled = spec.conditions.filter(conditionEnabled);
  if (enabled.length === 0) return { type: 'pass' };
  return {
    type: 'unavailable',
    question: `Conductor cannot check external conditions yet, so it did not ${spec.goal}. Retry, skip, or abort?`,
  };
}
