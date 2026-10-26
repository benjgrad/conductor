import {
  AVAILABLE_CONDITION_TYPES,
  AVAILABLE_TRANSITION_ACTIONS,
  RETURN_TO,
  conditionEnabled,
  type Transition,
  type TransitionObject,
  type WorkflowDefinition,
  type WorkflowState,
} from './schema.js';
import {
  FALLBACK_TRANSITION_NAMES,
  transitionActor,
  transitionGoto,
  transitionObject,
} from './transition-rules.js';
import type { WorkflowValidationError } from './validate.js';

// Validator rules 10–14 (ADR-0011, M1b-T02; 05 §Validation on save): the per-transition rules.
// The graph rules (2–5) see the same transitions through `collectEdges` in validate.ts. Paths
// point into the transition (`states.<s>.on.<name>.requires.conditions.1`) so the editor (T06)
// can map an error to the arrow and the field.

type Path = (string | number)[];

/**
 * Rules 10–14. `has(name)` says whether a state exists; a missing target is rule 1's, so these
 * rules skip what they can't judge rather than report it twice.
 */
export function checkTransitions(
  def: WorkflowDefinition,
  has: (name: string) => boolean,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const stateOf = (name: string): WorkflowState | undefined =>
    has(name) ? def.states[name] : undefined;
  const isHuman = (name: string) => stateOf(name)?.type === 'human';

  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    const on = state.on ?? {};
    for (const [name, raw] of Object.entries(on)) {
      const base: Path = ['states', from, 'on', name];
      const t = transitionObject(raw);
      checkActor(errors, def, from, state, name, raw, t, base);
      checkQuestion(errors, t, base, stateOf);
      checkRequires(errors, def, name, t, base, stateOf);
    }
    if (state.type === 'agent') checkCanAsk(errors, def, from, on, isHuman);
  }
  return errors;
}

/**
 * Rule 10, the actor fits the state: an explicit `actor: agent` only on an agent state (the
 * inferred actor already follows the state type); `actor: human` only on a human or event state;
 * `RETURN_TO` only as the `goto` of a human-state transition (never an `else` or `on_unmet` leg,
 * whose targets are entered directly).
 */
function checkActor(
  errors: WorkflowValidationError[],
  def: WorkflowDefinition,
  from: string,
  state: Exclude<WorkflowState, { type: 'terminal' }>,
  name: string,
  raw: Transition,
  t: TransitionObject,
  base: Path,
): void {
  const err = (path: Path, message: string) => errors.push({ rule: 10, path, message });
  if (t.actor === 'agent' && state.type !== 'agent') {
    err(
      [...base, 'actor'],
      `only an agent state's transitions can be taken by the agent ("${from}" is ${state.type})`,
    );
  }
  if (t.actor === 'human' && state.type !== 'human' && state.type !== 'event') {
    err(
      [...base, 'actor'],
      `a human can only take transitions out of human and event states ("${from}" is ${state.type})`,
    );
  }
  if (t.goto === RETURN_TO && state.type !== 'human') {
    err(
      [...base, 'goto'],
      `"${RETURN_TO}" (back to the state that asked) is only allowed on a human state's transitions ("${from}" is ${state.type})`,
    );
  }
  if (
    t.goto === RETURN_TO &&
    state.type === 'human' &&
    transitionActor(def, from, name, raw) !== 'human'
  ) {
    err(
      [...base, 'actor'],
      `"${RETURN_TO}" is a human's move: this transition's actor must be human`,
    );
  }
  const legs: [Path, string | undefined][] = [
    [['else'], t.else],
    [['on_unmet', 'goto'], t.on_unmet?.goto],
    [['on_unmet', 'else'], t.on_unmet?.else],
    [['requirements', 'on_unmet', 'goto'], t.requirements?.on_unmet.goto],
    [['requirements', 'on_unmet', 'else'], t.requirements?.on_unmet.else],
  ];
  for (const [leg, target] of legs) {
    if (target === RETURN_TO) {
      err([...base, ...leg], `"${RETURN_TO}" is only allowed as a human transition's goto`);
    }
  }
}

/** Rule 11: `question: true` only on a transition into a human state (the reason is the question). */
function checkQuestion(
  errors: WorkflowValidationError[],
  t: TransitionObject,
  base: Path,
  stateOf: (name: string) => WorkflowState | undefined,
): void {
  if (t.question !== true) return;
  const target = t.goto === RETURN_TO ? 'not a state' : stateOf(t.goto)?.type;
  // A missing target is rule 1's.
  if (target === undefined || target === 'human') return;
  errors.push({
    rule: 11,
    path: [...base, 'question'],
    message: `a question transition must go to a human state ("${t.goto}" is ${target})`,
  });
}

/**
 * Rule 12, every agent state can ask a human: it declares `ask_user` into a human state (the
 * built-in fallback, U-061), or at least one agent-actor `question: true` transition.
 */
function checkCanAsk(
  errors: WorkflowValidationError[],
  def: WorkflowDefinition,
  from: string,
  on: NonNullable<Exclude<WorkflowState, { type: 'terminal' }>['on']>,
  isHuman: (name: string) => boolean,
): void {
  const askUser = on.ask_user;
  if (askUser !== undefined && isHuman(transitionGoto(askUser))) return;
  for (const [name, raw] of Object.entries(on)) {
    const t = transitionObject(raw);
    if (t.question === true && transitionActor(def, from, name, raw) === 'agent') return;
  }
  errors.push({
    rule: 12,
    path: ['states', from],
    message: `agent state "${from}" has no way to ask a human: add "ask_user" (to a human state) or a question transition`,
  });
}

/**
 * Rules 13 (bounded requirements) and 14 (what M1b can run), on a transition's `requires` and
 * `on_unmet`:
 * - 13: `requires` names at least one check, review item, action or condition; `setup` needs
 *   checks; check commands aren't blank, check names and actions are unique; any `requires` has an
 *   `on_unmet`; `conditions` need a `condition_timeout`; `on_unmet` needs `requires` (or ADR-0009
 *   `requirements`); `on_unmet.else` is a human state; `on_unmet.goto` is not the transition's
 *   own target and has no ADR-0010 `entry` (no nested steps, as rule 9); the fallback routes to a
 *   human (`ask_user`, `timeout`, `budget_exceeded`) never run requirements.
 * - 14: `update_jira` / `slack_message` are not available yet (M5); neither is an enabled
 *   condition outside AVAILABLE_CONDITION_TYPES; no `requires` on a transition into the start
 *   state (it is entered by a claim; a move back to it would carry requirements the first visit
 *   never had).
 */
function checkRequires(
  errors: WorkflowValidationError[],
  def: WorkflowDefinition,
  name: string,
  t: TransitionObject,
  base: Path,
  stateOf: (name: string) => WorkflowState | undefined,
): void {
  const r13 = (path: Path, message: string) => errors.push({ rule: 13, path, message });
  const r14 = (path: Path, message: string) => errors.push({ rule: 14, path, message });
  const req = t.requires;
  const at = [...base, 'requires'];

  if (req !== undefined) {
    const checks = req.checks ?? [];
    const steps =
      checks.length +
      (req.review ? 1 : 0) +
      (req.actions?.length ?? 0) +
      (req.conditions?.length ?? 0);
    if (steps === 0) r13(at, 'requires needs at least one check, review, action or condition');
    if (FALLBACK_TRANSITION_NAMES.includes(name)) {
      r13(at, `"${name}" is a built-in route to a human and never runs requirements`);
    }
    if (req.setup !== undefined && checks.length === 0) {
      r13([...at, 'setup'], 'setup runs before the checks: this transition has no checks');
    }
    const names = new Set<string>();
    checks.forEach((c, i) => {
      if (c.cmd.trim() === '')
        r13([...at, 'checks', i, 'cmd'], `check "${c.name}" has an empty command`);
      if (names.has(c.name)) r13([...at, 'checks', i, 'name'], `check "${c.name}" is listed twice`);
      names.add(c.name);
    });
    const actions = new Set<string>();
    (req.actions ?? []).forEach((a, i) => {
      if (actions.has(a)) r13([...at, 'actions', i], `action "${a}" is listed twice`);
      actions.add(a);
      if (!AVAILABLE_TRANSITION_ACTIONS.includes(a)) {
        r14([...at, 'actions', i], `action "${a}" is not available yet`);
      }
    });
    (req.conditions ?? []).forEach((c, i) => {
      if (conditionEnabled(c) && !AVAILABLE_CONDITION_TYPES.includes(c.type)) {
        r14(
          [...at, 'conditions', i],
          `condition "${c.type}" is not available yet (declare it with "enabled": false)`,
        );
      }
    });
    if ((req.conditions?.length ?? 0) > 0 && req.condition_timeout === undefined) {
      r13(
        [...at, 'condition_timeout'],
        'conditions need a condition_timeout (how long they may stay pending before a human)',
      );
    }
    if (t.on_unmet === undefined) {
      r13([...base, 'on_unmet'], 'requires needs on_unmet (where to go when they are not met)');
    }
    if (t.goto === def.start) {
      r14(at, `"${def.start}" is the start state: a transition into it can't have requirements`);
    }
  }

  const unmet = t.on_unmet;
  if (unmet === undefined) return;
  const u = [...base, 'on_unmet'];
  if (req === undefined && t.requirements === undefined) {
    r13(u, 'on_unmet has no effect without requires');
  }
  const elseState = stateOf(unmet.else);
  if (elseState !== undefined && elseState.type !== 'human') {
    r13(
      [...u, 'else'],
      `on_unmet.else "${unmet.else}" must be a human state (it is ${elseState.type})`,
    );
  }
  if (unmet.goto === t.goto) {
    r13([...u, 'goto'], `on_unmet.goto can't be "${t.goto}", the transition's own target`);
  } else if (stateOf(unmet.goto)?.entry !== undefined) {
    r13(
      [...u, 'goto'],
      `on_unmet.goto "${unmet.goto}" has entry requirements of its own (no nested steps)`,
    );
  }
}
