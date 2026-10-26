import {
  CONDUCTOR_WORKFLOW_ID,
  type EntryCheck,
  type EntryRequirements,
  type OnUnmet,
  type WorkflowDefinition,
  type WorkflowState,
} from '@conductor/shared';
import { humanStates, validateGates } from './model.js';

export { humanStates };

// The one workflow as board columns (ADR-0010): each state is a column, left to right in
// `columns` order, after an implicit Queued column. Here: the lanes and the arrows between them,
// the "requirements to enter" summaries, the pure edits the column editor makes, and the client
// side of the entry validation rules.

/** State names the engine uses for its own context keys (ADR-0009 review, ADR-0010 entry step). */
export const RESERVED_STATE_NAMES = ['__review', '__entry'] as const;

/** The implicit first column (no state; sessions no machine has claimed yet). */
export const QUEUED_LANE = '__queued__';
export const QUEUED_TITLE = 'Queued';

/** Built-in prompt templates an agent state can name (free text is also allowed). */
export const PROMPT_TEMPLATES = ['plan_template', 'implement_template', 'ticket_template'] as const;

const has = (def: WorkflowDefinition, name: string) =>
  Object.prototype.hasOwnProperty.call(def.states, name);

/** State names in column order: `columns` first, then any state it leaves out (none are lost). */
export function columnStates(def: WorkflowDefinition): string[] {
  const listed = (def.columns ?? []).filter((n, i, all) => has(def, n) && all.indexOf(n) === i);
  return [...listed, ...Object.keys(def.states).filter((n) => !listed.includes(n))];
}

/** Lane ids left to right: Queued, then every state. */
export const laneIds = (def: WorkflowDefinition) => [QUEUED_LANE, ...columnStates(def)];

export function columnTitle(def: WorkflowDefinition, name: string): string {
  if (name === QUEUED_LANE) return QUEUED_TITLE;
  return def.states[name]?.title ?? name;
}

/** What does a column's work, in one line. */
export function workSummary(state: WorkflowState | null): string {
  if (state === null) return 'Waiting for a machine';
  switch (state.type) {
    case 'agent': {
      const what = state.prompt !== undefined ? state.prompt : `skill ${state.skill ?? ''}`;
      return `Agent · ${what} · ${state.model ?? 'default model'}`;
    }
    case 'command':
      return `Runs ${state.cmd}`;
    case 'connector':
      return `Connector · ${state.action ?? state.actions?.join(', ') ?? ''}`;
    case 'event':
      return `Waits for ${state.wait_for.join(' or ')}`;
    case 'human':
      return 'A person answers or approves';
    case 'terminal':
      return 'Final';
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const ACTION_LABELS: Record<string, string> = { open_pr: 'Opens PR' };

export interface EntrySummary {
  checks: string[];
  reviewItems: number;
  actions: string[];
  /** "Not met: back to Implementing ×3, then Needs input". */
  unmet: string;
}

export function entrySummary(def: WorkflowDefinition, entry: EntryRequirements): EntrySummary {
  const u = entry.on_unmet;
  return {
    checks: (entry.checks ?? []).map((c) => c.name),
    reviewItems: entry.review?.items.length ?? 0,
    actions: (entry.actions ?? []).map((a) => ACTION_LABELS[a] ?? a),
    unmet: `Not met: back to ${columnTitle(def, u.goto)} ×${u.retries}, then ${columnTitle(def, u.else)}`,
  };
}

/** The summary as lines for the lane ("Build passes", "2 review items", "Opens PR", …). */
export function entryLines(def: WorkflowDefinition, entry: EntryRequirements): string[] {
  const s = entrySummary(def, entry);
  return [
    ...s.checks.map((c) => `✓ ${c}`),
    ...(s.reviewItems > 0 ? [`◎ ${plural(s.reviewItems, 'review item')}`] : []),
    ...s.actions.map((a) => `↗ ${a}`),
    s.unmet,
  ];
}

/** One short line for compact diagrams: "2 checks · Opens PR". */
export function entryShort(entry: EntryRequirements): string {
  const parts: string[] = [];
  const checks = entry.checks?.length ?? 0;
  if (checks > 0) parts.push(plural(checks, 'check'));
  if (entry.review) parts.push(plural(entry.review.items.length, 'review item'));
  for (const a of entry.actions ?? []) parts.push(ACTION_LABELS[a] ?? a);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ graph

export interface Lane {
  id: string;
  title: string;
  /** null for Queued. */
  state: WorkflowState | null;
  work: string;
  entry: EntryRequirements | null;
}

/**
 * - `start`: Queued → the start state (a machine claims the ticket).
 * - `outcome`: every outcome from one column to another, merged per pair ("ask_user · timeout").
 * - `else`: an old object transition's `else` (retries exhausted), dashed.
 * - `unmet`: requirements to enter a column not met → back to `on_unmet.goto`, dashed. Also an
 *   old (ADR-0009) per-transition gate's unmet loop.
 */
export type LaneEdgeKind = 'start' | 'outcome' | 'else' | 'unmet';

export interface LaneEdge {
  id: string;
  kind: LaneEdgeKind;
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  /** Old per-transition gates on this arrow (read-only, ADR-0009), as a requirement count. */
  gate?: number;
  /** Full sentence for `<title>`. */
  title: string;
}

export interface LaneGraph {
  lanes: Lane[];
  edges: LaneEdge[];
}

export function buildLaneGraph(def: WorkflowDefinition): LaneGraph {
  const lanes: Lane[] = laneIds(def).map((id) => {
    const state = id === QUEUED_LANE ? null : (def.states[id] ?? null);
    return {
      id,
      title: columnTitle(def, id),
      state,
      work: workSummary(state),
      entry: state?.entry ?? null,
    };
  });
  const t = (n: string) => columnTitle(def, n);
  const edges: LaneEdge[] = [];
  if (has(def, def.start)) {
    edges.push({
      id: 'start',
      kind: 'start',
      from: QUEUED_LANE,
      to: def.start,
      label: 'claimed',
      dashed: false,
      title: `${QUEUED_TITLE} → ${t(def.start)} when a machine claims the ticket`,
    });
  }
  const merged = new Map<string, { outcomes: string[]; gate: number }>();
  const extra: LaneEdge[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [outcome, tr] of Object.entries(state.on ?? {})) {
      const to = typeof tr === 'string' ? tr : tr.goto;
      if (!has(def, to)) continue;
      const key = `${from}\u0000${to}`;
      const m = merged.get(key) ?? { outcomes: [], gate: 0 };
      m.outcomes.push(outcome);
      if (typeof tr !== 'string' && tr.requirements) m.gate += tr.requirements.items.length;
      merged.set(key, m);
      if (typeof tr === 'string') continue;
      if (tr.else !== undefined && has(def, tr.else)) {
        extra.push({
          id: `${from}/${outcome}/else`,
          kind: 'else',
          from,
          to: tr.else,
          label: `${outcome}: else`,
          dashed: true,
          title: `${t(from)} → ${t(tr.else)} when ${outcome} retries are exhausted`,
        });
      }
      const u = tr.requirements?.on_unmet;
      if (u && u.goto !== from && has(def, u.goto)) {
        extra.push({
          id: `${from}/${outcome}/unmet`,
          kind: 'unmet',
          from,
          to: u.goto,
          label: `unmet ×${u.retries}`,
          dashed: true,
          title: `Requirements for ${t(from)} → ${t(to)} not met: back to ${t(u.goto)}`,
        });
      }
    }
  }
  for (const [key, m] of merged) {
    const [from, to] = key.split('\u0000') as [string, string];
    edges.push({
      id: `${from}/${to}`,
      kind: 'outcome',
      from,
      to,
      label: m.outcomes.join(' · '),
      dashed: false,
      ...(m.gate > 0 ? { gate: m.gate } : {}),
      title: `${t(from)} → ${t(to)} on ${m.outcomes.join(' or ')}`,
    });
  }
  edges.push(...extra);
  for (const [name, state] of Object.entries(def.states)) {
    const u = state.entry?.on_unmet;
    if (!u || u.goto === name || !has(def, u.goto)) continue;
    edges.push({
      id: `${name}/entry/unmet`,
      kind: 'unmet',
      from: name,
      to: u.goto,
      label: `not met ×${u.retries}`,
      dashed: true,
      title:
        `Requirements to enter ${t(name)} not met: back to ${t(u.goto)} up to ` +
        `${plural(u.retries, 'time')}, then ${t(u.else)}`,
    });
  }
  return { lanes, edges };
}

// ------------------------------------------------------------------ editing

function updateState(
  def: WorkflowDefinition,
  name: string,
  fn: (s: WorkflowState) => WorkflowState,
): WorkflowDefinition {
  const state = def.states[name];
  if (!state) throw new Error(`no state "${name}"`);
  return { ...def, states: { ...def.states, [name]: fn(state) } };
}

/** Set the column title; blank removes it (the state name shows). */
export function setTitle(def: WorkflowDefinition, name: string, title: string): WorkflowDefinition {
  return updateState(def, name, (s) => {
    const next = { ...s };
    delete next.title;
    return title.trim() === '' ? next : { ...next, title };
  });
}

/** An agent column's prompt template and model (blank model = the account default). */
export function setAgentWork(
  def: WorkflowDefinition,
  name: string,
  work: { prompt?: string; model?: string },
): WorkflowDefinition {
  return updateState(def, name, (s) => {
    if (s.type !== 'agent') return s;
    const next = { ...s };
    if (work.prompt !== undefined) next.prompt = work.prompt;
    if (work.model !== undefined) {
      delete next.model;
      if (work.model.trim() !== '') next.model = work.model;
    }
    return next;
  });
}

/** The draft shape of `entry` while editing: lists may be empty; normalizeEntry tidies it. */
export interface EntryDraft {
  checks: EntryCheck[];
  reviewItems: string[];
  reviewModel?: string;
  openPr: boolean;
  on_unmet: OnUnmet;
}

export function entryDraft(def: WorkflowDefinition, name: string): EntryDraft {
  const e = def.states[name]?.entry;
  return {
    checks: e?.checks ?? [],
    reviewItems: e?.review?.items ?? [],
    ...(e?.review?.model !== undefined ? { reviewModel: e.review.model } : {}),
    openPr: e?.actions?.includes('open_pr') ?? false,
    on_unmet: e?.on_unmet ?? defaultUnmet(def, name),
  };
}

/**
 * The `entry` a draft stands for: empty lists are dropped, and with no check, review item or
 * action left there is no `entry` at all (null).
 */
export function normalizeEntry(d: EntryDraft): EntryRequirements | null {
  if (d.checks.length === 0 && d.reviewItems.length === 0 && !d.openPr) return null;
  return {
    ...(d.checks.length > 0 ? { checks: d.checks } : {}),
    ...(d.reviewItems.length > 0
      ? {
          review: {
            items: d.reviewItems,
            ...(d.reviewModel !== undefined && d.reviewModel.trim() !== ''
              ? { model: d.reviewModel }
              : {}),
          },
        }
      : {}),
    ...(d.openPr ? { actions: ['open_pr' as const] } : {}),
    on_unmet: d.on_unmet,
  };
}

/** Set (or with null remove) a state's requirements to enter. */
export function setEntry(
  def: WorkflowDefinition,
  name: string,
  entry: EntryRequirements | null,
): WorkflowDefinition {
  return updateState(def, name, (s) => {
    const next = { ...s };
    delete next.entry;
    return entry === null ? next : { ...next, entry };
  });
}

/**
 * A sensible new "when not met": back to the first agent column that moves into this one (else
 * the start), up to 2 times, then `needs_input` (else the first human column).
 */
export function defaultUnmet(def: WorkflowDefinition, name: string): OnUnmet {
  // A valid "back to" is never the column itself, nor a column with its own entry (rule 9).
  const candidates = columnStates(def).filter(
    (n) => n !== name && def.states[n]?.entry === undefined,
  );
  const agents = candidates.filter((n) => def.states[n]?.type === 'agent');
  const source =
    agents.find((n) => {
      const st = def.states[n];
      if (!st || st.type === 'terminal') return false;
      return Object.values(st.on ?? {}).some(
        (tr) => (typeof tr === 'string' ? tr : tr.goto) === name,
      );
    }) ??
    (candidates.includes(def.start) ? def.start : undefined) ??
    agents[0] ??
    candidates[0];
  const humans = humanStates(def);
  return {
    goto: source ?? def.start,
    retries: 2,
    else: humans.includes('needs_input') ? 'needs_input' : (humans[0] ?? 'needs_input'),
  };
}

// ------------------------------------------------------------------ validation

export interface ColumnIssue {
  /** The column (state) the problem belongs to, or null for the whole definition. */
  state: string | null;
  /** Dotted path into the definition, like the server's `details[].path`. */
  path: string;
  message: string;
}

/** ADR-0010's entry rules (and ADR-0009's for old gates), checked before Save. */
export function validateColumns(def: WorkflowDefinition): ColumnIssue[] {
  const issues: ColumnIssue[] = [];
  // Mirrors the server's rule 9 (shared workflow/validate.ts, ADR-0010) so problems show before Save.
  const seen = new Set<string>();
  (def.columns ?? []).forEach((n, i) => {
    const path = `columns.${i}`;
    if (!has(def, n)) issues.push({ state: null, path, message: `column "${n}" is not a state` });
    else if (seen.has(n)) issues.push({ state: n, path, message: `column "${n}" is listed twice` });
    seen.add(n);
  });
  if (def.id === CONDUCTOR_WORKFLOW_ID) {
    if (def.columns === undefined) {
      issues.push({
        state: null,
        path: 'columns',
        message: `the ${CONDUCTOR_WORKFLOW_ID} workflow needs "columns" (its states are the board's columns)`,
      });
    } else {
      const missing = Object.keys(def.states).filter((n) => !def.columns!.includes(n));
      if (missing.length > 0) {
        issues.push({
          state: null,
          path: 'columns',
          message: `every state is a column: add ${missing.map((m) => `"${m}"`).join(', ')}`,
        });
      }
    }
  }
  for (const reserved of RESERVED_STATE_NAMES) {
    if (has(def, reserved)) {
      issues.push({
        state: reserved,
        path: `states.${reserved}`,
        message: `"${reserved}" is a reserved name`,
      });
    }
  }
  for (const [name, state] of Object.entries(def.states)) {
    const base = `states.${name}`;
    const add = (path: string, message: string) =>
      issues.push({ state: name, path: `${base}${path}`, message });
    if (state.title !== undefined && state.title.trim() === '') add('.title', 'the title is empty');
    if (state.type === 'agent' && state.prompt !== undefined && state.prompt.trim() === '') {
      add('.prompt', 'choose a prompt template');
    }
    const e = state.entry;
    if (!e) continue;
    if (name === def.start) {
      // A claim, not an outcome, enters the start column, so nothing would check its entry.
      add('.entry', 'the first column cannot have requirements to enter (a claim enters it)');
      continue;
    }
    if (state.type === 'human') {
      // Failure paths must reach a human unconditionally.
      add('.entry', 'a human column cannot have requirements to enter');
      continue;
    }
    const checks = e.checks ?? [];
    if (checks.length + (e.review ? 1 : 0) + (e.actions?.length ?? 0) === 0) {
      add('.entry', 'add at least one check, review item or action, or remove the requirements');
    }
    if (checks.length > 20) add('.entry.checks', 'at most 20 checks');
    const names = new Set<string>();
    checks.forEach((c, i) => {
      if (c.name.trim() === '') add(`.entry.checks.${i}.name`, `check ${i + 1} needs a name`);
      else if (names.has(c.name.trim())) {
        add(`.entry.checks.${i}.name`, `check "${c.name}" is listed twice`);
      }
      names.add(c.name.trim());
      if (c.cmd.trim() === '') add(`.entry.checks.${i}.cmd`, `check ${i + 1} needs a command`);
    });
    const actions = new Set<string>();
    (e.actions ?? []).forEach((a, i) => {
      if (actions.has(a)) add(`.entry.actions.${i}`, `action "${a}" is listed twice`);
      actions.add(a);
    });
    if (e.review) {
      if (e.review.items.length === 0) add('.entry.review.items', 'add at least one review item');
      if (e.review.items.length > 30) add('.entry.review.items', 'at most 30 review items');
      e.review.items.forEach((item, i) => {
        if (item.trim() === '') add(`.entry.review.items.${i}`, `review item ${i + 1} is empty`);
        else if (item.length > 2_000) {
          add(`.entry.review.items.${i}`, `review item ${i + 1} is too long`);
        }
      });
    }
    const u = e.on_unmet;
    if (!has(def, u.goto)) {
      add('.entry.on_unmet.goto', `"back to" column "${u.goto}" does not exist`);
    } else if (u.goto === name) {
      add('.entry.on_unmet.goto', `"back to" cannot be ${columnTitle(def, name)} itself`);
    } else if (def.states[u.goto]?.entry !== undefined) {
      add(
        '.entry.on_unmet.goto',
        `"back to" column "${columnTitle(def, u.goto)}" has requirements to enter of its own`,
      );
    }
    if (!has(def, u.else)) add('.entry.on_unmet.else', `"then" column "${u.else}" does not exist`);
    else if (def.states[u.else]?.type !== 'human') {
      add(
        '.entry.on_unmet.else',
        `"then" column "${columnTitle(def, u.else)}" must be a human column`,
      );
    }
    if (!Number.isInteger(u.retries) || u.retries < 0 || u.retries > 10) {
      add('.entry.on_unmet.retries', 'retries must be a whole number from 0 to 10');
    }
    if (u.instruction !== undefined && u.instruction.trim() === '') {
      add('.entry.on_unmet.instruction', 'the instruction is empty');
    }
  }
  for (const g of validateGates(def))
    issues.push({ state: g.from, path: g.path, message: g.message });
  return issues;
}

/**
 * The column a server error path (`states.waiting_external.entry.on_unmet.goto`, dot-joined)
 * belongs to, if any. State names may contain dots, so the longest matching name wins.
 */
export function stateForPath(def: WorkflowDefinition, path: string): string | null {
  const col = /^columns\.(\d+)/.exec(path);
  if (col) {
    const n = def.columns?.[Number(col[1])];
    return n !== undefined && has(def, n) ? n : null;
  }
  if (!path.startsWith('states.')) return null;
  const rest = path.slice('states.'.length);
  const names = Object.keys(def.states).sort((a, b) => b.length - a.length);
  return names.find((n) => rest === n || rest.startsWith(`${n}.`)) ?? null;
}

// ------------------------------------------------------------------ sessions

/** The card's entry step (ADR-0010), read defensively: older contracts don't have `checking`. */
export function readChecking(card: unknown): { to: string; phase: string | null } | null {
  if (typeof card !== 'object' || card === null) return null;
  const c = (card as Record<string, unknown>).checking;
  if (typeof c !== 'object' || c === null) return null;
  const { to, phase } = c as Record<string, unknown>;
  if (typeof to !== 'string' || to === '') return null;
  return { to, phase: typeof phase === 'string' ? phase : null };
}

/**
 * The lane a session is in: its state's column, or Queued before any state. A state that isn't a
 * column of this definition (or a review label) has no lane.
 */
export function currentLane(
  def: WorkflowDefinition,
  workflowState: string | null,
  status: string | null,
): string | null {
  if (workflowState === null || workflowState === '') {
    return status === null || status === 'queued' || status === 'assigned' ? QUEUED_LANE : null;
  }
  return has(def, workflowState) ? workflowState : null;
}
