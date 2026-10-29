import {
  CONDUCTOR_WORKFLOW_ID,
  RETURN_TO,
  WorkflowDefinitionSchema,
  type OnUnmet,
  type TransitionActor,
  type WorkflowDefinition,
  type WorkflowState,
} from './schema.js';
import { PR_CONTEXT_KEY, REVIEW_CONTEXT_KEY, STEP_CONTEXT_KEY } from '../engine/review.js';
import { isToolAlias, TOOL_ALIAS_NAMES } from './tools.js';
import {
  FALLBACK_TRANSITION_NAMES,
  isCountedTransition,
  transitionActor,
  transitionObject,
} from './transition-rules.js';
import { checkTransitions } from './validate-transitions.js';

// Workflow validation on save (M1-T03, 05 §Validation on save). The schema (T12) checks shape;
// this adds the graph rules. Consumers: T08 (save/list → 400 with `errors`).
//
// The graph is the explicit `on` transitions only: an outcome's string target, or an object
// transition's `goto` and `else`, and the `on_unmet` legs of its requirements. Implicit routes (a
// human state's `answered` → return_to, a `$return_to` goto, a failed guard or budget.exceeded →
// needs_input, the UI's "skip to <state>") are not edges, except that `on_budget_exceeded` counts
// as reachable (budget can trip in any state).

/**
 * Rule numbers from 05 §Validation on save (1–6) plus rule 7 (unknown tool alias), rule 8
 * (requirements gates, ADR-0009), rule 9 (entry requirements and columns, ADR-0010) and rules
 * 10–14 (transitions, ADR-0011), 15–16 (review and merge, ADR-0020) and 17 (a PR reaches Done
 * only through a human, M2-T34), in `validate-transitions.ts`.
 */
export type WorkflowRule =
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;

export interface WorkflowValidationError {
  rule: WorkflowRule;
  /** JSON path into the definition, e.g. `['states', 'build', 'on', 'fail', 'goto']`. */
  path: (string | number)[];
  message: string;
}

export type WorkflowValidationResult =
  { ok: true; def: WorkflowDefinition } | { ok: false; errors: WorkflowValidationError[] };

interface Edge {
  from: string;
  to: string;
  outcome: string;
  /** Where the target is written (for error paths). */
  path: (string | number)[];
  /** Counts toward rule 4: the edge is capped or gated (see `isBoundedEdge`). */
  bounded: boolean;
  /** Who takes the transition (`transitionActor`); `system` for an `entry` leg. */
  actor: TransitionActor;
  /** Rule 5: taking it completes an agent state with its result. */
  completes: boolean;
}

const REF_RE = /^\$([^.\s]+)\.([^.\s]+)$/;

type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][] };

/**
 * Zod reports a transition that is neither a string nor a valid object as one `invalid_union`
 * issue at the transition. Descend into the object branch so the path points at the bad field
 * (`states.implement.on.done.requirements.on_unmet.retries`), which the web editor maps to the
 * edge and the field (ADR-0009). The string branch's lone "expected string" is dropped.
 */
function flattenIssue(issue: Issue, prefix: PropertyKey[] = []): Issue[] {
  const path = [...prefix, ...issue.path];
  if (issue.code !== 'invalid_union' || !issue.errors) return [{ ...issue, path }];
  const branches = issue.errors.filter(
    (b) => !(b.length === 1 && b[0]!.code === 'invalid_type' && b[0]!.path.length === 0),
  );
  if (branches.length !== 1) return [{ ...issue, path }];
  return branches[0]!.flatMap((i) => flattenIssue(i, path));
}

/** Parse a workflow definition and check rules 1–16. Never throws. */
export function validateWorkflow(input: unknown): WorkflowValidationResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: (parsed.error.issues as Issue[])
        .flatMap((i) => flattenIssue(i))
        .map((i) => ({
          rule: 1,
          path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
          message: i.message,
        })),
    };
  }
  const def = parsed.data;
  const errors: WorkflowValidationError[] = [];
  const names = Object.keys(def.states);
  const has = (name: string) => Object.prototype.hasOwnProperty.call(def.states, name);
  const edges = collectEdges(def);

  // Rule 1: start and every target exist.
  if (!has(def.start)) {
    errors.push({ rule: 1, path: ['start'], message: `start state "${def.start}" does not exist` });
  }
  if (!has(def.on_budget_exceeded)) {
    errors.push({
      rule: 1,
      path: ['on_budget_exceeded'],
      message: `on_budget_exceeded target "${def.on_budget_exceeded}" does not exist`,
    });
  }
  for (const e of edges) {
    if (!has(e.to)) {
      errors.push({
        rule: 1,
        path: e.path,
        message: `state "${e.from}" outcome "${e.outcome}" targets unknown state "${e.to}"`,
      });
    }
  }

  // Rules 6 and 7 are per-state and don't need a sound graph.
  for (const [name, state] of Object.entries(def.states)) {
    if (state.type === 'event' && state.release_machine === true && state.timeout === undefined) {
      errors.push({
        rule: 6,
        path: ['states', name, 'timeout'],
        message: `event state "${name}" sets release_machine and needs a timeout`,
      });
    }
    if (state.type === 'agent') {
      (state.tools ?? []).forEach((tool, i) => {
        if (!isToolAlias(tool)) {
          errors.push({
            rule: 7,
            path: ['states', name, 'tools', i],
            message: `agent state "${name}" uses unknown tool "${tool}" (known: ${TOOL_ALIAS_NAMES.join(', ')})`,
          });
        }
      });
    }
  }

  errors.push(...checkGates(def, has));
  errors.push(...checkEntry(def, has));
  errors.push(...checkTransitions(def, has));

  // Graph rules 2–5 only on a graph whose start and targets all exist, so a missing target
  // reports once (rule 1) instead of cascading into unreachable/dead-end noise.
  if (!errors.some((e) => e.rule === 1)) {
    errors.push(...checkReachable(def, names, edges));
    errors.push(...checkCanFinish(def, names, edges));
    errors.push(...checkLoopsBounded(names, edges));
    errors.push(...checkRefs(def, edges));
  }

  return errors.length === 0 ? { ok: true, def } : { ok: false, errors };
}

/**
 * Rule 8 (ADR-0009, requirements gates). The schema already bounds `items` (1–30, non-blank) and
 * `on_unmet.retries` (0–10), and rule 1 checks that `on_unmet.goto` / `else` exist. Here:
 * - a gate only on transitions out of `agent` and `command` states;
 * - `on_unmet.else` is a `human` state (every failure path ends at a human);
 * - no state is named REVIEW_CONTEXT_KEY (the review step is stored under it in `context`).
 * Paths point into the transition (`states.<from>.on.<outcome>.requirements…`) for the editor.
 */
function checkGates(
  def: WorkflowDefinition,
  has: (name: string) => boolean,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  for (const reserved of [REVIEW_CONTEXT_KEY, STEP_CONTEXT_KEY, PR_CONTEXT_KEY]) {
    if (has(reserved)) {
      errors.push({
        rule: 8,
        path: ['states', reserved],
        message: `"${reserved}" is a reserved name`,
      });
    }
  }
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [outcome, t] of Object.entries(state.on ?? {})) {
      if (typeof t === 'string' || t.requirements === undefined) continue;
      const base = ['states', from, 'on', outcome, 'requirements'];
      if (state.type !== 'agent' && state.type !== 'command') {
        errors.push({
          rule: 8,
          path: base,
          message: `requirements are only allowed on transitions out of agent and command states ("${from}" is ${state.type})`,
        });
      }
      const otherwise = t.requirements.on_unmet.else;
      const target = has(otherwise) ? def.states[otherwise] : undefined;
      if (target !== undefined && target.type !== 'human') {
        errors.push({
          rule: 8,
          path: [...base, 'on_unmet', 'else'],
          message: `requirements on_unmet.else "${otherwise}" must be a human state (it is ${target.type})`,
        });
      }
    }
  }
  return errors;
}

/**
 * Rule 9 (ADR-0010, entry requirements and the board's columns). The schema already bounds
 * `on_unmet.retries` (0–10), the check and item counts, and requires at least one check, review or
 * action; rule 1 checks that `on_unmet.goto` / `else` exist. Here:
 * - `columns` names existing states, each once; the `conductor` workflow has `columns` listing
 *   every state (its states are the board's columns);
 * - no `entry` on the start state: it is entered when a machine claims the ticket, not by an
 *   outcome, so there is nothing to check yet and no source column to wait in;
 * - no `entry` on a `human` state: failure paths must reach a human unconditionally;
 * - `on_unmet.else` is a `human` state; `on_unmet.goto` has no `entry` of its own (no nested
 *   steps; it also can't be the state being entered);
 * - check commands are not blank; check names and actions are unique.
 */
function checkEntry(
  def: WorkflowDefinition,
  has: (name: string) => boolean,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const err = (path: (string | number)[], message: string) =>
    errors.push({ rule: 9, path, message });

  if (def.columns !== undefined) {
    const seen = new Set<string>();
    def.columns.forEach((name, i) => {
      if (!has(name)) err(['columns', i], `column "${name}" is not a state`);
      else if (seen.has(name)) err(['columns', i], `column "${name}" is listed twice`);
      seen.add(name);
    });
  }
  if (def.id === CONDUCTOR_WORKFLOW_ID) {
    if (def.columns === undefined) {
      err(
        ['columns'],
        `the ${CONDUCTOR_WORKFLOW_ID} workflow needs "columns" (its states are the board's columns)`,
      );
    } else {
      const missing = Object.keys(def.states).filter((n) => !def.columns!.includes(n));
      if (missing.length > 0) {
        err(['columns'], `every state is a column: add ${missing.map((m) => `"${m}"`).join(', ')}`);
      }
    }
  }

  for (const [name, state] of Object.entries(def.states)) {
    const entry = state.entry;
    if (entry === undefined) continue;
    const base = ['states', name, 'entry'];
    if (name === def.start) {
      err(
        base,
        `the start column "${name}" is entered by a claim, not an outcome, so entry requirements would never run`,
      );
    }
    if (state.type === 'human') {
      err(
        base,
        `human state "${name}" can't have entry requirements (failure paths must reach a human unconditionally)`,
      );
    }
    const otherwise = entry.on_unmet.else;
    const elseState = has(otherwise) ? def.states[otherwise] : undefined;
    if (elseState !== undefined && elseState.type !== 'human') {
      err(
        [...base, 'on_unmet', 'else'],
        `entry on_unmet.else "${otherwise}" must be a human state (it is ${elseState.type})`,
      );
    }
    const back = entry.on_unmet.goto;
    const gotoState = has(back) ? def.states[back] : undefined;
    if (gotoState?.entry !== undefined) {
      err(
        [...base, 'on_unmet', 'goto'],
        back === name
          ? `entry on_unmet.goto can't be "${name}" itself`
          : `entry on_unmet.goto "${back}" has entry requirements of its own`,
      );
    }
    const names = new Set<string>();
    (entry.checks ?? []).forEach((c, i) => {
      if (c.cmd.trim() === '')
        err([...base, 'checks', i, 'cmd'], `check "${c.name}" has an empty command`);
      if (names.has(c.name))
        err([...base, 'checks', i, 'name'], `check "${c.name}" is listed twice`);
      names.add(c.name);
    });
    if (entry.setup !== undefined && (entry.checks ?? []).length === 0) {
      err([...base, 'setup'], `entry setup runs before the checks: "${name}" has no checks`);
    }
    const actions = new Set<string>();
    (entry.actions ?? []).forEach((a, i) => {
      if (actions.has(a)) err([...base, 'actions', i], `action "${a}" is listed twice`);
      actions.add(a);
    });
  }
  return errors;
}

function collectEdges(def: WorkflowDefinition): Edge[] {
  const edges: Edge[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    // ADR-0010: a state's entry requirements route back (`on_unmet.goto`, counted) or to a human
    // (`else`). Modelled as edges out of the state being entered.
    if (state.entry !== undefined) {
      const unmet = ['states', from, 'entry', 'on_unmet'];
      const common = { from, actor: 'system' as const, completes: false, bounded: true };
      edges.push({
        ...common,
        to: state.entry.on_unmet.goto,
        outcome: 'entry:unmet',
        path: [...unmet, 'goto'],
      });
      edges.push({
        ...common,
        to: state.entry.on_unmet.else,
        outcome: 'entry:else',
        path: [...unmet, 'else'],
      });
      for (const [reason, to] of Object.entries(state.entry.on_unmet.routes ?? {})) {
        edges.push({ ...common, to, outcome: 'entry:unmet', path: [...unmet, 'routes', reason] });
      }
    }
    if (state.type === 'terminal') continue;
    for (const [outcome, raw] of Object.entries(state.on ?? {})) {
      const base = ['states', from, 'on', outcome];
      const t = transitionObject(raw);
      const actor = transitionActor(def, from, outcome, raw);
      // Rule 5: the agent finished the state with its result (not a question, not a fallback).
      const completes =
        state.type === 'agent' &&
        actor === 'agent' &&
        t.question !== true &&
        !FALLBACK_TRANSITION_NAMES.includes(outcome);
      const plain = isBoundedEdge(state, outcome, actor);
      const push = (to: string, path: (string | number)[], bounded: boolean) => {
        // ADR-0011: `$return_to` is not an edge (like a human's `answered` route); rule 10 checks
        // where it may appear.
        if (to === RETURN_TO) return;
        edges.push({ from, to, outcome, path, bounded, actor, completes });
      };
      // The goto leg carries a `"<from>-><goto>"` retry counter only when the transition is a
      // counted failure loop (05 §Counting, `isCountedTransition`).
      push(
        t.goto,
        typeof raw === 'string' ? base : [...base, 'goto'],
        isCountedTransition(raw) || plain,
      );
      if (t.else !== undefined) push(t.else, [...base, 'else'], plain);
      // ADR-0009 gate and ADR-0011 `requires`: the unmet loop is capped by on_unmet.retries (its
      // counter, `requirements:<from>:<name>` / `move:<from>:<name>`); its else leg ends at a human
      // (rules 8, 13) but is not itself bounded.
      const legs: [string[], OnUnmet | undefined][] = [
        [['requirements', 'on_unmet'], t.requirements?.on_unmet],
        [['on_unmet'], t.on_unmet],
      ];
      for (const [key, unmet] of legs) {
        if (unmet === undefined) continue;
        push(unmet.goto, [...base, ...key, 'goto'], true);
        push(unmet.else, [...base, ...key, 'else'], plain);
        // ADR-0020: a routed unmet reason shares the goto leg's counter.
        for (const [reason, to] of Object.entries(unmet.routes ?? {})) {
          push(to, [...base, ...key, 'routes', reason], true);
        }
      }
    }
  }
  return edges;
}

/**
 * Rule 4 interpretation (05 §Retry loops, §Counting): a loop is bounded when it takes
 * - a counted transition's `goto` leg (`isCountedTransition`: `attach`, `retries` or `else`): it
 *   has a retry counter `"<from>-><goto>"`, capped at `retries`, or at `budget.max_loop_retries`;
 * - a requirements `on_unmet.goto` leg: its counter is capped at `on_unmet.retries`; so is an
 *   `on_unmet.routes` leg (ADR-0020), which shares that counter;
 * - an edge out of a `human` state, or a human-actor transition (ADR-0011): a person decides each
 *   iteration;
 * - an `event` state's edge on one of its `wait_for` events (not `timeout`): an external actor
 *   triggers each iteration (pr_flow's `pr.changes_requested` → implement).
 * Plain transitions between automatic states (a state name, or an object with only ADR-0011
 * fields, `requires` or ADR-0009 `requirements`), and `else` legs, are not. A cycle made only of
 * those is an unbudgeted loop.
 */
function isBoundedEdge(state: WorkflowState, outcome: string, actor: TransitionActor): boolean {
  if (state.type === 'human' || actor === 'human') return true;
  if (state.type === 'event') return state.wait_for.includes(outcome);
  return false;
}

function adjacency(names: string[], edges: Edge[], keep: (e: Edge) => boolean = () => true) {
  const adj = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of edges) if (keep(e)) adj.get(e.from)?.push(e.to);
  return adj;
}

function reachableFrom(roots: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) ?? []) stack.push(m);
  }
  return seen;
}

// Rule 2: every state is reachable from start (or is the on_budget_exceeded target).
function checkReachable(
  def: WorkflowDefinition,
  names: string[],
  edges: Edge[],
): WorkflowValidationError[] {
  const seen = reachableFrom([def.start, def.on_budget_exceeded], adjacency(names, edges));
  return names
    .filter((n) => !seen.has(n))
    .map((n) => ({
      rule: 2 as const,
      path: ['states', n],
      message: `state "${n}" is unreachable from start "${def.start}"`,
    }));
}

// Rule 3: every state can reach a terminal or human state.
function checkCanFinish(
  def: WorkflowDefinition,
  names: string[],
  edges: Edge[],
): WorkflowValidationError[] {
  const reverse = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of edges) reverse.get(e.to)?.push(e.from);
  const sinks = names.filter((n) => {
    const t = def.states[n]!.type;
    return t === 'terminal' || t === 'human';
  });
  const ok = reachableFrom(sinks, reverse);
  return names
    .filter((n) => !ok.has(n))
    .map((n) => ({
      rule: 3 as const,
      path: ['states', n],
      message: `state "${n}" can't reach a terminal or human state (dead end)`,
    }));
}

// Rule 4: no cycle made only of unbounded edges. Any such cycle lies inside one strongly
// connected component of the unbounded-edge graph, so report each non-trivial SCC once.
function checkLoopsBounded(names: string[], edges: Edge[]): WorkflowValidationError[] {
  const unbounded = edges.filter((e) => !e.bounded);
  const adj = adjacency(names, unbounded);
  const errors: WorkflowValidationError[] = [];
  for (const scc of stronglyConnected(names, adj)) {
    const selfLoop = scc.length === 1 && (adj.get(scc[0]!) ?? []).includes(scc[0]!);
    if (scc.length < 2 && !selfLoop) continue;
    const members = new Set(scc);
    const inLoop = unbounded.filter((e) => members.has(e.from) && members.has(e.to));
    errors.push({
      rule: 4,
      path: ['states', scc[0]!],
      message:
        `unbudgeted loop through ${scc.map((s) => `"${s}"`).join(', ')}: no transition on it ` +
        `has a retry counter ({goto, retries?}) or waits on a human/external event ` +
        `(edges: ${inLoop.map((e) => `${e.from} -${e.outcome}-> ${e.to}`).join(', ')})`,
    });
  }
  return errors;
}

/** Tarjan's SCCs, iterative. Components come out in a deterministic order. */
function stronglyConnected(names: string[], adj: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const root of names) {
    if (index.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succ = adj.get(frame.node) ?? [];
      if (frame.next < succ.length) {
        const m = succ[frame.next++]!;
        if (!index.has(m)) {
          index.set(m, counter);
          low.set(m, counter++);
          stack.push(m);
          onStack.add(m);
          work.push({ node: m, next: 0 });
        } else if (onStack.has(m)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(m)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = [];
        let m: string;
        do {
          m = stack.pop()!;
          onStack.delete(m);
          comp.push(m);
        } while (m !== frame.node);
        out.push(comp.reverse());
      }
    }
  }
  return out;
}

// Rule 5: an input `$state.key` names an agent state that lists `key` in `result`, and that state
// has completed (`done`, or another completing agent transition, ADR-0011) on every path from
// start to the referencing state. Checked as: with the producer's completing edges and every
// human-actor edge removed, the referencing state is unreachable from start.
function checkRefs(def: WorkflowDefinition, edges: Edge[]): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const names = Object.keys(def.states);
  for (const [name, state] of Object.entries(def.states)) {
    if (state.type !== 'agent') continue;
    for (const [key, value] of Object.entries(state.input ?? {})) {
      if (typeof value !== 'string' || !value.startsWith('$')) continue;
      const path = ['states', name, 'input', key];
      const err = (message: string) => errors.push({ rule: 5, path, message });
      const m = REF_RE.exec(value);
      if (!m) {
        err(`input "${key}" ref "${value}" is malformed (expected "$<state>.<result key>")`);
        continue;
      }
      const [, src, field] = m as unknown as [string, string, string];
      const producer = Object.prototype.hasOwnProperty.call(def.states, src)
        ? def.states[src]
        : undefined;
      if (!producer) {
        err(`input "${key}" refs unknown state "${src}"`);
        continue;
      }
      if (producer.type !== 'agent' || !(producer.result ?? []).includes(field)) {
        err(
          `input "${key}" refs "${src}.${field}", but state "${src}" has no result key "${field}"`,
        );
        continue;
      }
      // ADR-0011: the producer completes on any of its completing transitions (`done`, or a named
      // agent transition that is not a question); a human's move is an operator override, like
      // "skip to", and not a path the ref must hold on (an unresolved ref renders "(missing)").
      const withoutDone = adjacency(
        names,
        edges,
        (e) => !(e.from === src && e.completes) && e.actor !== 'human',
      );
      if (reachableFrom([def.start], withoutDone).has(name)) {
        err(
          `input "${key}" refs "${src}.${field}", but some path from start reaches "${name}" ` +
            `without "${src}" completing first`,
        );
      }
    }
  }
  return errors;
}
