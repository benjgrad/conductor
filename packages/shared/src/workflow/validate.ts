import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowState } from './schema.js';
import { REVIEW_CONTEXT_KEY } from '../engine/review.js';
import { isToolAlias, TOOL_ALIAS_NAMES } from './tools.js';

// Workflow validation on save (M1-T03, 05 §Validation on save). The schema (T12) checks shape;
// this adds the graph rules. Consumers: T08 (save/list → 400 with `errors`).
//
// The graph is the explicit `on` transitions only: an outcome's string target, or an object
// transition's `goto` and `else`. Implicit routes (a human state's `answered` → return_to, a failed
// guard or budget.exceeded → needs_input, the UI's "skip to <state>") are not edges, except that
// `on_budget_exceeded` counts as reachable (budget can trip in any state).

/**
 * Rule numbers from 05 §Validation on save (1–6) plus rule 7 (unknown tool alias) and rule 8
 * (requirements gates, ADR-0009).
 */
export type WorkflowRule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

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

/** Parse a workflow definition and check rules 1–8. Never throws. */
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
  if (has(REVIEW_CONTEXT_KEY)) {
    errors.push({
      rule: 8,
      path: ['states', REVIEW_CONTEXT_KEY],
      message: `"${REVIEW_CONTEXT_KEY}" is a reserved name`,
    });
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

function collectEdges(def: WorkflowDefinition): Edge[] {
  const edges: Edge[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [outcome, t] of Object.entries(state.on ?? {})) {
      const base = ['states', from, 'on', outcome];
      if (typeof t === 'string') {
        edges.push({ from, to: t, outcome, path: base, bounded: isBoundedEdge(state, outcome) });
      } else {
        // The goto leg carries a retry counter: capped by `retries`, or max_loop_retries. ADR-0009:
        // except an object that only carries `requirements`, a plain forward transition.
        const gate = t.requirements;
        const plain =
          gate !== undefined &&
          t.attach === undefined &&
          t.retries === undefined &&
          t.else === undefined;
        edges.push({
          from,
          to: t.goto,
          outcome,
          path: [...base, 'goto'],
          bounded: plain ? isBoundedEdge(state, outcome) : true,
        });
        if (gate !== undefined) {
          // The unmet loop is capped by on_unmet.retries; its else leg ends at a human (rule 8).
          const unmet = [...base, 'requirements', 'on_unmet'];
          edges.push({
            from,
            to: gate.on_unmet.goto,
            outcome,
            path: [...unmet, 'goto'],
            bounded: true,
          });
          edges.push({
            from,
            to: gate.on_unmet.else,
            outcome,
            path: [...unmet, 'else'],
            bounded: isBoundedEdge(state, outcome),
          });
        }
        if (t.else !== undefined) {
          edges.push({
            from,
            to: t.else,
            outcome,
            path: [...base, 'else'],
            bounded: isBoundedEdge(state, outcome),
          });
        }
      }
    }
  }
  return edges;
}

/**
 * Rule 4 interpretation (05 §Retry loops): a loop is bounded when it takes
 * - an object transition's `goto` leg: it has a retry counter `"<from>-><goto>"`, capped at
 *   `retries`, or at `budget.max_loop_retries` when the transition doesn't set one;
 * - an edge out of a `human` state: a person decides each iteration;
 * - an `event` state's edge on one of its `wait_for` events (not `timeout`): an external actor
 *   triggers each iteration (pr_flow's `pr.changes_requested` → implement).
 * Plain string transitions between automatic states, and an object transition's `else` leg, are
 * not. A cycle made only of those is an unbudgeted loop.
 */
function isBoundedEdge(state: WorkflowState, outcome: string): boolean {
  if (state.type === 'human') return true;
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
// has completed (`done`) on every path from start to the referencing state. Checked as: with the
// producer's `done` edges removed, the referencing state is unreachable from start.
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
      const withoutDone = adjacency(names, edges, (e) => !(e.from === src && e.outcome === 'done'));
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
