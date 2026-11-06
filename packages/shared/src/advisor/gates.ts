import { PIN_CHECK } from '../engine/move-step.js';
import type { RepoChecks } from '../workflow/repo-checks.js';
import {
  parseDuration,
  type TransitionObject,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { transitionObject } from '../workflow/transition-rules.js';

// ADR-0033 (workflow advisor): how the process metrics name what they count. Pure helpers the
// orchestrator's loader (advisor/queries.ts) uses to label rows with what their workflow
// definition says, so the metrics themselves (metrics.ts) stay definition-free.

// ---------------------------------------------------------------- gate keys

const GATE_LABEL = /^(.+) → (.+) \((entry|review|move: (.+))\)$/;

/**
 * The stable key of a state or gate step across workflow versions. A gate step's synthetic label
 * (`engine/types.ts moveStateLabel`, `engine/review.ts entryStateLabel` / `reviewStateLabel`) names
 * its target, which a workflow edit can change while the gate stays the same:
 * - `X → Y (move: n)` → `X.n` (the transition, as `checksGatesOf` names it);
 * - `X → Y (entry)` → `Y.entry` (the entry requirements of Y);
 * - `X → Y (review)` → `X.review`.
 * A real state name is returned as is.
 */
export function stateKey(label: string): string {
  const m = GATE_LABEL.exec(label);
  if (m === null) return label;
  const [, from, to, kind, move] = m;
  if (move !== undefined) return `${from}.${move}`;
  return kind === 'entry' ? `${to}.entry` : `${from}.review`;
}

// ---------------------------------------------------------------- definitions

/** Workflow definitions by `${id}@${version}` (the versions the rows' sessions ran). */
export type AdvisorDefs = ReadonlyMap<string, WorkflowDefinition>;

export const defKey = (id: string, version: number): string => `${id}@${version}`;

/** The object form of `def.states[from].on[name]`, or undefined. */
export function transitionOf(
  def: Pick<WorkflowDefinition, 'states'>,
  from: string,
  name: string,
): TransitionObject | undefined {
  const s = def.states[from];
  if (s === undefined || s.type === 'terminal') return undefined;
  const raw = s.on?.[name];
  return raw === undefined ? undefined : transitionObject(raw);
}

/**
 * A `question: true` transition that ships work through a gate (it has `requires`): the agent's
 * `reason` is a summary of finished work for the human to review (a PR hand-off), not a question.
 * `ask_user`, `needs_approval_to_message` and the planning questions have no `requires`.
 */
export function isHandoffTransition(
  def: Pick<WorkflowDefinition, 'states'>,
  from: string,
  name: string,
): boolean {
  const t = transitionOf(def, from, name);
  return t !== undefined && t.question === true && t.requires !== undefined;
}

/** What one input request was: a question to a human, a hand-off of finished work, or a stop. */
export type InputClass = 'question' | 'handoff' | 'stop';

/**
 * - `stop`: the engine stopped and asked a human (timeout, retries ran out, budget, an approval,
 *   a lost machine): not the agent asking.
 * - `handoff`: a request of kind `handoff` (ADR-0037 P8), or an `agent_question` opened by a
 *   legacy hand-off transition (`isHandoffTransition`).
 * - `question`: any other `agent_question` (`ask_user`, `needs_approval_to_message`, planning).
 * `from`: the state the transition left (a gate label is resolved to its source). With no
 * definition, a transition named `…ready_for_review` is taken as a hand-off.
 */
export function inputClass(
  row: { kind: string; transition: string | null; from: string | null },
  def: Pick<WorkflowDefinition, 'states'> | undefined,
): InputClass {
  // ADR-0037 P8: a `handoff` request is a hand-off by kind; older rows are told apart below.
  if (row.kind === 'handoff') return 'handoff';
  if (row.kind !== 'agent_question') return 'stop';
  if (row.transition === null) return 'question';
  if (def === undefined)
    return row.transition.endsWith('ready_for_review') ? 'handoff' : 'question';
  if (row.from === null) return 'question';
  return isHandoffTransition(def, gateSource(row.from), row.transition) ? 'handoff' : 'question';
}

/** The source state of a gate label (`X → Y (…)` → `X`); a state name as is. */
export function gateSource(label: string): string {
  const m = GATE_LABEL.exec(label);
  return m === null ? label : m[1]!;
}

/** Conditions that wait on a person (or an outside system's people), not on conductor or CI. */
const EXTERNAL_CONDITIONS: ReadonlySet<string> = new Set(['pr_approvals', 'jira_fields_set']);

export interface WaitsOnOthers {
  /** How long the definition lets it wait (`condition_timeout`, an event state's `timeout`). */
  ceiling_minutes: number | null;
}

const minutes = (d: string | undefined): number | null =>
  d === undefined ? null : Math.round(parseDuration(d) / 60_000);

/**
 * Does the state or gate `key` (a `stateKey`) wait on someone outside by design, in any of `defs`?
 * - an `event` state (e.g. `waiting_external`, `wait_for: ui.approve`), with its `timeout`;
 * - a transition gate `X.n` whose `requires.conditions` has an enabled `pr_approvals` or
 *   `jira_fields_set`, with its `condition_timeout`.
 * Human states are not included: their wait is the user's own response time, which is real
 * friction the advisor should show. The ceiling is the largest across versions.
 */
export function waitsOnOthers(
  defs: Iterable<WorkflowDefinition>,
  key: string,
): WaitsOnOthers | null {
  let found = false;
  let ceiling: number | null = null;
  const take = (m: number | null) => {
    found = true;
    if (m !== null) ceiling = Math.max(ceiling ?? 0, m);
  };
  const dot = key.lastIndexOf('.');
  for (const def of defs) {
    const s = def.states[key];
    if (s !== undefined) {
      if (s.type === 'event') take(minutes(s.timeout));
      continue;
    }
    if (dot <= 0) continue;
    const t = transitionOf(def, key.slice(0, dot), key.slice(dot + 1));
    const req = t?.requires;
    if (
      req?.conditions?.some((c) => c.enabled !== false && EXTERNAL_CONDITIONS.has(c.type)) === true
    ) {
      take(minutes(req.condition_timeout));
    }
  }
  return found ? { ceiling_minutes: ceiling } : null;
}

// ---------------------------------------------------------------- check identity

export type CheckRole = 'check' | 'setup' | 'pin';
export type CheckSource = 'repo' | 'workflow' | 'unknown';

export interface CheckIdentity {
  name: string;
  role: CheckRole;
  source: CheckSource;
}

const NAME_CLIP = 80;
const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** The declared checks (and setup) of the gate `key` (`X.n` or `Y.entry`) in `def`. */
function gateChecks(
  def: Pick<WorkflowDefinition, 'states'> | undefined,
  key: string,
): { setup: string | undefined; checks: readonly { name: string; cmd: string }[] } | null {
  if (def === undefined) return null;
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return null;
  const head = key.slice(0, dot);
  const tail = key.slice(dot + 1);
  if (tail === 'entry') {
    const entry = def.states[head]?.entry;
    return entry === undefined ? null : { setup: entry.setup, checks: entry.checks ?? [] };
  }
  const req = transitionOf(def, head, tail)?.requires;
  return req === undefined ? null : { setup: req.setup, checks: req.checks ?? [] };
}

/**
 * What a check run was, by name (the run_cmd payload carries only the command: TD-201):
 * - a failed setup (`setup_failed`) is the gate's `setup`, from the repo override or the workflow;
 * - else the repo override's check with that command, then the gate's own declared check;
 * - else conductor's implicit "committed work" check (`PIN_CHECK`);
 * - else the command itself, clipped.
 * `repoChecks` is the repo's override as it is now, so a check renamed since keeps its new name.
 */
export function checkIdentity(o: {
  cmd: string;
  setup_failed: boolean;
  gateKey: string;
  def: Pick<WorkflowDefinition, 'states'> | undefined;
  repoChecks: RepoChecks | null | undefined;
}): CheckIdentity {
  const gate = gateChecks(o.def, o.gateKey);
  if (o.setup_failed) {
    return o.repoChecks != null
      ? { name: 'Repo setup', role: 'setup', source: 'repo' }
      : { name: 'Workflow setup', role: 'setup', source: gate !== null ? 'workflow' : 'unknown' };
  }
  const repo = o.repoChecks?.checks.find((c) => c.cmd === o.cmd);
  if (repo !== undefined) return { name: repo.name, role: 'check', source: 'repo' };
  const own = gate?.checks.find((c) => c.cmd === o.cmd);
  if (own !== undefined) return { name: own.name, role: 'check', source: 'workflow' };
  if (o.cmd === PIN_CHECK.cmd) return { name: PIN_CHECK.name, role: 'pin', source: 'workflow' };
  return { name: clip(o.cmd, NAME_CLIP), role: 'check', source: 'unknown' };
}
