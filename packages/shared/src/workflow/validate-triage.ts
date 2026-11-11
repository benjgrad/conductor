import {
  GATE,
  isTriageState,
  TRIAGE_TARGETS,
  type OnUnmet,
  type Transition,
  type WorkflowDefinition,
  type WorkflowState,
} from './schema.js';
import { isCountedTransition, transitionObject } from './transition-rules.js';
import type { WorkflowValidationError } from './validate.js';

// ADR-0043, rule 30: the triage role. A `role: 'triage'` agent state may be a failure leg's target
// (`on_unmet.goto` / `else`, an entry's, a watch's `on_broken`); it reads the evidence and picks a
// declared verdict. Its verdicts (and those of its "legs", e.g. a `fix_env` command reached only
// from triage) may name `$return_to` (back to the state that failed) and `$gate` (retry the move
// that failed). Every such verdict is a counted loop that ends at a human, so a cycle through
// triage is always bounded (rule 4 sees the pseudo-targets as the edges `triagePseudoEdges`).

type Path = (string | number)[];

/** True for `$return_to` / `$gate`. */
export function isTriageTarget(target: string): boolean {
  return TRIAGE_TARGETS.includes(target);
}

/** Every `(from, to, via-entry-of)` route of the definition, pseudo-targets left out. */
interface Route {
  from: string;
  to: string;
  /** Set on an entry leg: the state being entered (the real source is whoever enters it). */
  entryOf?: string;
}

function routes(def: WorkflowDefinition): Route[] {
  const out: Route[] = [];
  const add = (from: string, to: string | undefined, entryOf?: string) => {
    if (to === undefined || isTriageTarget(to)) return;
    out.push(entryOf !== undefined ? { from, to, entryOf } : { from, to });
  };
  const addUnmet = (from: string, u: OnUnmet | undefined, entryOf?: string) => {
    if (u === undefined) return;
    add(from, u.goto, entryOf);
    add(from, u.else, entryOf);
    for (const to of Object.values(u.routes ?? {})) add(from, to, entryOf);
  };
  for (const [from, state] of Object.entries(def.states)) {
    if (state.entry !== undefined) addUnmet(from, state.entry.on_unmet, from);
    if ((state.type === 'human' || state.type === 'event') && state.watch !== undefined) {
      const ob = state.watch.on_broken;
      if ('goto' in ob) {
        add(from, ob.goto);
        add(from, ob.else);
      }
    }
    if (state.type === 'terminal') continue;
    for (const raw of Object.values(state.on ?? {})) {
      const t = transitionObject(raw);
      add(from, t.goto);
      add(from, t.else);
      addUnmet(from, t.on_unmet);
      addUnmet(from, t.requirements?.on_unmet);
    }
  }
  return out;
}

/** The states that route into `name` (direct `on` targets only, the entered state's sources). */
function predecessors(all: Route[], name: string): string[] {
  return all.filter((r) => r.to === name && r.entryOf === undefined).map((r) => r.from);
}

/**
 * The states a triage state's `$return_to` / `$gate` can lead back to: whoever routed into it.
 * An entry leg's source is every state that enters the state with the entry (the failed move's
 * source), not the entered state itself.
 */
export function triageSources(def: WorkflowDefinition, triage: string): string[] {
  const all = routes(def);
  const out = new Set<string>();
  for (const r of all) {
    if (r.to !== triage || r.from === triage) continue;
    if (r.entryOf !== undefined) for (const p of predecessors(all, r.entryOf)) out.add(p);
    else out.add(r.from);
  }
  return [...out];
}

/**
 * The triage "legs": non-triage agent, command, connector or event states that are entered only
 * from triage states or other legs (e.g. the `fix_env` command of a triage verdict). They may name
 * `$return_to` / `$gate` too, because `context.__triage` is still set when they run. The greatest
 * fixpoint: start from every candidate, drop any with a source that is neither triage nor a leg.
 */
export function triageLegs(def: WorkflowDefinition): Set<string> {
  const all = routes(def);
  const triage = new Set(
    Object.entries(def.states)
      .filter(([, s]) => isTriageState(s))
      .map(([n]) => n),
  );
  const legs = new Set(
    Object.entries(def.states)
      .filter(
        ([n, s]) =>
          !triage.has(n) && s.type !== 'human' && s.type !== 'terminal' && n !== def.start,
      )
      .map(([n]) => n),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const leg of [...legs]) {
      const from = all.filter((r) => r.to === leg && r.from !== leg).map((r) => r.from);
      if (from.length === 0 || from.some((f) => !triage.has(f) && !legs.has(f))) {
        legs.delete(leg);
        changed = true;
      }
    }
  }
  return legs;
}

/** True when `$return_to` / `$gate` may appear on `name`'s transitions (a triage state or leg). */
export function mayNameTriageTargets(
  def: WorkflowDefinition,
  name: string,
  legs: Set<string> = triageLegs(def),
): boolean {
  return isTriageState(def.states[name]) || legs.has(name);
}

/** One edge a triage pseudo-target stands for. */
export interface PseudoEdge {
  from: string;
  to: string;
  outcome: string;
  path: Path;
  counted: boolean;
  raw: Transition;
}

/**
 * The graph edges `$return_to` / `$gate` stand for (rules 2–4): from a triage state, or a leg,
 * back to every source of a triage state (a leg's: of any triage state). A counted verdict's edge
 * is bounded; an uncounted one is not (rule 30 also refuses it).
 */
export function triagePseudoEdges(def: WorkflowDefinition): PseudoEdge[] {
  const triage = Object.keys(def.states).filter((n) => isTriageState(def.states[n]));
  if (triage.length === 0) return [];
  const legs = triageLegs(def);
  const sourcesOf = new Map(triage.map((t) => [t, triageSources(def, t)]));
  const anySource = [...new Set([...sourcesOf.values()].flat())];
  const out: PseudoEdge[] = [];
  for (const from of [...triage, ...legs]) {
    const state = def.states[from]!;
    if (state.type === 'terminal') continue;
    for (const [outcome, raw] of Object.entries(state.on ?? {})) {
      const t = transitionObject(raw);
      if (!isTriageTarget(t.goto)) continue;
      const path: Path = [
        'states',
        from,
        'on',
        outcome,
        ...(typeof raw === 'string' ? [] : ['goto']),
      ];
      for (const to of sourcesOf.get(from) ?? anySource) {
        out.push({ from, to, outcome, path, counted: isCountedTransition(raw), raw });
      }
    }
  }
  return out;
}

/**
 * Rule 30 (ADR-0043), the triage role:
 * - a triage state is not the start state, has no `entry`, `checkout` or `follow_ups`, and its
 *   `tools` are absent or exactly `["triage"]` (the engine always runs it with that alias);
 * - it is the target of at least one failure leg or route (else nothing ever triages);
 * - its transitions are plain agent verdicts: no `question`, `handoff`, `requires` or ADR-0009
 *   `requirements`; at least one goes to a human state (escalate);
 * - a `$return_to` / `$gate` verdict (on a triage state or a leg) is counted (`retries` or
 *   `else`), and its `else`, when set, is a human state;
 * - `$gate` appears nowhere else (`$return_to` elsewhere is rule 10's: a human state's answer
 *   route, refused on any other state that is not a triage state or a leg).
 */
export function checkTriage(
  def: WorkflowDefinition,
  has: (name: string) => boolean,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const err = (path: Path, message: string) => errors.push({ rule: 30, path, message });
  const stateOf = (name: string): WorkflowState | undefined =>
    has(name) ? def.states[name] : undefined;
  const legs = triageLegs(def);
  const entered = new Set(routes(def).map((r) => r.to));

  for (const [name, state] of Object.entries(def.states)) {
    const base: Path = ['states', name];
    if (isTriageState(state)) {
      if (name === def.start) {
        err(
          [...base, 'role'],
          `the start state "${name}" can't be a triage state (nothing failed yet)`,
        );
      }
      if (state.entry !== undefined) {
        err([...base, 'entry'], `triage state "${name}" can't have entry requirements`);
      }
      if (state.checkout !== undefined) {
        err([...base, 'checkout'], `triage state "${name}" reads the worktree: no checkout`);
      }
      if (state.follow_ups !== undefined) {
        err([...base, 'follow_ups'], `triage state "${name}" can't propose follow-up tickets`);
      }
      const tools = state.tools;
      if (tools !== undefined && (tools.length !== 1 || tools[0] !== 'triage')) {
        err([...base, 'tools'], `triage state "${name}" has the tools ["triage"] (or none)`);
      }
      if (!entered.has(name)) {
        err(base, `triage state "${name}" is no failure leg's target: nothing ever routes into it`);
      }
      let escalates = false;
      for (const [outcome, raw] of Object.entries(state.on ?? {})) {
        const t = transitionObject(raw);
        const at: Path = [...base, 'on', outcome];
        if (stateOf(t.goto)?.type === 'human') escalates = true;
        if (t.question === true) err([...at, 'question'], 'a triage verdict is not a question');
        if (t.handoff === true) err([...at, 'handoff'], 'a triage verdict is not a hand-off');
        if (t.requires !== undefined) {
          err([...at, 'requires'], 'a triage verdict has no requirements of its own');
        }
        if (t.requirements !== undefined) {
          err([...at, 'requirements'], 'a triage verdict has no requirements of its own');
        }
      }
      if (!escalates) {
        err(
          [...base, 'on'],
          `triage state "${name}" needs a verdict into a human state (escalate with a diagnosis)`,
        );
      }
    }
    if (state.type === 'terminal') continue;
    const may = mayNameTriageTargets(def, name, legs);
    for (const [outcome, raw] of Object.entries(state.on ?? {})) {
      const t = transitionObject(raw);
      if (!isTriageTarget(t.goto)) continue;
      const at: Path = [...base, 'on', outcome];
      const gotoAt: Path = typeof raw === 'string' ? at : [...at, 'goto'];
      if (!may) {
        // `$return_to` outside triage is rule 10's (a human state's answer route, else refused).
        if (t.goto === GATE) {
          err(
            gotoAt,
            `"${t.goto}" is only for a triage state ("role": "triage") and the states only it enters`,
          );
        }
        continue;
      }
      if (!isCountedTransition(raw)) {
        err(
          gotoAt,
          `a "${t.goto}" verdict loops back to the failed gate: count it ("retries" and an "else" human state)`,
        );
      }
      if (t.else !== undefined) {
        const otherwise = stateOf(t.else);
        if (otherwise !== undefined && otherwise.type !== 'human') {
          err(
            [...at, 'else'],
            `"${outcome}" else "${t.else}" must be a human state (it is ${otherwise.type})`,
          );
        }
      }
    }
  }
  return errors;
}
