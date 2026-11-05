import {
  conditionEnabled,
  RETURN_TO,
  stableJson,
  transitionActor,
  transitionObject,
  transitionTitle,
  type Approval,
  type Condition,
  type EntryCheck,
  type OnUnmet,
  type RepoChecks,
  type TransitionAction,
  type TransitionObject,
  type WorkflowDefinition,
  type WorkflowState,
} from '@conductor/shared';
import {
  arrowId,
  columnStates,
  columnTitle,
  followUpsOf,
  QUEUED_LANE,
  QUEUED_TITLE,
  ticketEditableOf,
  workSummary,
} from './columns.js';
import {
  ACTION_TEXT,
  ACTOR_LABEL,
  conditionPhrase,
  DEFAULT_CONDITION_POLL,
  describeTransition,
  humanDuration,
  kindsText,
} from './transitions.js';

// UXR-70 / UXR-73: what changes between two workflow versions (or a repo's checks), in the
// editor's words: columns and transitions added, removed or changed, each changed field as a
// line ("Check **test**: `npm test` → `pnpm test`"). One function behind Compare, the Save
// review dialog and the advisor's proposals. Pure and deterministic; it never hides a change: a
// field it has no words for still shows as "Other setting changed".

export type ChangeOp = 'added' | 'removed' | 'changed';

export interface ReadableChange {
  scope: 'workflow' | 'column' | 'transition' | 'checks';
  op: ChangeOp;
  /** The column (state name); for a transition, the column it leaves. */
  state?: string;
  /** The transition name (with `state` = from). */
  transition?: string;
  /** The arrows it touches (`arrowId(from, goto)`, before and after), for the diagram. */
  edges: string[];
  title: string;
  /** Field changes in the editor's words; `**…**` is bold and `` `…` `` is code. */
  lines: string[];
  /** A transition's plain-language sentence before and after (`describeTransition`). */
  before?: string;
  after?: string;
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const onOff = (v: boolean) => (v ? 'on' : 'off');

const yesNo = (v: boolean) => (v ? 'yes' : 'no');

const duration = (v: string | undefined, none = 'none') =>
  v === undefined ? none : humanDuration(v);

/** A short value as code, a long or multi-line one as "changed". */
function textChange(label: string, a: string | undefined, b: string | undefined): string {
  const short = (v: string | undefined) => v === undefined || (v.length <= 60 && !v.includes('\n'));
  if (short(a) && short(b)) {
    const show = (v: string | undefined) => (v === undefined ? 'none' : `\`${v}\``);
    return `${label}: ${show(a)} → ${show(b)}`;
  }
  return `${label} changed`;
}

/** Keys of two objects in first-seen order. */
const keysOf = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])];

/** "Other setting changed" lines for every key not in `known` whose value differs. */
function otherLines(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  known: ReadonlySet<string>,
  prefix = '',
): string[] {
  return keysOf(a, b)
    .filter((k) => !known.has(k) && !same(a[k], b[k]))
    .map((k) => `Other setting changed: \`${prefix}${k}\``);
}

// ------------------------------------------------------------------ checks

const checkName = (c: EntryCheck, i: number) =>
  c.name.trim() === '' ? `check ${i + 1}` : c.name.trim();

const checkText = (c: EntryCheck) =>
  `\`${c.cmd}\`${c.timeout !== undefined ? ` (up to ${humanDuration(c.timeout)})` : ''}`;

/** Check rows matched by name: added, removed, command or time limit changed, moved. */
export function checkLines(before: readonly EntryCheck[], after: readonly EntryCheck[]): string[] {
  const b = new Map(before.map((c, i) => [checkName(c, i), c]));
  const a = new Map(after.map((c, i) => [checkName(c, i), c]));
  const lines: string[] = [];
  const common = [...a.keys()].filter((n) => b.has(n));
  const oldOrder = [...b.keys()].filter((n) => a.has(n));
  for (const name of keysOf(Object.fromEntries(a), Object.fromEntries(b))) {
    const x = b.get(name);
    const y = a.get(name);
    if (x === undefined && y !== undefined) lines.push(`Check **${name}** added: ${checkText(y)}`);
    else if (y === undefined) lines.push(`Check **${name}** removed`);
    else if (x !== undefined) {
      if (x.cmd !== y.cmd) lines.push(`Check **${name}**: \`${x.cmd}\` → \`${y.cmd}\``);
      if (x.timeout !== y.timeout) {
        lines.push(
          `Check **${name}** time limit: ${duration(x.timeout, 'default')} → ${duration(y.timeout, 'default')}`,
        );
      }
      const from = oldOrder.indexOf(name);
      const to = common.indexOf(name);
      if (from !== to)
        lines.push(`Check **${name}** moved from ${ordinal(from + 1)} to ${ordinal(to + 1)}`);
    }
  }
  return lines;
}

/** `setup`: undefined = auto-detect, '' = none, else the command. */
export function setupWords(setup: string | null | undefined): string {
  if (setup === undefined || setup === null) return 'auto-detect';
  // Never clipped: a command runs, so an appended `; …` must show (security review).
  return setup.trim() === '' ? 'none' : `\`${setup.trim()}\``;
}

// ------------------------------------------------------------------ transitions

const KNOWN_TRANSITION_KEYS = new Set([
  'goto',
  'title',
  'actor',
  'kinds',
  'question',
  'when',
  'notify',
  'text',
  'requires',
  'on_unmet',
]);

const KNOWN_REQUIRES_KEYS = new Set([
  'checks',
  'setup',
  'review',
  'actions',
  'conditions',
  'condition_timeout',
  'condition_poll',
  'approvals',
]);

const goTitle = (def: WorkflowDefinition, n: string) =>
  n === RETURN_TO ? 'the column that asked' : columnTitle(def, n);

function unmetWords(def: WorkflowDefinition, u: OnUnmet | undefined): string {
  if (u === undefined) return 'nothing set';
  const then = `**${goTitle(def, u.else)}**`;
  if (u.retries === 0) return `straight to ${then}`;
  return `back to **${goTitle(def, u.goto)}** up to ${u.retries} time${u.retries === 1 ? '' : 's'}, then ${then}`;
}

/** A condition's identity: its type and what it waits for (so an edit reads as a change). */
const conditionKey = (c: Condition) => `${c.type}:${conditionPhrase(c)}`;

function conditionLines(before: readonly Condition[], after: readonly Condition[]): string[] {
  const b = new Map(before.map((c) => [conditionKey(c), c]));
  const a = new Map(after.map((c) => [conditionKey(c), c]));
  const lines: string[] = [];
  for (const key of keysOf(Object.fromEntries(a), Object.fromEntries(b))) {
    const x = b.get(key);
    const y = a.get(key);
    if (x === undefined && y !== undefined) {
      lines.push(
        `Waits for **${conditionPhrase(y)}**${conditionEnabled(y) ? '' : ' (added, off)'}`,
      );
    } else if (y === undefined && x !== undefined) {
      lines.push(`No longer waits for **${conditionPhrase(x)}**`);
    } else if (x !== undefined && y !== undefined) {
      if (conditionEnabled(x) !== conditionEnabled(y)) {
        lines.push(
          `Condition **${conditionPhrase(y)}**: ${onOff(conditionEnabled(x))} → ${onOff(conditionEnabled(y))}`,
        );
      }
      const strip = (c: Condition) => ({ ...c, enabled: undefined });
      if (!same(strip(x), strip(y))) lines.push(`Condition **${conditionPhrase(y)}** changed`);
    }
  }
  return lines;
}

function approvalLines(before: readonly Approval[], after: readonly Approval[]): string[] {
  const b = new Map(before.map((x) => [x.id, x]));
  const a = new Map(after.map((x) => [x.id, x]));
  const lines: string[] = [];
  for (const id of keysOf(Object.fromEntries(a), Object.fromEntries(b))) {
    const x = b.get(id);
    const y = a.get(id);
    if (x === undefined && y !== undefined) lines.push(`Approval **${y.label}** added`);
    else if (y === undefined && x !== undefined) lines.push(`Approval **${x.label}** removed`);
    else if (!same(x, y)) lines.push(`Approval **${y!.label}** changed`);
  }
  return lines;
}

function listLines(
  before: readonly string[],
  after: readonly string[],
  added: (v: string) => string,
  removed: (v: string) => string,
): string[] {
  return [
    ...after.filter((v) => !before.includes(v)).map(added),
    ...before.filter((v) => !after.includes(v)).map(removed),
  ];
}

/** The changed fields of transition `name` out of `from`, in the editor's words. */
function transitionLines(
  bd: WorkflowDefinition,
  ad: WorkflowDefinition,
  from: string,
  name: string,
  b: TransitionObject,
  a: TransitionObject,
): string[] {
  const lines: string[] = [];
  const bt = transitionTitle(name, b);
  const at = transitionTitle(name, a);
  if (bt !== at) lines.push(`Title: ${bt} → ${at}`);
  if (b.goto !== a.goto) {
    lines.push(`Goes to **${goTitle(ad, a.goto)}** instead of **${goTitle(bd, b.goto)}**`);
  }
  const ba = transitionActor(bd, from, name, b);
  const aa = transitionActor(ad, from, name, a);
  if (ba !== aa) lines.push(`Taken by: ${ACTOR_LABEL[ba]} → ${ACTOR_LABEL[aa]}`);
  if (kindsText(b) !== kindsText(a)) lines.push(`For: ${kindsText(b)} → ${kindsText(a)}`);
  if ((b.question ?? false) !== (a.question ?? false)) {
    lines.push(`Asks a question: ${yesNo(b.question ?? false)} → ${yesNo(a.question ?? false)}`);
  }
  if (b.when !== a.when) lines.push(textChange('When to take it', b.when, a.when));
  if ((b.notify ?? false) !== (a.notify ?? false)) {
    lines.push(`Notifies people: ${onOff(b.notify ?? false)} → ${onOff(a.notify ?? false)}`);
  }
  if (b.text !== a.text) lines.push(`Text: ${b.text ?? 'none'} → ${a.text ?? 'none'}`);

  const br = b.requires ?? {};
  const ar = a.requires ?? {};
  const hadChecks = (br.checks?.length ?? 0) > 0 || (ar.checks?.length ?? 0) > 0;
  if (hadChecks && br.setup !== ar.setup) {
    lines.push(`Setup: ${setupWords(br.setup)} → ${setupWords(ar.setup)}`);
  }
  lines.push(...checkLines(br.checks ?? [], ar.checks ?? []));
  lines.push(
    ...listLines(
      br.review?.items ?? [],
      ar.review?.items ?? [],
      (v) => `Review item added: “${clip(v, 80)}”`,
      (v) => `Review item removed: “${clip(v, 80)}”`,
    ),
  );
  if (br.review?.model !== ar.review?.model) {
    lines.push(`Review model: ${br.review?.model ?? 'default'} → ${ar.review?.model ?? 'default'}`);
  }
  lines.push(
    ...listLines(
      br.actions ?? [],
      ar.actions ?? [],
      (v) => `Action added: ${ACTION_TEXT[v as TransitionAction] ?? v}`,
      (v) => `Action removed: ${ACTION_TEXT[v as TransitionAction] ?? v}`,
    ),
  );
  lines.push(...conditionLines(br.conditions ?? [], ar.conditions ?? []));
  if (br.condition_timeout !== ar.condition_timeout) {
    lines.push(
      `Waits up to: ${duration(br.condition_timeout, 'no limit')} → ${duration(ar.condition_timeout, 'no limit')}`,
    );
  }
  if (br.condition_poll !== ar.condition_poll) {
    lines.push(
      `Checked every: ${humanDuration(br.condition_poll ?? DEFAULT_CONDITION_POLL)} → ${humanDuration(ar.condition_poll ?? DEFAULT_CONDITION_POLL)}`,
    );
  }
  lines.push(...approvalLines(br.approvals ?? [], ar.approvals ?? []));
  lines.push(...otherLines(br, ar, KNOWN_REQUIRES_KEYS, 'requires.'));

  if (!same(b.on_unmet, a.on_unmet)) {
    const bw = unmetWords(bd, b.on_unmet);
    const aw = unmetWords(ad, a.on_unmet);
    if (bw !== aw) lines.push(`If not met: ${bw} → ${aw}`);
    if (b.on_unmet?.instruction !== a.on_unmet?.instruction) {
      lines.push(
        a.on_unmet?.instruction === undefined
          ? 'Instruction on the way back removed'
          : b.on_unmet?.instruction === undefined
            ? 'Instruction on the way back added'
            : 'Instruction on the way back changed',
      );
    }
    if (!same(b.on_unmet?.routes, a.on_unmet?.routes)) lines.push('Routes when not met changed');
  }
  lines.push(...otherLines(b, a, KNOWN_TRANSITION_KEYS));
  return lines;
}

// ------------------------------------------------------------------ columns

const KNOWN_STATE_KEYS = new Set([
  'type',
  'title',
  'on',
  'prompt',
  'skill',
  'model',
  'cmd',
  'wait_for',
  'action',
  'actions',
  'ticket_editable',
  'follow_ups',
  'timeout',
  'entry',
  'checkout',
]);

const TYPE_WORDS: Record<WorkflowState['type'], string> = {
  agent: 'Agent',
  command: 'Command',
  event: 'Waits for an event',
  connector: 'Connector',
  human: 'A person',
  terminal: 'Final',
};

function followUpWords(def: WorkflowDefinition, name: string): string {
  const f = followUpsOf(def, name);
  return f === null ? 'off' : `up to ${f.max}`;
}

/** The changed fields of column `name` (its transitions are separate changes). */
function columnLines(
  bd: WorkflowDefinition,
  ad: WorkflowDefinition,
  name: string,
  b: WorkflowState,
  a: WorkflowState,
): string[] {
  const lines: string[] = [];
  const bt = columnTitle(bd, name);
  const at = columnTitle(ad, name);
  if (bt !== at) lines.push(`Title: ${bt} → ${at}`);
  if (b.type !== a.type) {
    lines.push(`Who works it: ${TYPE_WORDS[b.type]} → ${TYPE_WORDS[a.type]}`);
  } else if (b.type === 'agent' && a.type === 'agent') {
    if (b.prompt !== a.prompt) lines.push(textChange('Prompt', b.prompt, a.prompt));
    if (b.skill !== a.skill) lines.push(textChange('Skill', b.skill, a.skill));
    if (b.model !== a.model) lines.push(`Model: ${b.model ?? 'default'} → ${a.model ?? 'default'}`);
  } else if (workSummary(b) !== workSummary(a)) {
    lines.push(`Work: ${workSummary(b)} → ${workSummary(a)}`);
  }
  const be = ticketEditableOf(bd, name);
  const ae = ticketEditableOf(ad, name);
  if (be !== ae) lines.push(`People can edit tickets here: ${onOff(be)} → ${onOff(ae)}`);
  if (
    !same(
      b.type === 'agent' ? b.follow_ups : undefined,
      a.type === 'agent' ? a.follow_ups : undefined,
    )
  ) {
    const bf = followUpWords(bd, name);
    const af = followUpWords(ad, name);
    lines.push(bf !== af ? `Follow-up tickets: ${bf} → ${af}` : 'Follow-up guidance changed');
  }
  const bto = 'timeout' in b ? b.timeout : undefined;
  const ato = 'timeout' in a ? a.timeout : undefined;
  if (bto !== ato) lines.push(`Times out after: ${duration(bto)} → ${duration(ato)}`);
  if (!same(b.entry, a.entry)) lines.push('Requirements to enter changed');
  const bc = b.type === 'agent' ? b.checkout : undefined;
  const ac = a.type === 'agent' ? a.checkout : undefined;
  if (!same(bc, ac))
    lines.push(`Checkout setup: ${setupWords(bc?.setup)} → ${setupWords(ac?.setup)}`);
  lines.push(...otherLines(b, a, KNOWN_STATE_KEYS));
  return lines;
}

// ------------------------------------------------------------------ the diff

const KNOWN_WORKFLOW_KEYS = new Set([
  'id',
  'version',
  'states',
  'columns',
  'start',
  'budget',
  'on_budget_exceeded',
  'queued_ticket_editable',
]);

function transitionsOf(def: WorkflowDefinition, from: string): Map<string, TransitionObject> {
  const s = def.states[from];
  if (!s || s.type === 'terminal') return new Map();
  return new Map(Object.entries(s.on ?? {}).map(([n, t]) => [n, transitionObject(t)]));
}

const edgeOf = (from: string, goto: string) => arrowId(from, goto);

/**
 * What changes from `before` to `after`: each column (in the board's order, then removed ones)
 * and its transitions, then workflow-wide settings. `version` is ignored. [] = no change.
 */
export function diffVersions(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): ReadableChange[] {
  const out: ReadableChange[] = [];
  const order = [
    ...columnStates(after),
    ...columnStates(before).filter((n) => !has(after.states, n)),
  ];
  const bCommon = columnStates(before).filter((n) => has(after.states, n));
  const aCommon = columnStates(after).filter((n) => has(before.states, n));

  for (const name of order) {
    const b = has(before.states, name) ? before.states[name]! : null;
    const a = has(after.states, name) ? after.states[name]! : null;
    if (b === null && a !== null) {
      out.push({
        scope: 'column',
        op: 'added',
        state: name,
        edges: [],
        title: `Column ${columnTitle(after, name)}`,
        lines: [`${TYPE_WORDS[a.type]}: ${workSummary(a)}`],
      });
    } else if (a === null && b !== null) {
      out.push({
        scope: 'column',
        op: 'removed',
        state: name,
        edges: [],
        title: `Column ${columnTitle(before, name)}`,
        lines: [],
      });
    } else if (a !== null && b !== null) {
      const lines = columnLines(before, after, name, b, a);
      const from = bCommon.indexOf(name);
      const to = aCommon.indexOf(name);
      if (from !== to) lines.push(`Moved from ${ordinal(from + 1)} to ${ordinal(to + 1)} column`);
      if (lines.length > 0) {
        out.push({
          scope: 'column',
          op: 'changed',
          state: name,
          edges: [],
          title: `Column ${columnTitle(after, name)}`,
          lines,
        });
      }
    }

    const bt = transitionsOf(before, name);
    const at = transitionsOf(after, name);
    const names = [...at.keys(), ...[...bt.keys()].filter((n) => !at.has(n))];
    for (const t of names) {
      const x = bt.get(t);
      const y = at.get(t);
      const def = y !== undefined ? after : before;
      const goto = (y ?? x)!.goto;
      const title = `${columnTitle(def, name)} → ${goTitle(def, goto)}: ${transitionTitle(t, y ?? x)}`;
      const base = { scope: 'transition' as const, state: name, transition: t, title };
      if (x === undefined && y !== undefined) {
        out.push({
          ...base,
          op: 'added',
          edges: [edgeOf(name, y.goto)],
          lines: [],
          after: describeTransition(after, name, t),
        });
      } else if (y === undefined && x !== undefined) {
        out.push({
          ...base,
          op: 'removed',
          edges: [edgeOf(name, x.goto)],
          lines: [],
          before: describeTransition(before, name, t),
        });
      } else if (x !== undefined && y !== undefined) {
        const lines = transitionLines(before, after, name, t, x, y);
        if (lines.length === 0 && !same(x, y)) lines.push('Other settings changed');
        if (lines.length === 0) continue;
        const was = describeTransition(before, name, t);
        const now = describeTransition(after, name, t);
        out.push({
          ...base,
          op: 'changed',
          edges: [...new Set([edgeOf(name, x.goto), edgeOf(name, y.goto)])],
          lines,
          ...(was !== now ? { before: was, after: now } : {}),
        });
      }
    }
  }

  const wf: string[] = [];
  if (before.start !== after.start) {
    wf.push(
      `Tickets start in: ${columnTitle(before, before.start)} → ${columnTitle(after, after.start)}`,
    );
  }
  if (!same(before.budget, after.budget)) {
    const words = (d: WorkflowDefinition) =>
      `$${d.budget.usd} · ${d.budget.minutes} min · ${d.budget.max_loop_retries} retries`;
    wf.push(`Budget: ${words(before)} → ${words(after)}`);
  }
  if (before.on_budget_exceeded !== after.on_budget_exceeded) {
    wf.push(
      `Over budget goes to: ${columnTitle(before, before.on_budget_exceeded)} → ${columnTitle(after, after.on_budget_exceeded)}`,
    );
  }
  if ((before.queued_ticket_editable ?? true) !== (after.queued_ticket_editable ?? true)) {
    const e = (d: WorkflowDefinition) => onOff(ticketEditableOf(d, QUEUED_LANE));
    wf.push(`People can edit tickets in ${QUEUED_TITLE}: ${e(before)} → ${e(after)}`);
  }
  wf.push(...otherLines(before, after, KNOWN_WORKFLOW_KEYS));
  if (wf.length > 0) {
    out.push({
      scope: 'workflow',
      op: 'changed',
      edges: [],
      title: 'Workflow settings',
      lines: wf,
    });
  }

  // Never hide a change: anything the rules above have no words for.
  if (out.length === 0) {
    const strip = (d: WorkflowDefinition) => ({ ...d, version: undefined });
    if (!same(strip(before), strip(after))) {
      out.push({
        scope: 'workflow',
        op: 'changed',
        edges: [],
        title: 'Workflow settings',
        lines: ['Other settings changed'],
      });
    }
  }
  return out;
}

/** A repo's check override, before and after (null = the workflow's checks). */
export function diffRepoChecks(
  before: RepoChecks | null,
  after: RepoChecks | null,
): ReadableChange[] {
  if (before === null && after === null) return [];
  const base = { scope: 'checks' as const, edges: [] };
  if (before === null && after !== null) {
    return [
      {
        ...base,
        op: 'added',
        title: 'This repo gets its own checks',
        lines: [
          `Setup: ${setupWords(after.setup)}`,
          ...after.checks.map((c, i) => `Check **${checkName(c, i)}**: ${checkText(c)}`),
        ],
      },
    ];
  }
  if (after === null) {
    return [{ ...base, op: 'removed', title: 'Back to the workflow’s checks', lines: [] }];
  }
  const lines: string[] = [];
  if (before!.setup !== after.setup) {
    lines.push(`Setup: ${setupWords(before!.setup)} → ${setupWords(after.setup)}`);
  }
  lines.push(...checkLines(before!.checks, after.checks));
  return lines.length === 0 ? [] : [{ ...base, op: 'changed', title: 'This repo’s checks', lines }];
}

/** The columns and arrows a diff touches, for highlighting on the diagram. */
export function affectedOf(changes: readonly ReadableChange[]): {
  states: Set<string>;
  edges: Set<string>;
} {
  const states = new Set<string>();
  const edges = new Set<string>();
  for (const c of changes) {
    // A column's own change marks it; so does an added transition, whose arrow isn't drawn yet.
    if (c.state !== undefined && (c.scope === 'column' || c.op === 'added')) states.add(c.state);
    for (const e of c.edges) edges.add(e);
  }
  return { states, edges };
}
