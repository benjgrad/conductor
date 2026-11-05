import { isGithubPrUrl, sessionBranch, type JsonObject } from '../domain.js';
import {
  EvaluateConditionsResultSchema,
  NO_PR_CHECKS_VALUE,
  type ConditionResult,
  type EvaluateConditionsArgs,
} from '../protocol/ws.js';
import {
  conditionEnabled,
  conditionLabel,
  DEFAULT_CONDITION_POLL,
  ENGINE_CONDITION_TYPES,
  MAX_CONDITION_POLL,
  noChecksPolicy,
  parseDuration,
  type Condition,
  type ConditionType,
} from '../workflow/schema.js';
import { PR_CONTEXT_KEY } from './review.js';
import type { ConditionStatus, GateStep, SessionSnapshot } from './types.js';

// ADR-0011 (M1b-T08): the conditions phase of a move step, the pure parts. apply.ts drives it:
// start (status `waiting_external`, one `run_action evaluate_conditions`, a poll timer capped at
// `condition_timeout`), a result (all met → `to`; any failed → `on_unmet.goto`, counted; else
// pending → re-poll with backoff), a refusal or a poll with no answer ("waiting for a machine",
// U-058), the timeout (→ `on_unmet.else`, kind `timeout`, the checklist as the question, U-063).
// See 05 §Conditions.

/** The condition types that read conductor's pull request (`context.__pr.pr_url`). */
export const PR_CONDITION_TYPES: ReadonlySet<ConditionType> = new Set([
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
  'pr_screenshots',
  'pr_mergeable',
]);

/**
 * `condition_timeout` when a definition has conditions but no timeout. The validator refuses that
 * (rule 13), so only an invalid stored version reaches it; it keeps the phase bounded anyway.
 */
export const FALLBACK_CONDITION_TIMEOUT = '1d';

/** The first poll interval (ms): `requires.condition_poll`, else DEFAULT_CONDITION_POLL. */
export function basePollMs(poll: string | undefined): number {
  return parseDuration(poll ?? DEFAULT_CONDITION_POLL);
}

/** The backoff cap (ms), MAX_CONDITION_POLL (never below the base interval). */
export function maxPollMs(base: number): number {
  return Math.max(base, parseDuration(MAX_CONDITION_POLL));
}

/**
 * The next poll interval: the base after a changed result (or the first one), doubled after an
 * unchanged one, capped at `maxPollMs`.
 */
export function nextPollMs(current: number | null, base: number, unchanged: boolean): number {
  if (!unchanged || current === null) return base;
  return Math.min(current * 2, maxPollMs(base));
}

/** The next timer: `now + poll`, never past `conditions_deadline`. */
export function pollDeadline(now: Date, pollMs: number, conditionsDeadline: string): string {
  return new Date(Math.min(now.getTime() + pollMs, Date.parse(conditionsDeadline))).toISOString();
}

/** One status per declared condition (declaration order): enabled ones `todo`, others `disabled`. */
export function initialStatuses(conditions: readonly Condition[]): ConditionStatus[] {
  return conditions.map((c) => ({
    type: c.type,
    label: conditionLabel(c),
    status: conditionEnabled(c) ? 'todo' : 'disabled',
    value: null,
    detail: null,
    checked_at: null,
  }));
}

/** Indexes (into the declared list) of the enabled conditions: the ones evaluated, in order. */
export function enabledIndexes(conditions: readonly Condition[]): number[] {
  return conditions.flatMap((c, i) => (conditionEnabled(c) ? [i] : []));
}

/**
 * Indexes of the enabled conditions the daemon evaluates (ADR-0037: engine-only types such as
 * `age_below` are left out); `results[k]` answers `daemonIndexes(conditions)[k]`.
 */
export function daemonIndexes(conditions: readonly Condition[]): number[] {
  return enabledIndexes(conditions).filter((i) => !ENGINE_CONDITION_TYPES.has(conditions[i]!.type));
}

/** An evaluation is in flight: some enabled condition is `running`. */
export function evaluationInFlight(step: GateStep): boolean {
  return step.conditions.some((c) => c.status === 'running');
}

/** Mark every enabled condition `running` (an evaluation was sent); its last value is kept. */
export function markRunning(statuses: ConditionStatus[]): ConditionStatus[] {
  return statuses.map((c) => (c.status === 'disabled' ? c : { ...c, status: 'running' }));
}

/**
 * The evaluation came back without an answer (refused, an error, a malformed result): a
 * `running` condition goes back to `todo` if it was never answered, else `pending`.
 */
export function unmarkRunning(statuses: ConditionStatus[]): ConditionStatus[] {
  return statuses.map((c) =>
    c.status !== 'running' ? c : { ...c, status: c.checked_at === null ? 'todo' : 'pending' },
  );
}

/** `context.__pr.pr_url` when it is a GitHub PR URL (ADR-0010 hardening: never an agent's value). */
export function conductorPrUrl(s: SessionSnapshot): string | null {
  const url = s.context[PR_CONTEXT_KEY]?.pr_url;
  return isGithubPrUrl(url) ? url : null;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * `run_action evaluate_conditions` args: the enabled daemon-side conditions (declaration order),
 * conductor's PR, the session branch, and `head_sha` = the commit conductor checked and pushed (the
 * step's `head_sha`, ADR-0010 `expected_sha`) when there is one: the daemon then fails every PR
 * condition if someone pushed to the branch. ADR-0037: `setup` is the fresh checkout's setup for
 * `cmd` conditions; `short_circuit` (watches, T6) stops at the first condition not met.
 */
export function evaluateConditionsArgs(
  s: SessionSnapshot,
  step: GateStep,
  conditions: readonly Condition[],
  opts: { setup?: string | null; short_circuit?: boolean } = {},
): JsonObject {
  const args: EvaluateConditionsArgs = {
    conditions: daemonIndexes(conditions).map((i) => forDaemon(conditions[i]!)),
    pr_url: conductorPrUrl(s),
    branch: s.branch ?? sessionBranch(s.ticket, s.id),
    ...(step.head_sha !== null && SHA_RE.test(step.head_sha) ? { head_sha: step.head_sha } : {}),
    // Only with a `cmd` that runs the setup: an older daemon never sees the key otherwise.
    ...(opts.setup !== undefined &&
    conditions.some((c) => conditionEnabled(c) && c.type === 'cmd' && c.needs !== 'checkout')
      ? { setup: opts.setup }
      : {}),
    ...(opts.short_circuit === true ? { short_circuit: true } : {}),
  };
  return args as unknown as JsonObject;
}

/**
 * A condition as the daemon sees it: `no_checks_after` is the engine's rule (U-072), and a daemon
 * that predates it would refuse the unknown key (the condition schema is strict). `no_checks`
 * (ADR-0037 P3) is sent: the daemon reads its policy to report `mergeable`.
 * TD-195: `pr_screenshots` (M2-T35a) is sent as is. A daemon before M2-T35a refuses the args, which
 * reads as "no answer": the card notes it and the step polls to `condition_timeout`, then a human.
 * Update the daemons before shipping a workflow that uses it (no per-machine capability gate yet).
 * TD-217: the same holds for `cmd`, `pr_mergeable`, `no_checks` and `short_circuit` (ADR-0037).
 */
function forDaemon(c: Condition): Condition {
  if (c.type !== 'pr_checks_green' || c.no_checks_after === undefined) return c;
  const rest = { ...c };
  delete rest.no_checks_after;
  return rest;
}

/** `1h 5m`, `37m`, `12s`: a short human duration. */
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * ADR-0037 P2 `age_below`, evaluated by the engine: met while the time in the current state
 * (`now − state_entered_at`) is below `max`, failed from then on.
 */
export function evaluateAgeBelow(
  c: Extract<Condition, { type: 'age_below' }>,
  stateEnteredAt: string,
  now: Date,
): ConditionResult {
  const age = now.getTime() - Date.parse(stateEnteredAt);
  const value = humanDuration(age);
  if (age < parseDuration(c.max)) {
    return { type: 'age_below', status: 'met', value, detail: null };
  }
  return {
    type: 'age_below',
    status: 'failed',
    value,
    detail: `here for ${value}, longer than ${c.max}`,
  };
}

/**
 * U-072 / ADR-0037 P3: `pr_checks_green` whose PR still reports no checks at all `after` that
 * long since the conditions started follows its no-CI policy (`no_checks_after: X` reads as
 * `{policy: 'pass', after: X}`): `pass` → met; `fail` → failed; `require_mergeable` → met when the
 * same evaluation reports MERGEABLE, failed when CONFLICTING, else pending. Anything else is
 * unchanged.
 */
export function noChecksGrace(
  c: Condition,
  res: ConditionResult,
  now: Date,
  startedAt: string | null,
): ConditionResult {
  if (c.type !== 'pr_checks_green') return res;
  const policy = noChecksPolicy(c);
  if (policy === undefined) return res;
  if (res.status !== 'pending' || res.value !== NO_PR_CHECKS_VALUE || startedAt === null)
    return res;
  if (now.getTime() - Date.parse(startedAt) < parseDuration(policy.after)) return res;
  const within = `no CI checks reported within ${policy.after}`;
  switch (policy.policy) {
    case 'pass':
      return { ...res, status: 'met', detail: within };
    case 'fail':
      return { ...res, status: 'failed', detail: `${within} (policy: fail)` };
    case 'require_mergeable':
      if (res.mergeable === 'MERGEABLE') {
        return { ...res, status: 'met', detail: `${within}; GitHub says the PR merges cleanly` };
      }
      if (res.mergeable === 'CONFLICTING') {
        return {
          ...res,
          status: 'failed',
          detail: `${within}, and the PR conflicts with its base branch: merge the base branch into it`,
        };
      }
      return {
        ...res,
        status: 'pending',
        detail:
          res.mergeable === 'UNKNOWN'
            ? `${within}; GitHub is still computing whether the PR merges cleanly`
            : `${within}; this machine's daemon did not report mergeability (update it)`,
      };
  }
}

/** A failed condition's evidence for the feedback: `- <type>: failed (<detail>; last value …)`. */
export interface ConditionEvidence {
  item: string;
  reason: string;
}

function evidence(c: ConditionStatus): string {
  const parts = [c.detail, c.value !== null ? `last value ${c.value}` : null].filter(
    (p): p is string => p !== null && p.trim() !== '',
  );
  return parts.length > 0 ? parts.join('; ') : 'no detail';
}

/** ADR-0037 FR-9: a `cmd` is named by its label (its name), never by the command it runs. */
export function failedEvidence(c: ConditionStatus): ConditionEvidence {
  return { item: c.type === 'cmd' ? c.label : c.type, reason: `failed (${evidence(c)})` };
}

/**
 * Enabled PR conditions when conductor has no PR (no `context.__pr`): they can't be evaluated
 * and won't become true, so they are failed at once (→ `on_unmet.else`, uncounted) instead of polling to the
 * timeout. null when there is a PR or no enabled PR condition.
 */
export function failWithoutPr(
  s: SessionSnapshot,
  conditions: readonly Condition[],
  statuses: ConditionStatus[],
  now: Date,
): ConditionStatus[] | null {
  if (conductorPrUrl(s) !== null) return null;
  if (!conditions.some((c) => conditionEnabled(c) && PR_CONDITION_TYPES.has(c.type))) return null;
  return statuses.map((st, i) =>
    st.status !== 'disabled' && PR_CONDITION_TYPES.has(conditions[i]!.type)
      ? {
          ...st,
          status: 'failed',
          detail:
            'conductor has no pull request for this ticket (no open_pr ran before this check), so it cannot be checked',
          checked_at: now.toISOString(),
        }
      : st,
  );
}

/** What an `evaluate_conditions` result says, merged into the step's statuses. */
export type ConditionsVerdict =
  | { type: 'malformed'; why: string }
  | {
      type: 'answered';
      statuses: ConditionStatus[];
      /** Every enabled condition reported the same status, value and detail as last time. */
      unchanged: boolean;
      outcome: 'met' | 'failed' | 'pending';
    };

/** What `mergeResults` needs besides the result. */
export interface MergeOptions {
  /** The step's `conditions_started_at`: times the `pr_checks_green` no-CI policy. */
  startedAt?: string | null;
  /** The session's `state_entered_at`: what `age_below` measures (ADR-0037). */
  stateEnteredAt?: string | null;
}

/**
 * Merge a result (`results[k]` answers `daemonIndexes(conditions)[k]`, by position) into the step's
 * statuses; engine-only conditions (`age_below`) are evaluated here. Any `failed` → failed; all
 * `met` → met; anything else (`pending`, `unsupported`, `skipped`) → pending. A result of the wrong
 * length or types is malformed (kept pending by the caller). `result` null = no daemon conditions.
 */
export function mergeResults(
  statuses: ConditionStatus[],
  conditions: readonly Condition[],
  result: JsonObject | null,
  now: Date,
  opts: MergeOptions = {},
): ConditionsVerdict {
  const idx = daemonIndexes(conditions);
  let results: ConditionResult[] = [];
  if (idx.length > 0 || result !== null) {
    const parsed = EvaluateConditionsResultSchema.safeParse(result);
    if (!parsed.success) return { type: 'malformed', why: 'the result has the wrong shape' };
    results = parsed.data.results;
  }
  if (results.length !== idx.length) {
    return {
      type: 'malformed',
      why: `${results.length} result${results.length === 1 ? '' : 's'} for ${idx.length} condition${idx.length === 1 ? '' : 's'}`,
    };
  }
  const answers = new Map<number, ConditionResult>();
  for (const [k, i] of idx.entries()) {
    const raw = results[k]!;
    if (raw.type !== conditions[i]!.type) {
      return {
        type: 'malformed',
        why: `result ${k + 1} is ${raw.type}, not ${conditions[i]!.type}`,
      };
    }
    answers.set(i, noChecksGrace(conditions[i]!, raw, now, opts.startedAt ?? null));
  }
  for (const i of enabledIndexes(conditions)) {
    const c = conditions[i]!;
    if (c.type !== 'age_below') continue;
    answers.set(
      i,
      opts.stateEnteredAt != null
        ? evaluateAgeBelow(c, opts.stateEnteredAt, now)
        : { type: c.type, status: 'pending', value: null, detail: 'no state entry time' },
    );
  }
  const next = statuses.map((c) => ({ ...c }));
  let unchanged = true;
  for (const [i, res] of answers) {
    const prev = next[i]!;
    // `running` hides the previous status: compare what was observed (value and detail), and
    // count a first answer (never checked) as a change.
    if (prev.checked_at === null || prev.value !== res.value || prev.detail !== res.detail) {
      unchanged = false;
    }
    next[i] = {
      ...prev,
      status: res.status,
      value: res.value,
      detail: res.detail,
      checked_at: now.toISOString(),
      answer: res.status,
    };
  }
  const answered = enabledIndexes(conditions).map((i) => next[i]!.status);
  const outcome = answered.includes('failed')
    ? 'failed'
    : answered.every((s) => s === 'met')
      ? 'met'
      : 'pending';
  return { type: 'answered', statuses: next, unchanged, outcome };
}

/** The checklist as lines for a human, e.g. `- PR approved: pending (0/1): waiting for review`. */
export function checklistLines(statuses: readonly ConditionStatus[]): string[] {
  return statuses.map((c) => {
    const value = c.value !== null ? ` (${c.value})` : '';
    const detail = c.detail !== null && c.detail.trim() !== '' ? `: ${c.detail}` : '';
    return `- ${c.label}: ${c.status}${value}${detail}`;
  });
}
