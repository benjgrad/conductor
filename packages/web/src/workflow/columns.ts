import {
  CONDUCTOR_WORKFLOW_ID,
  IMPLEMENT_TEMPLATE,
  PLAN_TEMPLATE,
  PROPOSALS_PER_STATE_MAX,
  pagesSpec,
  resultKeys,
  RETURN_TO,
  ticketEditable,
  transitionObject,
  type EntryRequirements,
  type FollowUps,
  type OnUnmet,
  type WorkflowDefinition,
  type WorkflowState,
} from '@conductor/shared';
import { humanStates, transitionForPath, validateGates } from './model.js';
import { validateTransitions } from './transitions.js';

export { humanStates };

// The one workflow as board columns (ADR-0010): each state is a column, left to right in
// `columns` order, after an implicit Queued column. Here: the lanes and the arrows between them
// (each arrow stands for the transitions between two columns, ADR-0011), the old "requirements to
// enter" summaries (read-only now: saving folds them onto transitions), the pure edits the column
// editor makes, and the client side of the validation rules.

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

/** `ask_user` → "Ask user": a name without a title, as words. */
export function humanizeName(name: string): string {
  const words = name.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Built-in events, in words (FR-2 of UXR-45: no raw event ids on the diagram). */
export const EVENT_LABELS: Record<string, string> = { 'ui.approve': 'Approved' };

/** A transition's title: its own `title`, else a built-in event's label, else the name in words. */
export function transitionTitle(def: WorkflowDefinition, from: string, name: string): string {
  const state = def.states[from];
  const tr = state && state.type !== 'terminal' ? state.on?.[name] : undefined;
  if (typeof tr === 'object' && tr.title !== undefined && tr.title.trim() !== '') return tr.title;
  return EVENT_LABELS[name] ?? humanizeName(name);
}

/** What a column is, as the diagram draws it (UXR-68). */
export type LaneKind = 'agent' | 'person' | 'waiting' | 'queue' | 'end';

export const LANE_KIND_LABELS: Record<LaneKind, string> = {
  agent: 'Agent',
  person: 'Person',
  waiting: 'Waiting',
  queue: 'Queue',
  end: 'End',
};

/** Plain glyphs (no icon font) drawn before the column title. */
export const LANE_KIND_ICONS: Record<LaneKind, string> = {
  agent: '✦',
  person: '●',
  waiting: '◷',
  queue: '≡',
  end: '■',
};

export const LANE_KINDS = Object.keys(LANE_KIND_LABELS) as LaneKind[];

export function laneKind(state: WorkflowState | null): LaneKind {
  if (state === null) return 'queue';
  switch (state.type) {
    case 'human':
      return 'person';
    case 'event':
      return 'waiting';
    case 'terminal':
      return 'end';
    default:
      return 'agent';
  }
}

/**
 * What does a column's work, in one line. `def` (and the state's name) turn an event state's
 * events into their transition titles ("Waits for: Approved").
 */
export function workSummary(
  state: WorkflowState | null,
  def?: WorkflowDefinition,
  name?: string,
): string {
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
      return `Waits for: ${state.wait_for
        .map((ev) =>
          def && name !== undefined
            ? transitionTitle(def, name, ev)
            : (EVENT_LABELS[ev] ?? humanizeName(ev)),
        )
        .join(' or ')}`;
    case 'human':
      return 'A person answers or approves';
    case 'terminal':
      return 'Final';
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const ACTION_LABELS: Record<string, string> = { open_pr: 'Opens PR' };

/**
 * `entry.setup` (runs once before the checks, in a fresh checkout of the commit), read
 * defensively: older shared contracts don't have the field. undefined = auto-detect
 * (`npm ci` / `npm install` / nothing), '' = no setup.
 */
export function readSetup(entry: EntryRequirements | undefined): string | undefined {
  const v = (entry as { setup?: unknown } | undefined)?.setup;
  return typeof v === 'string' ? v : undefined;
}

/** The lane's setup line: "setup: npm ci", "auto setup" or "no setup" (only with checks). */
export function setupLabel(entry: EntryRequirements): string | null {
  if ((entry.checks?.length ?? 0) === 0) return null;
  const setup = readSetup(entry);
  if (setup === undefined) return 'auto setup';
  return setup.trim() === '' ? 'no setup' : `setup: ${setup}`;
}

export interface EntrySummary {
  /** See setupLabel (null without checks). */
  setup: string | null;
  checks: string[];
  reviewItems: number;
  actions: string[];
  /** "Not met: back to Implementing ×3, then Needs input". */
  unmet: string;
}

export function entrySummary(def: WorkflowDefinition, entry: EntryRequirements): EntrySummary {
  const u = entry.on_unmet;
  return {
    setup: setupLabel(entry),
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
    ...(s.setup !== null ? [`⚙ ${s.setup}`] : []),
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
  kind: LaneKind;
  /** null for Queued. */
  state: WorkflowState | null;
  work: string;
  entry: EntryRequirements | null;
}

/**
 * - `start`: Queued → the start state (a machine claims the ticket).
 * - `outcome`: every transition from one column to another, merged per pair into one arrow
 *   (ADR-0011: clicking it opens the transitions it stands for).
 * - `else`: an old object transition's `else` (retries exhausted), dashed.
 * - `unmet`: requirements not met → back to `on_unmet.goto`, dashed: a transition's own
 *   (ADR-0011), an old (ADR-0009) gate's, or an old column's requirements to enter (ADR-0010).
 */
export type LaneEdgeKind = 'start' | 'outcome' | 'else' | 'unmet';

export interface LaneEdge {
  id: string;
  kind: LaneEdgeKind;
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  /** `outcome`: the transition names on this arrow, in definition order. */
  transitions?: string[];
  /** `outcome`: their titles (`transitionTitle`), parallel to `transitions`. */
  titles?: string[];
  /** A dashed `else` / `unmet` loop that belongs to one transition (clicking it opens that). */
  owner?: { from: string; name: string };
  /** Some transition on this arrow has requirements (`requires`, or an old ADR-0009 gate). */
  gated?: boolean;
  /** "✓" when some transition on the arrow has requirements. */
  badge?: string;
  /** Full sentence for `<title>`. */
  title: string;
}

export interface LaneGraph {
  lanes: Lane[];
  edges: LaneEdge[];
}

/** The id of the arrow from `from` to `to` (the merged outcome edge). */
export const arrowId = (from: string, to: string) => `${from}/${to}`;

/**
 * The arrow's label (UXR-45): the one title, or "N ways" for several transitions. Twins that share
 * a title (work and personal "PR ready for review") read as that title.
 */
export function arrowLabel(titles: string[]): string {
  const distinct = [...new Set(titles)];
  if (distinct.length === 1) return distinct[0]!;
  return `${titles.length} ways`;
}

export function buildLaneGraph(def: WorkflowDefinition): LaneGraph {
  const lanes: Lane[] = laneIds(def).map((id) => {
    const state = id === QUEUED_LANE ? null : (def.states[id] ?? null);
    return {
      id,
      title: columnTitle(def, id),
      kind: laneKind(state),
      state,
      work: workSummary(state, def, id),
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
      label: 'Claimed',
      dashed: false,
      title: `${QUEUED_TITLE} → ${t(def.start)} when a machine claims the ticket`,
    });
  }
  const merged = new Map<string, { names: string[]; gated: boolean }>();
  const extra: LaneEdge[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const [name, tr] of Object.entries(state.on ?? {})) {
      const to = typeof tr === 'string' ? tr : tr.goto;
      if (!has(def, to)) continue;
      const key = `${from}\u0000${to}`;
      const m = merged.get(key) ?? { names: [], gated: false };
      m.names.push(name);
      if (typeof tr !== 'string' && (tr.requirements !== undefined || tr.requires !== undefined)) {
        m.gated = true;
      }
      merged.set(key, m);
      if (typeof tr === 'string') continue;
      const owner = { from, name };
      const tt = transitionTitle(def, from, name);
      if (tr.else !== undefined && has(def, tr.else)) {
        extra.push({
          id: `${from}/${name}/else`,
          kind: 'else',
          from,
          to: tr.else,
          label: `${tt}: else`,
          dashed: true,
          owner,
          title: `${t(from)} → ${t(tr.else)} when ${name} retries are exhausted`,
        });
      }
      const u = tr.on_unmet ?? tr.requirements?.on_unmet;
      if (u && u.goto !== from && has(def, u.goto)) {
        extra.push({
          id: `${from}/${name}/unmet`,
          kind: 'unmet',
          from,
          to: u.goto,
          label: `${tt} not met ×${u.retries}`,
          dashed: true,
          owner,
          title: `Requirements for ${name} (${t(from)} → ${t(to)}) not met: back to ${t(u.goto)}`,
        });
      }
    }
  }
  for (const [key, m] of merged) {
    const [from, to] = key.split('\u0000') as [string, string];
    const titles = m.names.map((n) => transitionTitle(def, from, n));
    edges.push({
      id: arrowId(from, to),
      kind: 'outcome',
      from,
      to,
      label: arrowLabel(titles),
      dashed: false,
      transitions: m.names,
      titles,
      ...(m.gated ? { gated: true, badge: '✓' } : {}),
      title:
        `${t(from)} → ${t(to)}: ${plural(m.names.length, 'transition')} (${titles.join(', ')})` +
        (m.gated ? ', with rules' : ''),
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
      label: `Not met ×${u.retries}`,
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

/**
 * ADR-0034: while an agent column leaves `follow_ups` unset, proposals are on only when its prompt
 * is a built-in template that carries the one-line hint (planning, implementing).
 */
function followUpsDefaultOn(s: WorkflowState): boolean {
  return s.type === 'agent' && (s.prompt === PLAN_TEMPLATE || s.prompt === IMPLEMENT_TEMPLATE);
}

/** ADR-0034: an agent column's effective follow-up proposal settings; null = off (or not an agent). */
export function followUpsOf(def: WorkflowDefinition, name: string): FollowUps | null {
  const s = def.states[name];
  if (s?.type !== 'agent') return null;
  if (s.follow_ups !== undefined) return s.follow_ups.enabled ? s.follow_ups : null;
  return followUpsDefaultOn(s) ? { enabled: true, max: PROPOSALS_PER_STATE_MAX } : null;
}

/**
 * ADR-0034: turn an agent column's follow-up proposals on (with `max` / `guidance`) or off. Off
 * removes the key where proposals are off by default, else stores `enabled: false`. A blank
 * guidance removes it.
 */
export function setFollowUps(
  def: WorkflowDefinition,
  name: string,
  value: { max?: number; guidance?: string } | null,
): WorkflowDefinition {
  const cur = followUpsOf(def, name) ?? { enabled: true, max: PROPOSALS_PER_STATE_MAX };
  return updateState(def, name, (s) => {
    if (s.type !== 'agent') return s;
    const next = { ...s };
    delete next.follow_ups;
    if (value === null) {
      return followUpsDefaultOn(s)
        ? { ...next, follow_ups: { enabled: false, max: PROPOSALS_PER_STATE_MAX } }
        : next;
    }
    const guidance = value.guidance !== undefined ? value.guidance : cur.guidance;
    const f: FollowUps = { enabled: true, max: value.max ?? cur.max };
    if (guidance !== undefined && guidance.trim() !== '') f.guidance = guidance;
    return { ...next, follow_ups: f };
  });
}

/** ADR-0038: the default `max` when a column turns pages on. */
export const PAGES_DEFAULT_MAX = 3;

/** ADR-0038: an agent column's pages setting (`{pages: {max}}` in `result`); null = off. */
export function pagesOf(def: WorkflowDefinition, name: string): { max: number } | null {
  const s = def.states[name];
  return s?.type === 'agent' ? pagesSpec(s) : null;
}

/**
 * ADR-0038: turn an agent column's pages on (with `max`) or off. On adds both the `pages` tool
 * (publish_page) and the `{pages: {max}}` result entry; off removes both, and an emptied `tools`
 * or `result` is removed.
 */
export function setPages(
  def: WorkflowDefinition,
  name: string,
  value: { max?: number } | null,
): WorkflowDefinition {
  const cur = pagesOf(def, name);
  return updateState(def, name, (s) => {
    if (s.type !== 'agent') return s;
    const next = { ...s };
    const tools = (s.tools ?? []).filter((t) => t !== 'pages');
    const keys = resultKeys(s);
    delete next.tools;
    delete next.result;
    if (value === null) {
      if (tools.length > 0) next.tools = tools;
      if (keys.length > 0) next.result = keys;
      return next;
    }
    next.tools = [...tools, 'pages'];
    next.result = [...keys, { pages: { max: value.max ?? cur?.max ?? PAGES_DEFAULT_MAX } }];
    return next;
  });
}

/** May people edit the ticket in this lane (a state, or QUEUED_LANE)? The shared rule. */
export function ticketEditableOf(def: WorkflowDefinition, lane: string): boolean {
  return ticketEditable(def, lane === QUEUED_LANE ? null : lane);
}

/** Set a column's `ticket_editable`; undefined removes it (the default by state type). */
export function setTicketEditable(
  def: WorkflowDefinition,
  name: string,
  value: boolean | undefined,
): WorkflowDefinition {
  return updateState(def, name, (s) => {
    const next = { ...s };
    delete next.ticket_editable;
    return value === undefined ? next : { ...next, ticket_editable: value };
  });
}

/** Set the Queued column's `queued_ticket_editable`; undefined removes it (default: editable). */
export function setQueuedTicketEditable(
  def: WorkflowDefinition,
  value: boolean | undefined,
): WorkflowDefinition {
  const next = { ...def };
  delete next.queued_ticket_editable;
  return value === undefined ? next : { ...next, queued_ticket_editable: value };
}

// ------------------------------------------------------------------ structure (UXR-67)

// The workflow's shape: add a column (between two others), move one, remove one. A column's state
// name is fixed once it exists (agents report it, and tickets sit in it); only its title changes.
// The server refuses to drop a column unfinished tickets are in (rule 18, orchestrator
// `removedStatesInUse`); `columnRemovalProblems` says so up front when it knows the counts.

/** The kinds of column the designer adds (command and connector columns stay API-only). */
export type NewColumnKind = Exclude<LaneKind, 'queue'>;
export const NEW_COLUMN_KINDS: readonly NewColumnKind[] = ['agent', 'person', 'waiting', 'end'];

const STATE_NAME = /^[a-z][a-z0-9_]*$/;

/** Why `name` can't be a new column's state name (null = it can). */
export function stateNameProblem(def: WorkflowDefinition, name: string): string | null {
  if (name === '') return 'the name is empty';
  if (!STATE_NAME.test(name)) {
    return 'use lowercase letters, digits and _, starting with a letter (e.g. needs_design)';
  }
  if (has(def, name)) return `there is already a column "${name}"`;
  return null;
}

/** "Needs design" → `needs_design` (`_2`, `_3`… when taken). */
export function slugFromTitle(def: WorkflowDefinition, title: string): string {
  let base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base === '' || !/^[a-z]/.test(base)) base = `column${base === '' ? '' : `_${base}`}`;
  base = base.slice(0, 40).replace(/_+$/, '');
  let name = base;
  for (let n = 2; has(def, name); n++) name = `${base}_${n}`;
  return name;
}

/** The person column an agent column asks: `needs_input`, else the first human column. */
function askTarget(def: WorkflowDefinition): string | null {
  const humans = humanStates(def);
  return humans.includes('needs_input') ? 'needs_input' : (humans[0] ?? null);
}

/** Why a column of `kind` can't be added (null = it can). */
export function addColumnProblem(def: WorkflowDefinition, kind: NewColumnKind): string | null {
  if (kind === 'agent' && askTarget(def) === null) {
    return 'An agent column needs a Person column to ask: add one first';
  }
  return null;
}

export interface NewColumn {
  title: string;
  kind: NewColumnKind;
  /** The lane it goes after: a state, or QUEUED_LANE for the first column. */
  after: string;
  /** Agent work: the prompt template (default `implement_template`) and model (blank = default). */
  prompt?: string;
  model?: string;
}

/**
 * Add a column after `after`. It starts valid on its own: an agent column can ask a person
 * (`ask_user`), a waiting column moves on to the next column when approved. Nothing leads to it
 * yet (`validateColumns` says so until a transition does). `start` never changes.
 */
export function addColumn(
  def: WorkflowDefinition,
  col: NewColumn,
): { definition: WorkflowDefinition; name: string } {
  const problem = addColumnProblem(def, col.kind);
  if (problem !== null) throw new Error(problem);
  const name = slugFromTitle(def, col.title);
  const order = columnStates(def);
  const at = col.after === QUEUED_LANE ? 0 : order.indexOf(col.after) + 1;
  if (at === 0 && col.after !== QUEUED_LANE) throw new Error(`no column "${col.after}"`);
  const next = order[at] ?? order.find((n) => n !== col.after) ?? order[0]!;
  const title = col.title.trim();
  const titled = title === '' ? {} : { title };
  let state: WorkflowState;
  switch (col.kind) {
    case 'agent':
      state = {
        type: 'agent',
        ...titled,
        prompt: col.prompt?.trim() || IMPLEMENT_TEMPLATE,
        ...(col.model?.trim() ? { model: col.model.trim() } : {}),
        on: { ask_user: askTarget(def)! },
      };
      break;
    case 'person':
      state = { type: 'human', ...titled };
      break;
    case 'waiting':
      state = { type: 'event', ...titled, wait_for: ['ui.approve'], on: { 'ui.approve': next } };
      break;
    case 'end':
      state = { type: 'terminal', ...titled };
      break;
  }
  const columns = [...order.slice(0, at), name, ...order.slice(at)];
  return { definition: { ...def, states: { ...def.states, [name]: state }, columns }, name };
}

/** Move column `name` to position `to` among the columns (Queued stays first, outside them). */
export function moveColumn(def: WorkflowDefinition, name: string, to: number): WorkflowDefinition {
  const order = columnStates(def);
  const from = order.indexOf(name);
  if (from < 0) throw new Error(`no column "${name}"`);
  const rest = order.filter((n) => n !== name);
  const at = Math.max(0, Math.min(rest.length, to));
  return { ...def, columns: [...rest.slice(0, at), name, ...rest.slice(at)] };
}

/** Move column `name` one place left (-1) or right (1); at an end, nothing changes. */
export function moveColumnBy(
  def: WorkflowDefinition,
  name: string,
  by: -1 | 1,
): WorkflowDefinition {
  const order = columnStates(def);
  const from = order.indexOf(name);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return def;
  return moveColumn(def, name, to);
}

/** One way into a column: a transition's leg, or an old entry's "not met" route. */
export interface ColumnLink {
  from: string;
  to: string;
  /** "Needs input → Done", or "Implementing's old requirements to enter". */
  via: string;
}

/** Every link between columns (the server's rule 2 edges; `$return_to` is not one). */
export function columnLinks(def: WorkflowDefinition): ColumnLink[] {
  const links: ColumnLink[] = [];
  const legs = (u: OnUnmet | undefined) =>
    u === undefined ? [] : [u.goto, u.else, ...Object.values(u.routes ?? {})];
  for (const [from, state] of Object.entries(def.states)) {
    const via = `${columnTitle(def, from)}’s old requirements to enter`;
    for (const to of legs(state.entry?.on_unmet)) {
      if (to !== undefined) links.push({ from, to, via });
    }
    if (state.type === 'terminal') continue;
    for (const [name, raw] of Object.entries(state.on ?? {})) {
      const t = transitionObject(raw);
      const via = `${columnTitle(def, from)} → ${transitionTitle(def, from, name)}`;
      const targets = [t.goto, t.else, ...legs(t.requirements?.on_unmet), ...legs(t.on_unmet)];
      for (const to of targets) {
        if (to !== undefined && to !== RETURN_TO) links.push({ from, to, via });
      }
    }
  }
  return links;
}

/**
 * Every reason column `name` can't be removed, in words (empty = it can): it is the first column
 * or the over-budget one, another column leads to it, `ticketCounts` has tickets in it, or it is
 * the last person column agents can ask.
 */
export function columnRemovalProblems(
  def: WorkflowDefinition,
  name: string,
  ticketCounts?: Readonly<Record<string, number>>,
): string[] {
  const state = def.states[name];
  if (!state) return [];
  const problems: string[] = [];
  if (name === def.start) problems.push('It is the first column: claimed tickets start here');
  if (name === def.on_budget_exceeded) problems.push('Tickets over budget go here');
  const via = new Set(
    columnLinks(def)
      .filter((l) => l.to === name && l.from !== name)
      .map((l) => l.via),
  );
  for (const v of via) problems.push(`${v} leads here`);
  const n = ticketCounts?.[name] ?? 0;
  if (n > 0) problems.push(`${n} ticket${n === 1 ? ' is' : 's are'} in it`);
  if (
    state.type === 'human' &&
    humanStates(def).length === 1 &&
    Object.values(def.states).some((s) => s.type === 'agent')
  ) {
    problems.push('Agent columns need a Person column to ask');
  }
  return problems;
}

/**
 * Remove column `name` and the transitions out of it. Throws while `columnRemovalProblems` (without
 * ticket counts: the server checks those) has any.
 */
export function removeColumn(def: WorkflowDefinition, name: string): WorkflowDefinition {
  const problems = columnRemovalProblems(def, name);
  if (problems.length > 0) throw new Error(problems.join('; '));
  const states = { ...def.states };
  delete states[name];
  const next: WorkflowDefinition = { ...def, states };
  if (def.columns !== undefined) next.columns = def.columns.filter((n) => n !== name);
  return next;
}

// ------------------------------------------------------------------ validation

export interface ColumnIssue {
  /** The column (state) the problem belongs to, or null for the whole definition. */
  state: string | null;
  /** Dotted path into the definition, like the server's `details[].path`. */
  path: string;
  message: string;
  /** The transition (`states.<from>.on.<name>…`) the problem belongs to, if any (ADR-0011). */
  transition?: { from: string; name: string };
}

/** Attach the transition a path points into (`transitionForPath`), if any. */
export function issueAt(def: WorkflowDefinition, path: string, message: string): ColumnIssue {
  const t = transitionForPath(def, path);
  return {
    state: stateForPath(def, path),
    path,
    message,
    ...(t !== null ? { transition: { from: t.from, name: t.outcome } } : {}),
  };
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
  if (def.columns !== undefined && def.columns.length === 0) {
    issues.push({
      state: null,
      path: 'columns',
      message: 'the workflow needs at least one column',
    });
  }
  // Rule 1 and 2 (UXR-67: a removed or a new column): the first column exists, and every column
  // can be reached from it, so a new column says it needs a way in before Save does.
  if (!has(def, def.start)) {
    issues.push({
      state: null,
      path: 'start',
      message: `the first column "${def.start}" does not exist`,
    });
  } else {
    const reached = new Set<string>();
    const out = new Map<string, string[]>();
    for (const l of columnLinks(def)) out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    const stack = [
      def.start,
      ...(def.on_budget_exceeded !== undefined ? [def.on_budget_exceeded] : []),
    ];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (reached.has(n)) continue;
      reached.add(n);
      stack.push(...(out.get(n) ?? []));
    }
    for (const n of Object.keys(def.states)) {
      if (reached.has(n)) continue;
      issues.push({
        state: n,
        path: `states.${n}`,
        message: `Nothing leads to ${columnTitle(def, n)} yet: add a transition into it from another column`,
      });
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
    const setup = readSetup(e);
    if (setup !== undefined && checks.length === 0) {
      add('.entry.setup', 'setup runs before the checks: add a check, or remove the setup');
    } else if (setup !== undefined && setup.length > 2_000) {
      add('.entry.setup', 'the setup command is too long');
    }
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
  for (const g of validateGates(def)) {
    issues.push({
      state: g.from,
      path: g.path,
      message: g.message,
      transition: { from: g.from, name: g.outcome },
    });
  }
  for (const t of validateTransitions(def)) {
    issues.push({
      state: t.from,
      path: t.path,
      message: t.message,
      ...(t.name !== '' ? { transition: { from: t.from, name: t.name } } : {}),
    });
  }
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
