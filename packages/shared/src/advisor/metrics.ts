import { z } from 'zod';
import { isNamedMove } from '../engine/types.js';
import type { MoveCause } from '../workflow/schema.js';
import { stateKey, type CheckRole, type CheckSource, type InputClass } from './gates.js';

// ADR-0033 (workflow advisor, P1): deterministic process metrics over past sessions, and the
// findings ranked from them. All pure: the orchestrator loads the windowed rows
// (orchestrator/src/advisor/queries.ts) and the MCP tools `get_process_metrics` / `list_findings`
// call these. No model is involved; the analyst sub-agents of P2 add their findings beside these (advisor/insight.ts).

// ---------------------------------------------------------------- input rows

/** One `state.entered` event: the session entered `to` at `at` (ISO). */
export interface MoveRow {
  session_id: string;
  ticket_id: string;
  repo: string;
  workflow_id: string;
  machine_id: string | null;
  from: string | null;
  to: string;
  /**
   * The transition's name (ADR-0011): for an engine move since ADR-0037 the gate's transition
   * (`cause` says why), before it an ENGINE_MOVE name (actor `engine`); null for a start or answer.
   */
  transition: string | null;
  /** ADR-0037 P7: why the session moved; null (or absent) on rows written before it. */
  cause?: MoveCause | null;
  /** Who moved it (`agent`, `human`, `system`, or `engine` on older rows); absent = unknown. */
  actor?: string | null;
  /** Times the session has entered `to`, this entry included (1 = first). */
  visit: number;
  at: string;
  /** The session's workflow version; absent or null = unknown. */
  workflow_version?: number | null;
}

/** One finished check: a `run_cmd` and its `command.exited`. */
export interface CheckRunRow {
  session_id: string;
  ticket_id: string;
  repo: string;
  machine_id: string | null;
  /** The state (gate) that ran it: a `stateKey` (e.g. `implementing.pr_ready_for_review`). */
  state: string;
  /** The command (the run_cmd payload carries no name: TD-201). */
  cmd: string;
  /** The check's name (`checkIdentity`); absent = the command. */
  name?: string;
  /** A check, the gate's setup (a failed setup), or conductor's implicit pin check. Absent = check. */
  role?: CheckRole;
  /** Where its definition came from. Absent = unknown. */
  source?: CheckSource;
  exit_code: number | null;
  timed_out: boolean;
  setup_failed: boolean;
  started_at: string;
  at: string;
}

/** One input request (a question to a human). */
export interface InputRow {
  session_id: string;
  ticket_id: string;
  repo: string;
  machine_id: string | null;
  /** The state that asked (`return_to`), null when unknown. */
  state: string | null;
  kind: string;
  created_at: string;
  answered_at: string | null;
  /** The transition that opened it (the session's move just before), null = none recorded. */
  transition?: string | null;
  /**
   * `inputClass`: a question to a human, a hand-off of finished work (a PR-ready summary), or an
   * engine stop. Absent: a `handoff` is a hand-off, an `agent_question` a question, anything else
   * a stop.
   */
  class?: InputClass;
}

/** The input's class (`InputRow.class`, else from its kind). */
export const classOf = (r: Pick<InputRow, 'kind' | 'class'>): InputClass =>
  r.class ?? (r.kind === 'handoff' ? 'handoff' : r.kind === 'agent_question' ? 'question' : 'stop');

/** One ADR-0023 permission prompt. */
export interface PermissionRow {
  session_id: string;
  ticket_id: string;
  repo: string;
  machine_id: string;
  tool: string;
  /** The exact rule "Allow always" would record (`alwaysRuleFor`), null = none. */
  always_rule: string | null;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  scope: 'once' | 'always' | null;
  created_at: string;
}

/** Everything the metrics read, for one account and window. */
export interface AdvisorRows {
  moves: MoveRow[];
  checks: CheckRunRow[];
  inputs: InputRow[];
  permissions: PermissionRow[];
  /**
   * States and gates (by `stateKey`) whose definition waits on someone outside by design
   * (`gates.ts waitsOnOthers`), with how long it lets them wait. Not slow states.
   */
  waits?: Record<string, { ceiling_minutes: number | null }>;
  /**
   * ADR-0038: per session and agent state, how many pages its result attached (`pagesOfContext`
   * over the session's context; counted from the result, so swept hosted pages still count).
   */
  pages?: PageCountRow[];
  /** ADR-0037 P5: texts people wrote where a saved reply was on offer. */
  preset_texts?: PresetTextRow[];
}

/**
 * ADR-0037 P5: a text a person wrote on a session whose pinned definition offers saved replies
 * (`presets`): a human transition's `text`, or the answer to an input request (the review
 * composer answers that way). `presets` are the saved replies it could have used, resolved.
 */
export interface PresetTextRow {
  session_id: string;
  ticket_id: string;
  workflow_id: string;
  source: 'transition' | 'answer';
  /** The human transition taken; null for an answer. */
  transition: string | null;
  text: string;
  presets: { slug: string; text: string }[];
}

/** ADR-0038: the pages one agent state of one session attached. */
export interface PageCountRow {
  ticket_id: string;
  session_id: string;
  state: string;
  count: number;
}

export const AdvisorGroupBySchema = z.enum(['state', 'repo', 'machine', 'check']);
export type AdvisorGroupBy = z.infer<typeof AdvisorGroupBySchema>;

// ---------------------------------------------------------------- helpers

const MINUTE = 60_000;
/** Example ticket ids kept per aggregate. */
export const EXAMPLES_MAX = 5;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The median of `xs` (0 for none). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The nearest-rank percentile `p` (0..1) of `xs` (0 for none). */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

/** Adds `id` to `into` while it holds fewer than EXAMPLES_MAX distinct ids. */
function addExample(into: string[], id: string): void {
  if (into.length < EXAMPLES_MAX && !into.includes(id)) into.push(id);
}

function bucket<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

const minutesBetween = (from: string, to: string): number =>
  Math.max(0, (Date.parse(to) - Date.parse(from)) / MINUTE);

// ---------------------------------------------------------------- the five metrics

/** A closed stay in one state: entered, then left by the next `state.entered`. */
export interface StateSpan {
  session_id: string;
  ticket_id: string;
  repo: string;
  machine_id: string | null;
  state: string;
  minutes: number;
}

/**
 * Each closed stay in a state. A session's last entry has no end (it is running, or terminal), so
 * it is left out: medians are only over finished stays.
 */
export function stateDurations(moves: readonly MoveRow[]): StateSpan[] {
  const bySession = new Map<string, MoveRow[]>();
  for (const m of moves) bucket(bySession, m.session_id, () => []).push(m);
  const spans: StateSpan[] = [];
  for (const list of bySession.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let i = 0; i + 1 < sorted.length; i++) {
      const m = sorted[i]!;
      spans.push({
        session_id: m.session_id,
        ticket_id: m.ticket_id,
        repo: m.repo,
        machine_id: m.machine_id,
        state: stateKey(m.to),
        minutes: minutesBetween(m.at, sorted[i + 1]!.at),
      });
    }
  }
  return spans;
}

/** `LoopKey.cause` of the bucket that holds every re-entry recorded before ADR-0037 P7. */
export const UNRECORDED_CAUSE = 'unrecorded';

export interface LoopKey {
  /** The state left (a gate label resolved by `stateKey`), `(start)` for a first entry, `*` unrecorded. */
  from: string;
  /** The transition name, `-` for none, `*` unrecorded. */
  transition: string;
  /** The ADR-0037 cause, or UNRECORDED_CAUSE: "unrecorded (before ADR-0037)". */
  cause: MoveCause | typeof UNRECORDED_CAUSE;
}

export interface LoopCounts {
  /** Per state: re-entries (visit ≥ 2) and the tickets that had them. */
  reentries: { state: string; count: number; tickets: number; examples: string[] }[];
  /** Per transition name: how often a named transition was taken (engine routes are not). */
  transitions: { name: string; count: number }[];
  /** ADR-0037 P7: moves per cause (rows before it are not counted). */
  causes: { cause: MoveCause; count: number }[];
  /**
   * ADR-0037 P7: re-entries (visit ≥ 2) keyed by `(from, transition, cause)`, never by the target,
   * so the same gate before and after a version is one loop. Rows without a cause all go to one
   * `{*, *, unrecorded}` bucket. Most first.
   */
  loops: (LoopKey & { count: number; tickets: number; examples: string[] })[];
  /**
   * Per ticket: its most re-entered state's extra visits (visit - 1) and its `qa_fail` count, for
   * tickets with any. Sorted by the larger of the two, most first.
   */
  tickets: { ticket_id: string; state: string; extra_visits: number; qa_fail: number }[];
}

/** Rework: states entered again, transitions taken, and the tickets that went round. */
export function loopCounts(moves: readonly MoveRow[]): LoopCounts {
  const re = new Map<string, { count: number; tickets: Set<string>; examples: string[] }>();
  const tr = new Map<string, number>();
  const tk = new Map<string, { state: string; extra_visits: number; qa_fail: number }>();
  const causes = new Map<MoveCause, number>();
  const lp = new Map<
    string,
    LoopKey & { count: number; tickets: Set<string>; examples: string[] }
  >();
  for (const m of moves) {
    const cause = m.cause ?? null;
    if (isNamedMove({ transition: m.transition, actor: m.actor ?? null, cause })) {
      tr.set(m.transition!, (tr.get(m.transition!) ?? 0) + 1);
    }
    if (cause !== null) causes.set(cause, (causes.get(cause) ?? 0) + 1);
    if (m.visit >= 2) {
      const key: LoopKey =
        cause === null
          ? { from: '*', transition: '*', cause: UNRECORDED_CAUSE }
          : {
              from: m.from === null ? '(start)' : stateKey(m.from),
              transition: m.transition ?? '-',
              cause,
            };
      const l = bucket(lp, `${key.from}\u0000${key.transition}\u0000${key.cause}`, () => ({
        ...key,
        count: 0,
        tickets: new Set<string>(),
        examples: [],
      }));
      l.count++;
      l.tickets.add(m.ticket_id);
      addExample(l.examples, m.ticket_id);
    }
    const to = stateKey(m.to);
    const t = bucket(tk, m.ticket_id, () => ({ state: to, extra_visits: 0, qa_fail: 0 }));
    if (m.transition === 'qa_fail') t.qa_fail++;
    if (m.visit >= 2) {
      const r = bucket(re, to, () => ({ count: 0, tickets: new Set<string>(), examples: [] }));
      r.count++;
      r.tickets.add(m.ticket_id);
      addExample(r.examples, m.ticket_id);
      if (m.visit - 1 > t.extra_visits) {
        t.extra_visits = m.visit - 1;
        t.state = to;
      }
    }
  }
  return {
    reentries: [...re.entries()]
      .map(([state, r]) => ({
        state,
        count: r.count,
        tickets: r.tickets.size,
        examples: r.examples,
      }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
    transitions: [...tr.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    causes: [...causes.entries()]
      .map(([cause, count]) => ({ cause, count }))
      .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause)),
    loops: [...lp.values()]
      .map((l) => ({
        from: l.from,
        transition: l.transition,
        cause: l.cause,
        count: l.count,
        tickets: l.tickets.size,
        examples: l.examples,
      }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          a.from.localeCompare(b.from) ||
          a.transition.localeCompare(b.transition) ||
          a.cause.localeCompare(b.cause),
      ),
    tickets: [...tk.entries()]
      .filter(([, t]) => t.extra_visits > 0 || t.qa_fail > 0)
      .map(([ticket_id, t]) => ({ ticket_id, ...t }))
      .sort(
        (a, b) =>
          Math.max(b.extra_visits, b.qa_fail) - Math.max(a.extra_visits, a.qa_fail) ||
          a.ticket_id.localeCompare(b.ticket_id),
      ),
  };
}

export interface CheckStat {
  /** The check's name (the command when no name is known); for a setup, `Repo setup` etc. */
  check: string;
  role: CheckRole;
  source: CheckSource;
  /** A command it ran (the first seen), clipped. */
  cmd: string;
  /** The states that ran it, sorted. */
  states: string[];
  runs: number;
  /** Non-zero exit, timeout or failed setup. */
  failures: number;
  timeouts: number;
  setup_failures: number;
  failure_rate: number;
  median_minutes: number;
  examples: string[];
}

/** A check run counts as failed on a non-zero (or missing) exit, a timeout or a failed setup. */
export const checkFailed = (c: Pick<CheckRunRow, 'exit_code' | 'timed_out' | 'setup_failed'>) =>
  c.timed_out || c.setup_failed || c.exit_code !== 0;

/** The name a check run is counted under: its name, a setup's under `setup: <name>`. */
export function checkKey(c: Pick<CheckRunRow, 'cmd' | 'name' | 'role'>): string {
  const name = c.name ?? c.cmd;
  return c.role === 'setup' ? `setup: ${name}` : name;
}

/**
 * Per check (by name; a failed setup under the setup, not the check it preceded): runs, failures
 * and how long it takes. Most failures first.
 */
export function checkFailureRates(checks: readonly CheckRunRow[]): CheckStat[] {
  const by = new Map<
    string,
    {
      name: string;
      role: CheckRole;
      source: CheckSource;
      cmd: string;
      states: Set<string>;
      mins: number[];
      f: number;
      to: number;
      sf: number;
      ex: string[];
    }
  >();
  for (const c of checks) {
    const s = bucket(by, `${c.role ?? 'check'}\u0000${c.name ?? c.cmd}`, () => ({
      name: c.name ?? c.cmd,
      role: c.role ?? 'check',
      source: c.source ?? 'unknown',
      cmd: c.cmd.length <= 200 ? c.cmd : c.cmd.slice(0, 199) + '…',
      states: new Set<string>(),
      mins: [],
      f: 0,
      to: 0,
      sf: 0,
      ex: [],
    }));
    s.states.add(c.state);
    s.mins.push(minutesBetween(c.started_at, c.at));
    if (checkFailed(c)) {
      s.f++;
      addExample(s.ex, c.ticket_id);
    }
    if (c.timed_out) s.to++;
    if (c.setup_failed) s.sf++;
  }
  return [...by.values()]
    .map((s) => ({
      check: s.name,
      role: s.role,
      source: s.source,
      cmd: s.cmd,
      states: [...s.states].sort(),
      runs: s.mins.length,
      failures: s.f,
      timeouts: s.to,
      setup_failures: s.sf,
      failure_rate: round1((s.f / s.mins.length) * 100) / 100,
      median_minutes: round1(median(s.mins)),
      examples: s.ex,
    }))
    .sort((a, b) => b.failures - a.failures || a.check.localeCompare(b.check));
}

export interface InputStat {
  state: string;
  asked: number;
  /** Distinct tickets asked in this state. */
  tickets: number;
  answered: number;
  median_answer_minutes: number;
  kinds: Record<string, number>;
  examples: string[];
}

/**
 * Per asking state: questions to a human, and how long the answers took. Most asked first. Only
 * questions (`classOf`): a hand-off of finished work or an engine stop is not the agent asking.
 */
export function inputStats(inputs: readonly InputRow[]): InputStat[] {
  const by = new Map<
    string,
    {
      asked: number;
      tickets: Set<string>;
      waits: number[];
      kinds: Record<string, number>;
      ex: string[];
    }
  >();
  for (const r of inputs) {
    if (classOf(r) !== 'question') continue;
    const s = bucket(by, r.state === null ? 'unknown' : stateKey(r.state), () => ({
      asked: 0,
      tickets: new Set<string>(),
      waits: [],
      kinds: {},
      ex: [],
    }));
    s.asked++;
    s.tickets.add(r.ticket_id);
    s.kinds[r.kind] = (s.kinds[r.kind] ?? 0) + 1;
    addExample(s.ex, r.ticket_id);
    if (r.answered_at !== null) s.waits.push(minutesBetween(r.created_at, r.answered_at));
  }
  return [...by.entries()]
    .map(([state, s]) => ({
      state,
      asked: s.asked,
      tickets: s.tickets.size,
      answered: s.waits.length,
      median_answer_minutes: round1(median(s.waits)),
      kinds: s.kinds,
      examples: s.ex,
    }))
    .sort((a, b) => b.asked - a.asked || a.state.localeCompare(b.state));
}

export interface PermissionStat {
  machine_id: string;
  tool: string;
  /** The exact allow rule that would cover these prompts (the most common one), if any. */
  rule: string | null;
  prompts: number;
  /** Denied by a human, or expired with no answer: either way the agent did not get it. */
  denied: number;
  allowed: number;
  allowed_always: number;
  examples: string[];
}

/** Per machine and tool: permission prompts and how they ended. Most denials first. */
export function permissionStats(perms: readonly PermissionRow[]): PermissionStat[] {
  const by = new Map<
    string,
    {
      machine_id: string;
      tool: string;
      rules: Map<string, number>;
      n: number;
      d: number;
      a: number;
      aa: number;
      ex: string[];
    }
  >();
  for (const p of perms) {
    const s = bucket(by, `${p.machine_id}\u0000${p.tool}`, () => ({
      machine_id: p.machine_id,
      tool: p.tool,
      rules: new Map(),
      n: 0,
      d: 0,
      a: 0,
      aa: 0,
      ex: [],
    }));
    s.n++;
    if (p.always_rule !== null) s.rules.set(p.always_rule, (s.rules.get(p.always_rule) ?? 0) + 1);
    if (p.status === 'denied' || p.status === 'expired') {
      s.d++;
      addExample(s.ex, p.ticket_id);
    }
    if (p.status === 'allowed') {
      s.a++;
      if (p.scope === 'always') s.aa++;
    }
  }
  return [...by.values()]
    .map((s) => ({
      machine_id: s.machine_id,
      tool: s.tool,
      rule:
        [...s.rules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
        null,
      prompts: s.n,
      denied: s.d,
      allowed: s.a,
      allowed_always: s.aa,
      examples: s.ex,
    }))
    .sort(
      (a, b) =>
        b.denied - a.denied ||
        b.prompts - a.prompts ||
        a.machine_id.localeCompare(b.machine_id) ||
        a.tool.localeCompare(b.tool),
    );
}

// ---------------------------------------------------------------- grouped metrics

export const ProcessGroupSchema = z.object({
  key: z.string(),
  tickets: z.number().int().nonnegative(),
  /** Finished stays (state, repo and machine groupings only). */
  stays: z.number().int().nonnegative(),
  median_minutes: z.number().nonnegative(),
  p90_minutes: z.number().nonnegative(),
  total_hours: z.number().nonnegative(),
  reentries: z.number().int().nonnegative(),
  check_runs: z.number().int().nonnegative(),
  check_failures: z.number().int().nonnegative(),
  /** Questions to a human (`ask_user`, `needs_approval_to_message`, planning questions). */
  questions: z.number().int().nonnegative(),
  /** Hand-offs of finished work (a PR-ready summary through a `question: true` gate). */
  handoffs: z.number().int().nonnegative().default(0),
  /** Engine stops that asked a human (timeout, retries ran out, budget, approval, lost machine). */
  stops: z.number().int().nonnegative().default(0),
  permission_denials: z.number().int().nonnegative(),
  /** State grouping: the definition waits on someone outside here by design (not slow). */
  waits_on_others: z.boolean().default(false),
  /** …and how long it lets them wait (`condition_timeout`, an event state's `timeout`). */
  ceiling_minutes: z.number().nonnegative().nullable().default(null),
});
export type ProcessGroup = z.infer<typeof ProcessGroupSchema>;

export const ProcessMetricsSchema = z.object({
  group_by: AdvisorGroupBySchema,
  totals: z.object({
    tickets: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    moves: z.number().int().nonnegative(),
    check_runs: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    handoffs: z.number().int().nonnegative().default(0),
    stops: z.number().int().nonnegative().default(0),
    permission_prompts: z.number().int().nonnegative(),
  }),
  groups: z.array(ProcessGroupSchema),
  /** Groups left out after the first GROUPS_MAX. */
  more_groups: z.number().int().nonnegative(),
  /** The busiest named transitions (ADR-0011 names; engine routes are under `causes`). */
  transitions: z.array(z.object({ name: z.string(), count: z.number().int() })),
  /** ADR-0037 P7: moves per cause, most first (rows before it are not counted). */
  causes: z.array(z.object({ cause: z.string(), count: z.number().int() })).default([]),
  /**
   * ADR-0037 P7: the biggest re-entry loops, keyed by `(from, transition, cause)`; cause
   * `unrecorded` = every re-entry written before ADR-0037.
   */
  loops: z
    .array(
      z.object({
        from: z.string(),
        transition: z.string(),
        cause: z.string(),
        count: z.number().int(),
        tickets: z.number().int(),
      }),
    )
    .default([]),
  /**
   * ADR-0038: pages agents attached, per state and per ticket (the most first, at most
   * EXAMPLES_MAX tickets). Absent when no agent attached one in the window.
   */
  pages: z
    .object({
      total: z.number().int().nonnegative(),
      by_state: z.record(z.string(), z.number().int().nonnegative()),
      by_ticket: z.array(z.object({ ticket_id: z.string(), count: z.number().int() })),
    })
    .optional(),
  /**
   * ADR-0037 P5: per saved reply, how many texts people sent were exactly it (after trim), and
   * how many texts where saved replies were on offer matched none (`typed`). Absent when no one
   * wrote where one was offered.
   */
  presets: z
    .object({
      uses: z.array(
        z.object({
          workflow_id: z.string(),
          slug: z.string(),
          used: z.number().int().nonnegative(),
          examples: z.array(z.string()),
        }),
      ),
      typed: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ProcessMetrics = z.infer<typeof ProcessMetricsSchema>;

/** At most this many groups, so a result stays well under the MCP 8 KB cap. */
export const GROUPS_MAX = 25;
const TRANSITIONS_MAX = 10;
const LOOPS_MAX = 10;

/**
 * The account's process in one table, keyed by `group_by`: time spent, rework, check failures,
 * questions and permission denials. `check` keys only check runs (the other columns are 0).
 * Sorted by total time, then check failures, then questions.
 */
export function processMetrics(rows: AdvisorRows, groupBy: AdvisorGroupBy): ProcessMetrics {
  type Acc = { tickets: Set<string>; mins: number[] } & Omit<
    ProcessGroup,
    | 'key'
    | 'tickets'
    | 'stays'
    | 'median_minutes'
    | 'p90_minutes'
    | 'total_hours'
    | 'waits_on_others'
    | 'ceiling_minutes'
  >;
  const groups = new Map<string, Acc>();
  const at = (key: string | null): Acc | null =>
    key === null
      ? null
      : bucket(groups, key, () => ({
          tickets: new Set<string>(),
          mins: [],
          reentries: 0,
          check_runs: 0,
          check_failures: 0,
          questions: 0,
          handoffs: 0,
          stops: 0,
          permission_denials: 0,
        }));
  const keyOf = (r: { repo: string; machine_id: string | null }, state: string | null) =>
    groupBy === 'state'
      ? state === null
        ? 'unknown'
        : stateKey(state)
      : groupBy === 'repo'
        ? r.repo
        : groupBy === 'machine'
          ? (r.machine_id ?? 'none')
          : null;

  for (const s of stateDurations(rows.moves)) {
    const g = at(keyOf(s, s.state));
    if (g === null) continue;
    g.tickets.add(s.ticket_id);
    g.mins.push(s.minutes);
  }
  for (const m of rows.moves) {
    if (m.visit < 2) continue;
    const g = at(keyOf(m, m.to));
    if (g !== null) g.reentries++;
  }
  for (const c of rows.checks) {
    const g = at(groupBy === 'check' ? checkKey(c) : keyOf(c, c.state));
    if (g === null) continue;
    g.tickets.add(c.ticket_id);
    g.check_runs++;
    if (checkFailed(c)) g.check_failures++;
  }
  for (const r of rows.inputs) {
    const g = at(keyOf(r, r.state));
    if (g === null) continue;
    g.tickets.add(r.ticket_id);
    const cls = classOf(r);
    if (cls === 'question') g.questions++;
    else if (cls === 'handoff') g.handoffs++;
    else g.stops++;
  }
  for (const p of rows.permissions) {
    // A prompt has no state of its own: it counts under its repo or machine only.
    if (groupBy === 'state') continue;
    const g = at(keyOf(p, null));
    if (g === null) continue;
    if (p.status === 'denied' || p.status === 'expired') g.permission_denials++;
  }

  const all: ProcessGroup[] = [...groups.entries()].map(([key, g]) => {
    const wait = groupBy === 'state' ? rows.waits?.[key] : undefined;
    return {
      key,
      tickets: g.tickets.size,
      stays: g.mins.length,
      median_minutes: round1(median(g.mins)),
      p90_minutes: round1(percentile(g.mins, 0.9)),
      total_hours: round1(g.mins.reduce((a, b) => a + b, 0) / 60),
      reentries: g.reentries,
      check_runs: g.check_runs,
      check_failures: g.check_failures,
      questions: g.questions,
      handoffs: g.handoffs,
      stops: g.stops,
      permission_denials: g.permission_denials,
      waits_on_others: wait !== undefined,
      ceiling_minutes: wait?.ceiling_minutes ?? null,
    };
  });
  all.sort(
    (a, b) =>
      b.total_hours - a.total_hours ||
      b.check_failures - a.check_failures ||
      b.questions - a.questions ||
      a.key.localeCompare(b.key),
  );
  const tickets = new Set<string>();
  const sessions = new Set<string>();
  for (const list of [rows.moves, rows.checks, rows.inputs, rows.permissions]) {
    for (const r of list) {
      tickets.add(r.ticket_id);
      sessions.add(r.session_id);
    }
  }
  return {
    group_by: groupBy,
    totals: {
      tickets: tickets.size,
      sessions: sessions.size,
      moves: rows.moves.length,
      check_runs: rows.checks.length,
      questions: rows.inputs.filter((r) => classOf(r) === 'question').length,
      handoffs: rows.inputs.filter((r) => classOf(r) === 'handoff').length,
      stops: rows.inputs.filter((r) => classOf(r) === 'stop').length,
      permission_prompts: rows.permissions.length,
    },
    groups: all.slice(0, GROUPS_MAX),
    more_groups: Math.max(0, all.length - GROUPS_MAX),
    ...loopSummary(loopCounts(rows.moves)),
    ...pageCounts(rows.pages ?? []),
    ...presetUses(rows.preset_texts ?? []),
  };
}

/**
 * ADR-0037 P5: `{presets}` for ProcessMetrics. A text that equals one of its saved replies (both
 * trimmed) counts for that reply (every reply offered is listed, used or not); one that matches
 * none counts as typed. Nothing when no row offered a saved reply.
 */
export function presetUses(rows: readonly PresetTextRow[]): Pick<ProcessMetrics, 'presets'> {
  const offered = rows.filter((r) => r.presets.length > 0);
  if (offered.length === 0) return {};
  const uses = new Map<
    string,
    { workflow_id: string; slug: string; used: number; tickets: Set<string> }
  >();
  let typed = 0;
  for (const r of offered) {
    const text = r.text.trim();
    let matched = false;
    for (const p of r.presets) {
      const u = bucket(uses, `${r.workflow_id}\u0000${p.slug}`, () => ({
        workflow_id: r.workflow_id,
        slug: p.slug,
        used: 0,
        tickets: new Set<string>(),
      }));
      if (!matched && p.text.trim() === text) {
        matched = true;
        u.used++;
        u.tickets.add(r.ticket_id);
      }
    }
    if (!matched) typed++;
  }
  return {
    presets: {
      uses: [...uses.values()]
        .sort((a, b) => b.used - a.used || a.slug.localeCompare(b.slug))
        .map((u) => ({
          workflow_id: u.workflow_id,
          slug: u.slug,
          used: u.used,
          examples: [...u.tickets].slice(0, EXAMPLES_MAX),
        })),
      typed,
    },
  };
}

/** How many `(from, transition, cause)` loops a rework finding names. */
const LOOP_EVIDENCE_MAX = 3;

/**
 * ADR-0037 P7: the biggest `(from, transition, cause)` loops behind a rework finding: the
 * `tickets`' re-entries into `state` (any state for `qa_fail`), e.g. " Loops: implementing.
 * pr_ready_for_review → implementing (check_failed) ×4." Empty when there are none.
 */
function loopEvidence(moves: readonly MoveRow[], tickets: Set<string>, state: string): string {
  const mine = moves.filter(
    (m) => tickets.has(m.ticket_id) && (state === 'qa_fail' || stateKey(m.to) === state),
  );
  const loops = loopCounts(mine).loops.slice(0, LOOP_EVIDENCE_MAX);
  if (loops.length === 0) return '';
  const words = loops.map((l) =>
    l.cause === UNRECORDED_CAUSE
      ? `unrecorded (before ADR-0037) ×${l.count}`
      : `${l.from} → ${l.transition} (${l.cause}) ×${l.count}`,
  );
  return ` Loops: ${words.join('; ')}.`;
}

/** ProcessMetrics' `transitions`, `causes` and `loops`, capped. */
function loopSummary(c: LoopCounts): Pick<ProcessMetrics, 'transitions' | 'causes' | 'loops'> {
  return {
    transitions: c.transitions.slice(0, TRANSITIONS_MAX),
    causes: c.causes,
    loops: c.loops.slice(0, LOOPS_MAX).map(({ from, transition, cause, count, tickets }) => ({
      from,
      transition,
      cause,
      count,
      tickets,
    })),
  };
}

/** ADR-0038: `{pages}` for ProcessMetrics, or nothing when no page was attached. */
export function pageCounts(rows: readonly PageCountRow[]): Pick<ProcessMetrics, 'pages'> {
  const counted = rows.filter((r) => r.count > 0);
  if (counted.length === 0) return {};
  const byState: Record<string, number> = {};
  const byTicket = new Map<string, number>();
  let total = 0;
  for (const r of counted) {
    total += r.count;
    byState[r.state] = (byState[r.state] ?? 0) + r.count;
    byTicket.set(r.ticket_id, (byTicket.get(r.ticket_id) ?? 0) + r.count);
  }
  const by_ticket = [...byTicket]
    .map(([ticket_id, count]) => ({ ticket_id, count }))
    .sort((a, b) => b.count - a.count || a.ticket_id.localeCompare(b.ticket_id))
    .slice(0, EXAMPLES_MAX);
  return { pages: { total, by_state: byState, by_ticket } };
}

// ---------------------------------------------------------------- findings

export const FindingCategorySchema = z.enum([
  'slow_state',
  'failing_check',
  'permission_denials',
  'frequent_question',
  'rework_loop',
  /** P2: a friction the analyst sub-agents reported in many sessions (advisor/insight.ts). */
  'recurring_friction',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/** The tool (or place) that acts on a finding. `board`: only a human on the board can. */
export const SuggestedToolSchema = z.enum([
  'get_workflow',
  'save_workflow',
  'set_repo_checks',
  'get_ticket_artifacts',
  'board',
]);
export type SuggestedTool = z.infer<typeof SuggestedToolSchema>;

export const FindingSchema = z.object({
  /** Stable for the same data: `<category>:<key>`. */
  id: z.string(),
  category: FindingCategorySchema,
  /** 1 = worth a look, 2 = costs real time, 3 = fix first. */
  severity: z.number().int().min(1).max(3),
  title: z.string(),
  evidence: z.string(),
  example_ticket_ids: z.array(z.string()).max(EXAMPLES_MAX),
  suggested_tool: SuggestedToolSchema,
  suggestion: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** The heuristics' thresholds (ADR-0033), exported for the tests and the docs. */
export const FINDING_RULES = {
  /** A state whose median stay is more than this × the median of every stay. */
  slowStateFactor: 3,
  /** …with at least this many finished stays. */
  slowStateMinStays: 3,
  /** A check failing on more than this share of its runs… */
  checkFailureRate: 0.3,
  /** …with at least this many runs. */
  checkMinRuns: 3,
  /** A tool denied (or left unanswered) at least this often on one machine. */
  permissionDenials: 3,
  /** A state asking a human in more than this share of the tickets that entered it… */
  questionShare: 0.25,
  /** …and in at least this many tickets. */
  questionMinTickets: 2,
  /** A ticket that took `qa_fail`, or re-entered one state, at least this many times. */
  reworkLoops: 2,
} as const;

const CATEGORY_ORDER: FindingCategory[] = FindingCategorySchema.options;

/**
 * The deterministic findings, most severe first: what costs the account time, with the evidence,
 * example tickets to drill into, and the tool that would change it. `extra`: findings from
 * elsewhere (P2: `insightFindings`), ranked with them.
 */
export function rankFindings(rows: AdvisorRows, extra: readonly Finding[] = []): Finding[] {
  const R = FINDING_RULES;
  const out: Finding[] = [...extra];

  // Slow states: median stay well above the median of every stay. States and gates that wait on
  // someone outside by design (`rows.waits`: an approval, an event) are neither slow nor part of
  // the baseline; get_process_metrics marks them `waits_on_others` with their ceiling.
  const spans = stateDurations(rows.moves).filter((s) => rows.waits?.[s.state] === undefined);
  const overall = median(spans.map((s) => s.minutes));
  const byState = new Map<string, StateSpan[]>();
  for (const s of spans) bucket(byState, s.state, () => []).push(s);
  for (const [state, list] of byState) {
    if (list.length < R.slowStateMinStays || overall <= 0) continue;
    const m = median(list.map((s) => s.minutes));
    const factor = m / overall;
    if (factor <= R.slowStateFactor) continue;
    const examples: string[] = [];
    for (const s of [...list].sort((a, b) => b.minutes - a.minutes))
      addExample(examples, s.ticket_id);
    out.push({
      id: `slow_state:${state}`,
      category: 'slow_state',
      severity: factor > 2 * R.slowStateFactor ? 3 : 2,
      title: `Tickets spend long in ${state}`,
      evidence:
        `Median stay ${round1(m)} min over ${list.length} stays, ${round1(factor)}× the ` +
        `median of every state (${round1(overall)} min).`,
      example_ticket_ids: examples,
      suggested_tool: 'get_workflow',
      suggestion:
        `Read ${state} with get_workflow (its prompt, timeouts and requires), then the slowest ` +
        'tickets’ results with get_ticket_artifacts, to see what it waits on.',
    });
  }

  // Failing checks (by name; a failed setup on its own). The pin check only records the commit: a
  // dirty tree is the agent's slip, not a check to fix.
  for (const c of checkFailureRates(rows.checks)) {
    if (c.role === 'pin') continue;
    if (c.runs < R.checkMinRuns || c.failure_rate <= R.checkFailureRate) continue;
    const isSetup = c.role === 'setup';
    const why =
      c.setup_failures > 0
        ? `${c.setup_failures} failed in setup`
        : c.timeouts > 0
          ? `${c.timeouts} timed out`
          : 'non-zero exits';
    const what = isSetup
      ? c.source === 'repo'
        ? 'repo setup'
        : 'workflow setup'
      : c.source === 'repo'
        ? 'repo check'
        : c.source === 'workflow'
          ? 'workflow check'
          : 'check';
    out.push({
      id: `failing_check:${isSetup ? 'setup:' : ''}${c.check.slice(0, 80)}`,
      category: 'failing_check',
      severity: c.failure_rate > 2 * R.checkFailureRate || c.setup_failures > 0 ? 3 : 2,
      title: isSetup
        ? `${c.source === 'repo' ? 'Repo' : 'Workflow'} setup fails often`
        : `Check fails often: ${c.check.slice(0, 80)}`,
      evidence:
        `${c.failures} of ${c.runs} runs failed (${Math.round(c.failure_rate * 100)} %; ${why}) ` +
        `in ${c.states.join(', ')} (${what}).`,
      example_ticket_ids: c.examples,
      suggested_tool: 'set_repo_checks',
      suggestion:
        c.setup_failures > 0
          ? 'Setup fails before the check runs: give the repo its own setup with set_repo_checks.'
          : 'Read a failing ticket’s results; if the check does not fit the repo, replace it ' +
            'with set_repo_checks (one repo) rather than the workflow (every repo).',
    });
  }

  // Permission denials.
  for (const p of permissionStats(rows.permissions)) {
    if (p.denied < R.permissionDenials) continue;
    out.push({
      id: `permission_denials:${p.machine_id}:${p.tool}`,
      category: 'permission_denials',
      severity: p.denied >= 3 * R.permissionDenials ? 3 : 2,
      title: `${p.tool} keeps being denied on machine ${p.machine_id}`,
      evidence:
        `${p.denied} of ${p.prompts} permission prompts for ${p.tool} were denied or went ` +
        `unanswered (${p.allowed} allowed, ${p.allowed_always} always).`,
      example_ticket_ids: p.examples,
      suggested_tool: 'board',
      suggestion:
        p.rule !== null
          ? `If it is safe, choose "Allow always" on the next prompt (records \`${p.rule}\`); ` +
            'permission prompts and machine rules stay on the board.'
          : 'Agents keep needing this tool: decide on the board whether this machine should ' +
            'allow it; permission prompts and machine rules stay on the board.',
    });
  }

  // Frequent questions: asked in many of the tickets that entered the state.
  const entered = new Map<string, Set<string>>();
  for (const m of rows.moves) bucket(entered, stateKey(m.to), () => new Set()).add(m.ticket_id);
  for (const q of inputStats(rows.inputs)) {
    const base = entered.get(q.state)?.size ?? 0;
    if (q.tickets < R.questionMinTickets || base === 0) continue;
    const share = q.tickets / base;
    if (share <= R.questionShare) continue;
    out.push({
      id: `frequent_question:${q.state}`,
      category: 'frequent_question',
      severity: share > 2 * R.questionShare ? 3 : 2,
      title: `${q.state} often stops to ask a human`,
      evidence:
        `${q.asked} questions in ${q.tickets} of ${base} tickets (${Math.round(share * 100)} %); ` +
        `median answer ${q.median_answer_minutes} min.`,
      example_ticket_ids: q.examples,
      suggested_tool: 'save_workflow',
      suggestion:
        'Read the questions (get_ticket_artifacts on the examples). If they repeat, put the ' +
        `answer in ${q.state}’s prompt, or ask for it up front as a ticket field, with save_workflow.`,
    });
  }

  // Rework loops.
  const loops = loopCounts(rows.moves).tickets.filter(
    (t) => t.qa_fail >= R.reworkLoops || t.extra_visits >= R.reworkLoops,
  );
  const byLoopState = new Map<string, typeof loops>();
  for (const t of loops) {
    bucket(byLoopState, t.qa_fail >= R.reworkLoops ? 'qa_fail' : t.state, () => []).push(t);
  }
  for (const [key, list] of byLoopState) {
    const examples: string[] = [];
    for (const t of list) addExample(examples, t.ticket_id);
    out.push({
      id: `rework_loop:${key}`,
      category: 'rework_loop',
      severity: list.length >= 3 ? 3 : 2,
      title:
        key === 'qa_fail' ? 'Tickets fail QA repeatedly' : `Tickets keep coming back to ${key}`,
      evidence:
        (key === 'qa_fail'
          ? `${list.length} tickets took qa_fail ${R.reworkLoops}+ times.`
          : `${list.length} tickets re-entered ${key} ${R.reworkLoops}+ extra times.`) +
        loopEvidence(rows.moves, new Set(list.map((t) => t.ticket_id)), key),
      example_ticket_ids: examples,
      suggested_tool: 'get_ticket_artifacts',
      suggestion:
        'Compare the results of each round (get_ticket_artifacts `results`): a requirement the ' +
        'agent keeps missing belongs in the prompt or the checks.',
    });
  }

  return out.sort(
    (a, b) =>
      b.severity - a.severity ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      a.id.localeCompare(b.id),
  );
}
