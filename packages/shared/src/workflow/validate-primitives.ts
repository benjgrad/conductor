import {
  conditionEnabled,
  instructionRef,
  MAX_DEFAULT_AFTER,
  MIN_DEFAULT_AFTER,
  NEVER_DEFAULTED,
  isFailureTarget,
  parseDuration,
  RETURN_TO,
  MIN_WATCH_POLL,
  type Condition,
  type ConditionType,
  type TransitionAction,
  type TransitionObject,
  type WorkflowDefinition,
  type WorkflowFeature,
  type WorkflowState,
} from './schema.js';
import { instructionFields } from './instructions.js';
import { transitionActor, transitionObject } from './transition-rules.js';
import type { WorkflowValidationError } from './validate.js';

// ADR-0037 §Validation on save: rules 19–25 for the workflow primitives P1–P8, and the
// "not available yet" refusals (rule 14) of the primitives, the actions and the condition types.
// Paths follow the existing style, so the editor maps an error to its field.

type Path = (string | number)[];

/** The longest `notify.coalesce` (rule 23). */
export const MAX_NOTIFY_COALESCE = '1d';

/** A list of conditions in the definition: a transition's `requires.conditions` or a `watch`. */
interface ConditionList {
  path: Path;
  conditions: readonly Condition[];
  inWatch: boolean;
}

function conditionLists(def: WorkflowDefinition): ConditionList[] {
  const lists: ConditionList[] = [];
  for (const [name, state] of Object.entries(def.states)) {
    if ((state.type === 'human' || state.type === 'event') && state.watch !== undefined) {
      lists.push({
        path: ['states', name, 'watch', 'conditions'],
        conditions: state.watch.conditions,
        inWatch: true,
      });
    }
    for (const t of transitionsOf(name, state)) {
      const conditions = t.t.requires?.conditions;
      if (conditions !== undefined) {
        lists.push({ path: [...t.base, 'requires', 'conditions'], conditions, inWatch: false });
      }
    }
  }
  return lists;
}

interface At {
  name: string;
  raw: Parameters<typeof transitionObject>[0];
  t: TransitionObject;
  base: Path;
}

function transitionsOf(from: string, state: WorkflowState): At[] {
  if (state.type === 'terminal') return [];
  return Object.entries(state.on ?? {}).map(([name, raw]) => ({
    name,
    raw,
    t: transitionObject(raw),
    base: ['states', from, 'on', name],
  }));
}

/** What a definition may use (rule 14). Omitted lists default to the AVAILABLE_* constants. */
export interface PrimitiveAvailability {
  actions: readonly TransitionAction[];
  conditions: readonly ConditionType[];
  features: readonly WorkflowFeature[];
}

/**
 * Rule 14 for transitions and the ADR-0037 primitives: an action, an enabled condition type or a
 * primitive that parses but isn't available yet is refused at its path.
 */
export function checkPrimitiveAvailability(
  def: WorkflowDefinition,
  available: PrimitiveAvailability,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const r14 = (path: Path, message: string) => errors.push({ rule: 14, path, message });
  const off = (f: WorkflowFeature) => !available.features.includes(f);

  if (def.instructions !== undefined && off('instructions')) {
    r14(['instructions'], 'instructions are not available yet');
  }
  if (def.notify !== undefined && off('notify_policy')) {
    r14(['notify'], 'the notify policy is not available yet');
  }
  for (const [name, state] of Object.entries(def.states)) {
    if ((state.type === 'human' || state.type === 'event') && state.watch !== undefined) {
      if (off('watch')) r14(['states', name, 'watch'], 'watch is not available yet');
    }
    for (const { t, base } of transitionsOf(name, state)) {
      (t.requires?.actions ?? []).forEach((a, i) => {
        if (!available.actions.includes(a)) {
          r14([...base, 'requires', 'actions', i], `action "${a}" is not available yet`);
        }
      });
      if (t.requires?.concurrency !== undefined && off('concurrency')) {
        r14([...base, 'requires', 'concurrency'], 'concurrency is not available yet');
      }
      if (t.presets !== undefined && off('instructions')) {
        r14([...base, 'presets'], 'presets are not available yet');
      }
      if (typeof t.notify === 'string' && off('notify_policy')) {
        r14([...base, 'notify'], `notify "${t.notify}" is not available yet`);
      }
      if (t.handoff === true && off('handoff')) {
        r14([...base, 'handoff'], 'handoff is not available yet');
      }
      if (t.requires?.parallel !== undefined && off('parallel')) {
        r14([...base, 'requires', 'parallel'], 'parallel legs are not available yet');
      }
      if (t.default !== undefined && off('default_answer')) {
        r14([...base, 'default'], 'default answers are not available yet');
      }
    }
  }
  if (off('instructions')) {
    for (const [path, text] of instructionFields(def)) {
      if (instructionRef(text) !== null) r14(path, 'instruction refs are not available yet');
    }
  }
  for (const list of conditionLists(def)) {
    list.conditions.forEach((c, i) => {
      if (conditionEnabled(c) && !available.conditions.includes(c.type)) {
        r14(
          [...list.path, i],
          `condition "${c.type}" is not available yet (declare it with "enabled": false)`,
        );
      }
      if (c.type === 'pr_checks_green' && c.no_checks !== undefined && off('no_checks')) {
        r14([...list.path, i, 'no_checks'], 'the no_checks policy is not available yet');
      }
    });
  }
  return errors;
}

/**
 * Rules 19–25 (ADR-0037 §Validation on save). A missing `goto` / `else` target is rule 1's (the
 * watch legs are edges, `collectEdges`), so these skip what they can't judge.
 * - 19 watch: `poll` ≥ MIN_WATCH_POLL; `on_broken.goto` is not the watched state and has no
 *   `entry`; `on_broken.else` is a human state; `return_to` is `$self` or an existing state;
 *   `cmd` condition names are unique within the watch.
 * - 20 concurrency: only on an agent-actor transition; `scope` names existing non-terminal
 *   states, each once (`hold_timeout` is required by the schema, `on_unmet` by rule 13).
 * - 21 instructions: every `$instructions.<slug>` ref and every `presets` slug names a key of
 *   `instructions`; `presets` only on a human-actor transition with `text`.
 * - 22 hand-off: not with `question: true`; only into a human state.
 * - 23 notify: a string value (`inherit` / `once` / `every` / `never`) needs the workflow `notify`
 *   block (without it only the legacy boolean means anything);
 *   `coalesce` ≤ MAX_NOTIFY_COALESCE.
 * - 24 placement: `age_below` only inside a watch. (`cmd` needs a repo; every ticket has one
 *   today, so there is nothing to refuse yet.)
 * - 25 no-CI: `no_checks` and `no_checks_after` are not both set.
 *
 * And ADR-0041's rule 31 (default answers): `default` only on an agent-actor transition that asks
 * (`question: true`, or `ask_user`) into a human state, without `handoff` or `requires`, never on
 * NEVER_DEFAULTED, with MIN_DEFAULT_AFTER ≤ `after` ≤ MAX_DEFAULT_AFTER.
 */
export function checkPrimitives(
  def: WorkflowDefinition,
  has: (name: string) => boolean,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const err = (rule: WorkflowValidationError['rule'], path: Path, message: string) =>
    errors.push({ rule, path, message });
  const stateOf = (name: string) => (has(name) ? def.states[name] : undefined);
  const slugs = new Set(Object.keys(def.instructions ?? {}));

  // Rule 23: the workflow block.
  const coalesce = def.notify?.coalesce;
  if (coalesce !== undefined && parseDuration(coalesce) > parseDuration(MAX_NOTIFY_COALESCE)) {
    err(23, ['notify', 'coalesce'], `coalesce can be at most ${MAX_NOTIFY_COALESCE}`);
  }

  for (const [name, state] of Object.entries(def.states)) {
    // Rule 19.
    if ((state.type === 'human' || state.type === 'event') && state.watch !== undefined) {
      const at: Path = ['states', name, 'watch'];
      const w = state.watch;
      if (w.poll !== undefined && parseDuration(w.poll) < parseDuration(MIN_WATCH_POLL)) {
        err(19, [...at, 'poll'], `watch poll can be no shorter than ${MIN_WATCH_POLL}`);
      }
      const ob = w.on_broken;
      if ('goto' in ob) {
        const b: Path = [...at, 'on_broken'];
        if (ob.goto === name) {
          err(19, [...b, 'goto'], `on_broken.goto can't be "${name}", the watched state`);
        } else if (stateOf(ob.goto)?.entry !== undefined) {
          err(
            19,
            [...b, 'goto'],
            `on_broken.goto "${ob.goto}" has entry requirements of its own (no nested steps)`,
          );
        }
        const otherwise = stateOf(ob.else);
        if (otherwise !== undefined && !isFailureTarget(otherwise)) {
          err(
            19,
            [...b, 'else'],
            `on_broken.else "${ob.else}" must be a human or triage state (it is ${otherwise.type})`,
          );
        }
        if (ob.return_to !== undefined && ob.return_to !== '$self' && !has(ob.return_to)) {
          err(
            19,
            [...b, 'return_to'],
            `on_broken.return_to "${ob.return_to}" is neither "$self" nor a state`,
          );
        }
      }
      const cmdNames = new Set<string>();
      w.conditions.forEach((c, i) => {
        if (c.type !== 'cmd') return;
        if (cmdNames.has(c.name)) {
          err(19, [...at, 'conditions', i, 'name'], `cmd condition "${c.name}" is listed twice`);
        }
        cmdNames.add(c.name);
      });
    }

    for (const { name: tName, raw, t, base } of transitionsOf(name, state)) {
      const actor = transitionActor(def, name, tName, raw);
      // Rule 20.
      const conc = t.requires?.concurrency;
      if (conc !== undefined) {
        const at: Path = [...base, 'requires', 'concurrency'];
        if (actor !== 'agent') {
          err(20, at, `concurrency is only for an agent-actor transition (this one is ${actor})`);
        }
        const seen = new Set<string>();
        conc.scope.forEach((s, i) => {
          const target = stateOf(s);
          if (target === undefined) {
            err(20, [...at, 'scope', i], `concurrency scope "${s}" is not a state`);
          } else if (target.type === 'terminal') {
            err(20, [...at, 'scope', i], `concurrency scope "${s}" can't be a terminal state`);
          } else if (seen.has(s)) {
            err(20, [...at, 'scope', i], `concurrency scope "${s}" is listed twice`);
          }
          seen.add(s);
        });
      }
      // Rule 21: presets.
      if (t.presets !== undefined) {
        if (actor !== 'human' || t.text === undefined) {
          err(
            21,
            [...base, 'presets'],
            'presets are only for a human-actor transition with a text box ("text")',
          );
        }
        t.presets.forEach((slug, i) => {
          if (!slugs.has(slug)) {
            err(21, [...base, 'presets', i], `preset "${slug}" is not in instructions`);
          }
        });
      }
      // Rule 22.
      if (t.handoff === true) {
        if (t.question === true) {
          err(22, [...base, 'handoff'], 'a transition can hand off or ask a question, not both');
        }
        const target = t.goto === RETURN_TO ? 'not a state' : stateOf(t.goto)?.type;
        if (target !== undefined && target !== 'human') {
          err(
            22,
            [...base, 'handoff'],
            `a hand-off must go to a human state ("${t.goto}" is ${target})`,
          );
        }
      }
      // Rule 31 (ADR-0041).
      if (t.default !== undefined) {
        const at: Path = [...base, 'default'];
        if ((NEVER_DEFAULTED as readonly string[]).includes(tName)) {
          err(31, at, `"${tName}" always waits for a human: it can't take a default answer`);
        }
        if (actor !== 'agent') {
          err(
            31,
            at,
            `a default answer is only for an agent-actor question (this one is ${actor})`,
          );
        }
        if (t.question !== true && tName !== 'ask_user') {
          err(31, at, 'a default answer is only for a question ("question": true, or ask_user)');
        }
        if (t.handoff === true) err(31, at, 'a hand-off is not a question: no default answer');
        if (t.requires !== undefined) {
          err(31, at, 'a default answer is not allowed on a transition with requires');
        }
        const target = t.goto === RETURN_TO ? 'not a state' : stateOf(t.goto)?.type;
        if (target !== undefined && target !== 'human') {
          err(31, at, `a default answer needs a human target ("${t.goto}" is ${target})`);
        }
        const ms = parseDuration(t.default.after);
        if (ms < parseDuration(MIN_DEFAULT_AFTER) || ms > parseDuration(MAX_DEFAULT_AFTER)) {
          err(
            31,
            [...at, 'after'],
            `default.after must be between ${MIN_DEFAULT_AFTER} and ${MAX_DEFAULT_AFTER}`,
          );
        }
      }
      // Rule 23: transition modes.
      if (typeof t.notify === 'string' && def.notify === undefined) {
        err(
          23,
          [...base, 'notify'],
          `notify "${t.notify}" needs the workflow's notify policy (add a top-level "notify")`,
        );
      }
    }
  }

  // Rule 21: refs.
  for (const [path, text] of instructionFields(def)) {
    const ref = instructionRef(text);
    if (ref === null) continue;
    if (ref.slug === null) {
      err(21, path, `"${text}" is not a valid ref (expected "$instructions.<slug>")`);
    } else if (!slugs.has(ref.slug)) {
      err(21, path, `instruction "${ref.slug}" is not in instructions`);
    }
  }

  // Rules 24 and 25.
  for (const list of conditionLists(def)) {
    list.conditions.forEach((c, i) => {
      if (c.type === 'age_below' && !list.inWatch) {
        err(24, [...list.path, i], 'age_below is only allowed in a watch (the age is the stay)');
      }
      if (
        c.type === 'pr_checks_green' &&
        c.no_checks !== undefined &&
        c.no_checks_after !== undefined
      ) {
        err(
          25,
          [...list.path, i, 'no_checks'],
          'set no_checks or no_checks_after, not both (no_checks_after is the legacy spelling)',
        );
      }
    });
  }
  return errors;
}
