import {
  AVAILABLE_CONDITION_TYPES,
  AVAILABLE_TRANSITION_ACTIONS,
  conditionEnabled,
  DurationSchema,
  RETURN_TO,
  transitionActor,
  transitionObject,
  type Condition,
  type ConditionType,
  type OnUnmet,
  type Transition,
  type TransitionObject,
  type TransitionRequires,
  type WorkflowDefinition,
} from '@conductor/shared';
import { humanStates } from './model.js';

// ADR-0011 in the editor: the transitions out of a column (each `on` key is a transition name),
// the pure edits the arrow panel makes, and the client side of validator rules 10–14 so problems
// show on the arrow before Save. The server (shared validate.ts, M1b-T02) checks them again; its
// `details` paths (`states.<s>.on.<name>…`) map back to the arrow with `transitionForPath`.

const has = (def: WorkflowDefinition, name: string) =>
  Object.prototype.hasOwnProperty.call(def.states, name);

/** The transitions out of `from`, in definition order (none for a terminal state). */
export function transitionNames(def: WorkflowDefinition, from: string): string[] {
  const s = def.states[from];
  if (!s || s.type === 'terminal') return [];
  return Object.keys(s.on ?? {});
}

export function getTransitionObject(
  def: WorkflowDefinition,
  from: string,
  name: string,
): TransitionObject | null {
  const s = def.states[from];
  if (!s || s.type === 'terminal') return null;
  const t = s.on?.[name];
  return t === undefined ? null : transitionObject(t);
}

/** The transitions out of `from` that go to `goto` (one arrow), in definition order. */
export function arrowTransitions(def: WorkflowDefinition, from: string, goto: string): string[] {
  return transitionNames(def, from).filter((n) => getTransitionObject(def, from, n)?.goto === goto);
}

function withOn(
  def: WorkflowDefinition,
  from: string,
  fn: (on: Record<string, Transition>) => Record<string, Transition>,
): WorkflowDefinition {
  const s = def.states[from];
  if (!s || s.type === 'terminal') throw new Error(`no state "${from}" with transitions`);
  return { ...def, states: { ...def.states, [from]: { ...s, on: fn({ ...(s.on ?? {}) }) } } };
}

/** Drop undefined fields, and store a bare `{goto}` as the string form. */
function compact(t: TransitionObject): Transition {
  const out = Object.fromEntries(
    Object.entries(t).filter(([, v]) => v !== undefined),
  ) as TransitionObject;
  return Object.keys(out).length === 1 ? out.goto : out;
}

/** Replace transition `name` out of `from` (its place in `on` is kept). */
export function setTransition(
  def: WorkflowDefinition,
  from: string,
  name: string,
  t: TransitionObject,
): WorkflowDefinition {
  return withOn(def, from, (on) => ({ ...on, [name]: compact(t) }));
}

export function patchTransition(
  def: WorkflowDefinition,
  from: string,
  name: string,
  patch: Partial<TransitionObject>,
): WorkflowDefinition {
  const t = getTransitionObject(def, from, name);
  if (t === null) throw new Error(`state "${from}" has no transition "${name}"`);
  return setTransition(def, from, name, { ...t, ...patch });
}

/** Why `next` can't be the new name of a transition out of `from` (null = it can). */
export function transitionNameProblem(
  def: WorkflowDefinition,
  from: string,
  current: string,
  next: string,
): string | null {
  if (next.trim() === '') return 'the name is empty';
  if (/\s/.test(next)) return 'use a name without spaces, e.g. ready_for_review';
  if (next !== current && transitionNames(def, from).includes(next)) {
    return `this column already has a transition "${next}"`;
  }
  return null;
}

/** Rename a transition, keeping its place in `on`. */
export function renameTransition(
  def: WorkflowDefinition,
  from: string,
  current: string,
  next: string,
): WorkflowDefinition {
  if (current === next) return def;
  const problem = transitionNameProblem(def, from, current, next);
  if (problem !== null) throw new Error(problem);
  return withOn(def, from, (on) =>
    Object.fromEntries(Object.entries(on).map(([k, v]) => [k === current ? next : k, v])),
  );
}

export function removeTransition(
  def: WorkflowDefinition,
  from: string,
  name: string,
): WorkflowDefinition {
  return withOn(def, from, (on) => {
    const next = { ...on };
    delete next[name];
    return next;
  });
}

/**
 * Add a transition out of `from`: named `new_transition` (`_2`, `_3`… when taken), going to the
 * next column to the right (else the first other column).
 */
export function addTransition(
  def: WorkflowDefinition,
  from: string,
  columns: string[],
): { definition: WorkflowDefinition; name: string } {
  const names = transitionNames(def, from);
  let name = 'new_transition';
  for (let n = 2; names.includes(name); n++) name = `new_transition_${n}`;
  const i = columns.indexOf(from);
  const goto =
    columns.slice(i + 1).find((c) => c !== from) ?? columns.find((c) => c !== from) ?? from;
  return { definition: withOn(def, from, (on) => ({ ...on, [name]: { goto } })), name };
}

// ------------------------------------------------------------------ requires

export const ACTION_TEXT: Record<string, string> = {
  open_pr: 'Open a pull request (by conductor)',
  update_jira: 'Update the Jira ticket',
  slack_message: 'Send a Slack message',
};

export const CONDITION_TEXT: Record<ConditionType, string> = {
  pr_checks_green: 'PR checks green',
  pr_approvals: 'PR approvals',
  pr_merged: 'PR merged',
  azure_pipeline_succeeded: 'Azure pipeline succeeded',
  jira_fields_set: 'Jira fields set',
};

/** A new condition of `type`, keeping `enabled` / `label` from the one it replaces. */
export function conditionOfType(type: ConditionType, prev?: Condition): Condition {
  const common = {
    ...(prev?.enabled !== undefined ? { enabled: prev.enabled } : {}),
    ...(prev?.label !== undefined ? { label: prev.label } : {}),
  };
  switch (type) {
    case 'pr_approvals':
      return { type, min: prev?.type === 'pr_approvals' ? prev.min : 1, ...common };
    case 'azure_pipeline_succeeded':
      return {
        type,
        pipeline: prev?.type === 'azure_pipeline_succeeded' ? prev.pipeline : '',
        ...common,
      };
    case 'jira_fields_set':
      return { type, fields: prev?.type === 'jira_fields_set' ? prev.fields : [], ...common };
    case 'pr_checks_green':
      return prev?.type === 'pr_checks_green' && prev.no_checks_after !== undefined
        ? { type, no_checks_after: prev.no_checks_after, ...common }
        : { type, ...common };
    default:
      return { type, ...common };
  }
}

/** Whether `requires` asks for anything (an empty one is dropped). */
export function requiresAnything(r: TransitionRequires | undefined): boolean {
  if (r === undefined) return false;
  return (
    (r.checks?.length ?? 0) > 0 ||
    r.review !== undefined ||
    (r.actions?.length ?? 0) > 0 ||
    (r.conditions?.length ?? 0) > 0
  );
}

/**
 * Tidy a `requires` after an edit: empty lists go, `setup` only stays with checks, the condition
 * timeout and poll only with conditions; nothing left → undefined.
 */
export function normalizeRequires(r: TransitionRequires): TransitionRequires | undefined {
  const out: TransitionRequires = {};
  if ((r.checks?.length ?? 0) > 0) {
    out.checks = r.checks!;
    if (r.setup !== undefined) out.setup = r.setup;
  }
  if (r.review !== undefined && r.review.items.length > 0) out.review = r.review;
  if ((r.actions?.length ?? 0) > 0) out.actions = r.actions!;
  if ((r.conditions?.length ?? 0) > 0) {
    out.conditions = r.conditions!;
    if (r.condition_timeout !== undefined) out.condition_timeout = r.condition_timeout;
    if (r.condition_poll !== undefined) out.condition_poll = r.condition_poll;
  }
  return requiresAnything(out) ? out : undefined;
}

/**
 * A sensible new "when not met": back to `from` when it is an agent column (it fixes its own
 * work), else the start; up to 3 times; then `needs_input` (else the first human column).
 */
export function defaultOnUnmet(def: WorkflowDefinition, from: string): OnUnmet {
  const humans = humanStates(def);
  return {
    goto: def.states[from]?.type === 'agent' ? from : def.start,
    retries: 3,
    else: humans.includes('needs_input') ? 'needs_input' : (humans[0] ?? 'needs_input'),
  };
}

/**
 * Set a transition's `requires` (normalized). The first requirement brings a default `on_unmet`
 * (rule 13 needs one); with no requirement left, `on_unmet` goes too (an old ADR-0009 gate on the
 * same transition keeps its own `requirements.on_unmet`).
 */
export function setRequires(
  def: WorkflowDefinition,
  from: string,
  name: string,
  requires: TransitionRequires,
): WorkflowDefinition {
  const t = getTransitionObject(def, from, name);
  if (t === null) throw new Error(`state "${from}" has no transition "${name}"`);
  const r = normalizeRequires(requires);
  const next: TransitionObject = { ...t, requires: r };
  if (r !== undefined && t.on_unmet === undefined) next.on_unmet = defaultOnUnmet(def, from);
  if (r === undefined) delete next.on_unmet;
  return setTransition(def, from, name, next);
}

// ------------------------------------------------------------------ validation

export interface TransitionIssue {
  from: string;
  name: string;
  /** Dotted path into the definition, like the server's `details[].path`. */
  path: string;
  message: string;
}

const durationProblem = (text: string) =>
  DurationSchema.safeParse(text).success ? null : 'use a duration like "30m", "2h" or "3d"';

/**
 * The client side of ADR-0011's validator rules (M1b-T02: 10 actor fits the state, 11 questions,
 * 12 every agent state can ask, 13 bounded requirements, 14 actions and conditions available),
 * plus the field limits of the transition schema, so they show on the arrow before Save.
 *
 * TD-100: this duplicates packages/shared/src/workflow/validate-transitions.ts and has drifted
 * from it (no $return_to actor/else checks, no fallback-requires, on_unmet.goto or
 * on_unmet-without-requires rules; different paths), so Save can still 400.
 */
// TD-100
export function validateTransitions(def: WorkflowDefinition): TransitionIssue[] {
  const issues: TransitionIssue[] = [];
  const typeOf = (n: string) => def.states[n]?.type;
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    const on = state.on ?? {};
    // Rule 12: an agent state can always reach a human.
    if (state.type === 'agent') {
      const canAsk = Object.entries(on).some(([name, raw]) => {
        const t = transitionObject(raw);
        if (name === 'ask_user') return typeOf(t.goto) === 'human';
        return (
          t.question === true &&
          transitionActor(def, from, name, raw) === 'agent' &&
          typeOf(t.goto) === 'human'
        );
      });
      if (!canAsk) {
        issues.push({
          from,
          name: '',
          path: `states.${from}.on`,
          message:
            'an agent column needs a way to ask a person: an "ask_user" transition or a question transition to a human column',
        });
      }
    }
    for (const [name, raw] of Object.entries(on)) {
      const t = transitionObject(raw);
      const base = `states.${from}.on.${name}`;
      const add = (suffix: string, message: string) =>
        issues.push({ from, name, path: `${base}${suffix}`, message });

      if (/\s/.test(name) || name.trim() === '') add('', `the name "${name}" needs no spaces`);
      if (t.goto === RETURN_TO) {
        if (state.type !== 'human') {
          add('.goto', '"back to the state that asked" is only for a human column’s transitions');
        }
      } else if (!has(def, t.goto)) {
        add('.goto', `column "${t.goto}" does not exist`);
      }
      if (t.title !== undefined && t.title.trim() === '') add('.title', 'the title is empty');
      if (t.title !== undefined && t.title.length > 60) add('.title', 'at most 60 characters');
      if (t.when !== undefined && t.when.trim() === '') add('.when', '"when" is empty');
      if (t.when !== undefined && t.when.length > 1_000) add('.when', 'at most 1000 characters');
      if (t.kinds !== undefined && t.kinds.length === 0) {
        add('.kinds', 'pick at least one kind of ticket');
      }

      // Rule 10: the actor fits the state.
      if (t.actor === 'agent' && state.type !== 'agent') {
        add('.actor', 'only an agent column’s transitions can be taken by the agent');
      }
      if (t.actor === 'human' && state.type !== 'human' && state.type !== 'event') {
        add('.actor', 'only human and waiting columns have transitions a person takes');
      }
      // Rule 11: a question goes to a person.
      if (t.question === true && t.goto !== RETURN_TO && typeOf(t.goto) !== 'human') {
        add('.question', 'only a transition to a human column can ask a question');
      }

      const r = t.requires;
      if (r !== undefined) {
        const rb = `${base}.requires`;
        const addR = (suffix: string, message: string) =>
          issues.push({ from, name, path: `${rb}${suffix}`, message });
        // Rule 14: no requirements into the start column (a claim enters it).
        if (t.goto === def.start) {
          addR('', 'a move into the first column cannot have requirements');
        }
        const checks = r.checks ?? [];
        if (checks.length > 20) addR('.checks', 'at most 20 checks');
        const seen = new Set<string>();
        checks.forEach((c, i) => {
          if (c.name.trim() === '') addR(`.checks.${i}.name`, `check ${i + 1} needs a name`);
          else if (seen.has(c.name.trim())) {
            addR(`.checks.${i}.name`, `check "${c.name}" is listed twice`);
          }
          seen.add(c.name.trim());
          if (c.cmd.trim() === '') addR(`.checks.${i}.cmd`, `check ${i + 1} needs a command`);
          if (c.timeout !== undefined) {
            const p = durationProblem(c.timeout);
            if (p !== null) addR(`.checks.${i}.timeout`, p);
          }
        });
        if (r.setup !== undefined && checks.length === 0) {
          addR('.setup', 'setup runs before the checks: add a check, or remove the setup');
        }
        if (r.review !== undefined) {
          if (r.review.items.length === 0) addR('.review.items', 'add at least one review item');
          if (r.review.items.length > 30) addR('.review.items', 'at most 30 review items');
          r.review.items.forEach((item, i) => {
            if (item.trim() === '') addR(`.review.items.${i}`, `review item ${i + 1} is empty`);
          });
        }
        const actions = new Set<string>();
        (r.actions ?? []).forEach((a, i) => {
          if (actions.has(a)) addR(`.actions.${i}`, `action "${a}" is listed twice`);
          actions.add(a);
          if (!AVAILABLE_TRANSITION_ACTIONS.includes(a)) {
            addR(`.actions.${i}`, `"${ACTION_TEXT[a] ?? a}" is not available yet`);
          }
        });
        const conditions = r.conditions ?? [];
        conditions.forEach((c, i) => {
          const at = `.conditions.${i}`;
          if (conditionEnabled(c) && !AVAILABLE_CONDITION_TYPES.includes(c.type)) {
            addR(at, `"${CONDITION_TEXT[c.type]}" is not available yet: disable it`);
          }
          if (c.type === 'pr_approvals' && (!Number.isInteger(c.min) || c.min < 1 || c.min > 20)) {
            addR(`${at}.min`, 'approvals must be a whole number from 1 to 20');
          }
          if (c.type === 'azure_pipeline_succeeded' && c.pipeline.trim() === '') {
            addR(`${at}.pipeline`, 'name the pipeline');
          }
          if (c.type === 'jira_fields_set' && c.fields.length === 0) {
            addR(`${at}.fields`, 'name at least one field');
          }
          if (c.label !== undefined && c.label.trim() === '')
            addR(`${at}.label`, 'the label is empty');
        });
        if (conditions.length > 10) addR('.conditions', 'at most 10 conditions');
        // Rule 13: conditions are bounded by a timeout, then a person.
        if (conditions.length > 0 && r.condition_timeout === undefined) {
          addR('.condition_timeout', 'conditions need a timeout (how long to wait for them)');
        }
        if (r.condition_timeout !== undefined) {
          const p = durationProblem(r.condition_timeout);
          if (p !== null) addR('.condition_timeout', p);
        }
        if (r.condition_poll !== undefined) {
          const p = durationProblem(r.condition_poll);
          if (p !== null) addR('.condition_poll', p);
        }
        if (requiresAnything(r) && t.on_unmet === undefined) {
          add('.on_unmet', 'requirements need a "when not met"');
        }
      }

      const u = t.on_unmet;
      if (u !== undefined) {
        const ub = '.on_unmet';
        if (!has(def, u.goto)) add(`${ub}.goto`, `"back to" column "${u.goto}" does not exist`);
        else if (def.states[u.goto]?.type === 'terminal') {
          add(`${ub}.goto`, '"back to" cannot be a final column');
        }
        if (!has(def, u.else)) add(`${ub}.else`, `"then" column "${u.else}" does not exist`);
        else if (typeOf(u.else) !== 'human') add(`${ub}.else`, '"then" must be a human column');
        if (!Number.isInteger(u.retries) || u.retries < 0 || u.retries > 10) {
          add(`${ub}.retries`, 'retries must be a whole number from 0 to 10');
        }
        if (u.instruction !== undefined && u.instruction.trim() === '') {
          add(`${ub}.instruction`, 'the instruction is empty');
        }
      }
    }
  }
  return issues;
}
