import type {
  RequirementsGate,
  StateType,
  Transition,
  WorkflowDefinition,
  WorkflowState,
} from '@conductor/shared';

// The workflow definition as a graph for the diagram, plus the pure edits the transition editor
// makes (ADR-0009): add / change / remove a requirements gate on one transition, and the client
// side of the gate validation rules.

export type TransitionObject = Exclude<Transition, string>;

/**
 * - `initial`: the UML initial pseudostate → `start`.
 * - `outcome`: one per outcome (`"build"`, or an object transition's `goto`).
 * - `else`: an object transition's `else` (retries exhausted), dashed.
 * - `unmet`: a gate's `on_unmet.goto` (requirements not met), dashed.
 * - `unmet-else`: a gate's `on_unmet.else`, dashed; only drawn when no other edge already joins
 *   the same two states (the `unmet` label names it anyway).
 */
export type EdgeKind = 'initial' | 'outcome' | 'else' | 'unmet' | 'unmet-else';

export interface GraphNode {
  id: string;
  kind: 'initial' | 'state' | 'terminal';
  /** The state's type (absent for the initial pseudostate). */
  type?: StateType;
  /** «agent», «command», … */
  stereotype?: string;
  /** Agent: model; command: cmd; connector: action(s); event: wait_for. */
  detail?: string;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** The outcome the edge belongs to (null for the initial edge). */
  outcome: string | null;
  /** Label lines (first = outcome name). */
  label: string[];
  /** Number of requirements, on the `outcome` edge of a gated transition. */
  gate?: number;
  dashed: boolean;
  /** Full sentence for `<title>` / aria-label. */
  title: string;
}

export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const INITIAL_ID = '__initial__';

export const transitionKey = (from: string, outcome: string) => `${from}\u0000${outcome}`;

/** `⟲ implement ×3, else needs_input` for an object transition with a failure policy. */
export function failurePolicy(def: WorkflowDefinition, t: TransitionObject): string | null {
  if (t.retries === undefined && t.else === undefined && t.attach === undefined) return null;
  const n = t.retries ?? def.budget.max_loop_retries;
  const parts = [`⟲ ${t.goto} ×${n}`];
  if (t.else !== undefined) parts.push(`else ${t.else}`);
  return parts.join(', ');
}

function stateDetail(state: WorkflowState): string | undefined {
  switch (state.type) {
    case 'agent':
      return state.model ?? (state.skill ? `skill: ${state.skill}` : undefined);
    case 'command':
      return state.cmd;
    case 'connector':
      return state.action ?? state.actions?.join(', ');
    case 'event':
      return state.wait_for.join(' | ');
    default:
      return undefined;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const gateBadge = (n: number) => `✓ ${plural(n, 'requirement')}`;

export function buildGraph(def: WorkflowDefinition): WorkflowGraph {
  const nodes: GraphNode[] = [{ id: INITIAL_ID, kind: 'initial' }];
  const edges: GraphEdge[] = [];
  const has = (name: string) => Object.prototype.hasOwnProperty.call(def.states, name);

  for (const [name, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') {
      nodes.push({ id: name, kind: 'terminal', type: 'terminal' });
      continue;
    }
    const detail = stateDetail(state);
    nodes.push({
      id: name,
      kind: 'state',
      type: state.type,
      stereotype: `«${state.type}»`,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  if (has(def.start)) {
    edges.push({
      id: 'initial',
      kind: 'initial',
      from: INITIAL_ID,
      to: def.start,
      outcome: null,
      label: [],
      dashed: false,
      title: `Start: ${def.start}`,
    });
  }

  const pending: GraphEdge[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [outcome, t] of Object.entries(state.on ?? {})) {
      const id = (kind: EdgeKind) => `${from}/${outcome}/${kind}`;
      if (typeof t === 'string') {
        edges.push({
          id: id('outcome'),
          kind: 'outcome',
          from,
          to: t,
          outcome,
          label: [outcome],
          dashed: false,
          title: `${from} → ${t} on ${outcome}`,
        });
        continue;
      }
      const policy = failurePolicy(def, t);
      const gate = t.requirements;
      edges.push({
        id: id('outcome'),
        kind: 'outcome',
        from,
        to: t.goto,
        outcome,
        label: policy ? [outcome, policy] : [outcome],
        ...(gate ? { gate: gate.items.length } : {}),
        dashed: false,
        title:
          `${from} → ${t.goto} on ${outcome}` +
          (policy ? ` (${outcome} ${policy})` : '') +
          (gate ? `, gated by ${plural(gate.items.length, 'requirement')}` : ''),
      });
      if (t.else !== undefined) {
        edges.push({
          id: id('else'),
          kind: 'else',
          from,
          to: t.else,
          outcome,
          label: [`${outcome}: else`],
          dashed: true,
          title: `${from} → ${t.else} when ${outcome} retries are exhausted`,
        });
      }
      if (gate) {
        const u = gate.on_unmet;
        edges.push({
          id: id('unmet'),
          kind: 'unmet',
          from,
          to: u.goto,
          outcome,
          label: [`unmet ×${u.retries}`],
          dashed: true,
          title:
            `Requirements for ${from} → ${t.goto} not met: back to ${u.goto} ` +
            `up to ${plural(u.retries, 'time')}, then ${u.else}`,
        });
        pending.push({
          id: id('unmet-else'),
          kind: 'unmet-else',
          from,
          to: u.else,
          outcome,
          label: [`unmet: else`],
          dashed: true,
          title: `${from} → ${u.else} when the ${from} → ${t.goto} requirements stay unmet`,
        });
      }
    }
  }
  for (const e of pending) {
    if (!edges.some((o) => o.from === e.from && o.to === e.to)) edges.push(e);
  }
  return { nodes, edges };
}

// ------------------------------------------------------------------ editing

export function getTransition(
  def: WorkflowDefinition,
  from: string,
  outcome: string,
): Transition | undefined {
  const state = def.states[from];
  if (!state || state.type === 'terminal') return undefined;
  return state.on?.[outcome];
}

export const gateTarget = (t: Transition) => (typeof t === 'string' ? t : t.goto);

/** Gates are allowed only on transitions out of agent and command states (ADR-0009). */
export function gateAllowed(def: WorkflowDefinition, from: string): boolean {
  const type = def.states[from]?.type;
  return type === 'agent' || type === 'command';
}

export const humanStates = (def: WorkflowDefinition) =>
  Object.entries(def.states)
    .filter(([, s]) => s.type === 'human')
    .map(([n]) => n);

/** A sensible new gate: back to the source agent (or the start), else the first human state. */
export function defaultGate(def: WorkflowDefinition, from: string): RequirementsGate {
  const humans = humanStates(def);
  const elseState = humans.includes('needs_input') ? 'needs_input' : (humans[0] ?? 'needs_input');
  return {
    items: [''],
    on_unmet: {
      goto: def.states[from]?.type === 'agent' ? from : def.start,
      retries: 2,
      else: elseState,
    },
  };
}

/**
 * Set (or with `null` remove) the gate on `from`/`outcome`. A string transition becomes
 * `{goto, requirements}`; removing the gate turns an object with nothing else left back into the
 * string form. Returns a new definition; the input is not modified.
 */
export function setGate(
  def: WorkflowDefinition,
  from: string,
  outcome: string,
  gate: RequirementsGate | null,
): WorkflowDefinition {
  const state = def.states[from];
  if (!state || state.type === 'terminal') throw new Error(`no state "${from}" with transitions`);
  const t = state.on?.[outcome];
  if (t === undefined) throw new Error(`state "${from}" has no outcome "${outcome}"`);
  let next: Transition;
  if (gate) {
    next = typeof t === 'string' ? { goto: t, requirements: gate } : { ...t, requirements: gate };
  } else if (typeof t === 'string') {
    next = t;
  } else {
    const rest: TransitionObject = { ...t };
    delete rest.requirements;
    next = Object.keys(rest).length === 1 ? rest.goto : rest;
  }
  return {
    ...def,
    states: { ...def.states, [from]: { ...state, on: { ...state.on, [outcome]: next } } },
  };
}

// ------------------------------------------------------------------ validation

export interface GateIssue {
  from: string;
  outcome: string;
  /** Dotted path into the definition, like the server's `details[].path`. */
  path: string;
  message: string;
}

/** ADR-0009's gate rules, checked before Save (the server checks them again). */
export function validateGates(def: WorkflowDefinition): GateIssue[] {
  const issues: GateIssue[] = [];
  const has = (name: string) => Object.prototype.hasOwnProperty.call(def.states, name);
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [outcome, t] of Object.entries(state.on ?? {})) {
      if (typeof t === 'string' || !t.requirements) continue;
      const gate = t.requirements;
      const base = `states.${from}.on.${outcome}.requirements`;
      const add = (path: string, message: string) =>
        issues.push({ from, outcome, path: `${base}${path}`, message });
      if (state.type !== 'agent' && state.type !== 'command') {
        add('', `requirements are only allowed on transitions out of agent and command states`);
      }
      if (gate.items.length === 0) add('.items', 'add at least one requirement');
      if (gate.items.length > 30) add('.items', 'at most 30 requirements');
      gate.items.forEach((item, i) => {
        if (item.trim() === '') add(`.items.${i}`, `requirement ${i + 1} is empty`);
        else if (item.length > 2_000) add(`.items.${i}`, `requirement ${i + 1} is too long`);
      });
      const u = gate.on_unmet;
      if (!has(u.goto)) add('.on_unmet.goto', `"go back to" state "${u.goto}" does not exist`);
      if (!has(u.else)) add('.on_unmet.else', `"then" state "${u.else}" does not exist`);
      else if (def.states[u.else]?.type !== 'human') {
        add('.on_unmet.else', `"then" state "${u.else}" must be a human state`);
      }
      if (!Number.isInteger(u.retries) || u.retries < 0 || u.retries > 10) {
        add('.on_unmet.retries', 'retries must be a whole number from 0 to 10');
      }
      if (u.instruction !== undefined && u.instruction.trim() === '') {
        add('.on_unmet.instruction', 'the instruction is empty');
      }
    }
  }
  return issues;
}

/**
 * The transition a server error path (`states.build.on.fail.goto`, dot-joined) points into, if
 * any. Outcome names can contain dots (`ui.approve`), so the longest known outcome wins.
 */
export function transitionForPath(
  def: WorkflowDefinition,
  path: string,
): { from: string; outcome: string } | null {
  if (!path.startsWith('states.')) return null;
  const rest = path.slice('states.'.length);
  for (const [from, state] of Object.entries(def.states)) {
    const prefix = `${from}.on.`;
    if (!rest.startsWith(prefix) || state.type === 'terminal') continue;
    const tail = rest.slice(prefix.length);
    const outcomes = Object.keys(state.on ?? {}).sort((a, b) => b.length - a.length);
    const outcome = outcomes.find((o) => tail === o || tail.startsWith(`${o}.`));
    if (outcome !== undefined) return { from, outcome };
  }
  return null;
}
