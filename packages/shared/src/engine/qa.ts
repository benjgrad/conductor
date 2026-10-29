import { isGithubPrUrl, type JsonObject } from '../domain.js';
import { GitShaSchema } from '../protocol/actions.js';
import { stateTitle } from '../workflow/conductor.js';
import type { AgentState, WorkflowDefinition, WorkflowState } from '../workflow/schema.js';
import { isCountedTransition, transitionObject } from '../workflow/transition-rules.js';
import {
  QA_CONTEXT_KEY,
  QaContextSchema,
  QaResultSchema,
  type QaContext,
  type QaResult,
} from './qa.types.js';
import { renderPrompt } from './render.js';
import { PR_CONTEXT_KEY } from './review.js';
import { promptTransitions, ticketKind } from './transitions.js';
import type { Effect, SessionSnapshot } from './types.js';

// ADR-0020 §2: the QA state (`role: 'qa'`). Pure helpers; apply.ts only routes to them, so a
// definition without `role` never reaches this file (M2r-T03 NFR-2).

type Context = SessionSnapshot['context'];

export type QaState = AgentState & { role: 'qa' };

export function isQaState(state: WorkflowState | undefined): state is QaState {
  return state?.type === 'agent' && state.role === 'qa';
}

/** The transitions a QA result is checked against (ADR-0020 §2 Outcomes). */
const PASS_TRANSITIONS: readonly string[] = ['qa_pass', 'qa_pass_work'];
const FAIL_TRANSITION = 'qa_fail';

/**
 * The counted loop out of a QA state that sends the findings back: `qa_fail`, else the first
 * counted `attach: 'result'` transition. Its `<qa>-><goto>` counter is the QA round.
 */
export function qaFailTransition(
  def: Pick<WorkflowDefinition, 'states' | 'budget'>,
  qa: string,
): { name: string; goto: string; key: string; cap: number } | null {
  const state = def.states[qa];
  if (state === undefined || state.type === 'terminal') return null;
  const entries = Object.entries(state.on ?? {});
  const found =
    entries.find(([n, t]) => n === FAIL_TRANSITION && isCountedTransition(t)) ??
    entries.find(([, t]) => isCountedTransition(t) && transitionObject(t).attach === 'result');
  if (found === undefined) return null;
  const t = transitionObject(found[1]);
  return {
    name: found[0],
    goto: t.goto,
    key: `${qa}->${t.goto}`,
    cap: t.retries ?? def.budget.max_loop_retries,
  };
}

export function qaOf(context: Context): QaContext | null {
  const parsed = QaContextSchema.safeParse(context[QA_CONTEXT_KEY]);
  return parsed.success ? parsed.data : null;
}

export function withQa(context: Context, qa: QaContext): Context {
  return { ...context, [QA_CONTEXT_KEY]: qa as unknown as JsonObject };
}

/** Patch the current `__qa` (no-op without one). */
export function patchQa(context: Context, patch: Partial<QaContext>): Context {
  const qa = qaOf(context);
  return qa === null ? context : withQa(context, { ...qa, ...patch });
}

function prOf(context: Context): { pr_url: string; head_sha: string | null } | null {
  const pr = context[PR_CONTEXT_KEY];
  const url = pr?.pr_url;
  if (typeof url !== 'string' || !isGithubPrUrl(url)) return null;
  const sha = GitShaSchema.safeParse(pr?.head_sha);
  return { pr_url: url, head_sha: sha.success ? sha.data : null };
}

/** The `retry_counters` key of "this QA visit was nudged once" (`__qa` is a closed shape). */
export function qaNudgeKey(qa: string): string {
  return `qa_nudge:${qa}`;
}

export const QA_NO_PR_QUESTION =
  'Nothing to QA: no pull request. Open one (back to Implementing), or close the ticket.';

/**
 * FR-1: what entering QA state `name` writes, or why it can't start (→ a human, uncounted).
 * The commit is the head `inspect_pr` / `merge_pr` observed (`__qa.next_sha`, M2r-T04), else the
 * one conductor checked and pushed (`__pr.head_sha`).
 */
export function planQaEntry(
  def: Pick<WorkflowDefinition, 'states' | 'budget'>,
  s: Pick<SessionSnapshot, 'context' | 'retry_counters'>,
  name: string,
): { ok: true; qa: QaContext } | { ok: false; question: string } {
  const pr = prOf(s.context);
  if (pr === null) return { ok: false, question: QA_NO_PR_QUESTION };
  const sha = qaOf(s.context)?.next_sha ?? pr.head_sha;
  if (sha === null) {
    return {
      ok: false,
      question: `Nothing to QA: conductor has no recorded commit for the pull request ${pr.pr_url}. Back to Implementing to push it again, or close the ticket.`,
    };
  }
  const fail = qaFailTransition(def, name);
  // QaContextSchema caps rounds at 11.
  const max = Math.min(11, (fail?.cap ?? 0) + 1);
  const taken = fail === null ? 0 : (s.retry_counters[fail.key] ?? 0);
  return {
    ok: true,
    qa: {
      head_sha: sha,
      verdict: null,
      round: Math.min(max, taken + 1),
      max_rounds: max,
      claude_session_id: null,
    },
  };
}

/** FR-3: the result parsed and checked against the transition the QA named. */
export function checkQaResult(
  transition: string,
  result: JsonObject,
): { ok: true; result: QaResult } | { ok: false; why: string } {
  const parsed = QaResultSchema.safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return { ok: false, why: `the result is not a QaResult (${at}${issue?.message ?? 'invalid'})` };
  }
  const r = parsed.data;
  const fixes = r.required_fixes.length;
  if (PASS_TRANSITIONS.includes(transition)) {
    if (r.verdict === 'fail') return { ok: false, why: `${transition} with verdict "fail"` };
    if (fixes > 0) {
      return {
        ok: false,
        why: `${transition} with ${fixes} required fix${fixes === 1 ? '' : 'es'}`,
      };
    }
  } else if (transition === FAIL_TRANSITION) {
    if (r.verdict !== 'fail') return { ok: false, why: `qa_fail with verdict "${r.verdict}"` };
    if (fixes === 0) return { ok: false, why: 'qa_fail without any required_fixes' };
  }
  return { ok: true, result: r };
}

export function qaNudge(why: string): string {
  return [
    `Conductor could not use your QA result: ${why}.`,
    '`qa_pass` needs `verdict` "pass" or "pass_with_debt" and no `required_fixes`; `qa_fail` needs `verdict` "fail" and at least one `required_fixes` entry. The result must match the QaResult schema in your instructions.',
    'Call `complete_state` again with a corrected result. Do not change any files.',
  ].join('\n\n');
}

export function qaNoVerdictQuestion(why: string): string {
  return `QA produced no usable verdict (${why}). Retry, skip, or abort?`;
}

/** The open required fixes, numbered (the question after the last QA round). */
export function fixesLines(result: JsonObject | undefined): string[] {
  const fixes = result?.required_fixes;
  if (!Array.isArray(fixes)) return [];
  const items = fixes.filter((f): f is string => typeof f === 'string');
  return items.length === 0
    ? []
    : ['', 'Open required fixes:', ...items.map((f, i) => `${i + 1}. ${f}`)];
}

/**
 * FR-5: the QA round counters a human move into `goto` resets (a human decision opens a new
 * round of three): every `<qa>-><goto>` whose QA state sends its findings back to `goto`.
 */
export function qaRoundResets(def: Pick<WorkflowDefinition, 'states' | 'budget'>, goto: string) {
  const keys: string[] = [];
  for (const [name, state] of Object.entries(def.states)) {
    if (!isQaState(state)) continue;
    const fail = qaFailTransition(def, name);
    if (fail !== null && fail.goto === goto) keys.push(fail.key);
  }
  return keys;
}

/**
 * Whether the wrapper must bump the fencing token (ADR-0020 §2 "Fenced"): the session entered
 * or left a QA state outside a gate step (which is fenced already). A late event of the worker
 * can then never be taken as the QA's outcome, nor the QA's as the worker's.
 */
export function qaFenceChanged(
  def: Pick<WorkflowDefinition, 'states'>,
  before: Pick<SessionSnapshot, 'workflow_state'>,
  after: Pick<SessionSnapshot, 'workflow_state'>,
): boolean {
  if (before.workflow_state === after.workflow_state) return false;
  const was = before.workflow_state === null ? undefined : def.states[before.workflow_state];
  const is = after.workflow_state === null ? undefined : def.states[after.workflow_state];
  return isQaState(was) || isQaState(is);
}

/** What `## Sent back by <title>` renders (render.ts `renderSentBack`). */
export interface SentBack {
  title: string;
  result: QaResult;
}

/**
 * FR-4 (`attach: 'result'`): the findings a QA state sent agent state `target`, read from the
 * snapshot so a requeued or resumed start renders them too. Only while the last QA round failed:
 * the next round resets `__qa.verdict`, so stale findings never render.
 */
export function sentBackFor(
  def: Pick<WorkflowDefinition, 'states' | 'budget'>,
  context: Context,
  target: string,
): SentBack | null {
  if (qaOf(context)?.verdict !== 'fail') return null;
  for (const [name, state] of Object.entries(def.states)) {
    if (!isQaState(state)) continue;
    const fail = qaFailTransition(def, name);
    if (fail === null || fail.goto !== target) continue;
    if (transitionObject(state.on![fail.name]!).attach !== 'result') continue;
    const parsed = QaResultSchema.safeParse(context[name]);
    if (parsed.success && parsed.data.verdict === 'fail') {
      return { title: stateTitle(def, name), result: parsed.data };
    }
  }
  return null;
}

/**
 * FR-1: the QA's start: always a fresh Claude session (`nudge` null) in a fresh checkout of
 * `__qa.head_sha`, `review: true`, tools `['qa']`. The one nudge resumes the QA's OWN
 * conversation (`__qa.claude_session_id`), or, before its id is known, starts afresh with the
 * full prompt plus the nudge. A human answer goes into the rendered prompt, never a resume.
 */
export function qaStartSession(
  def: WorkflowDefinition,
  s: SessionSnapshot,
  name: string,
  state: QaState,
  p: { answer: string | null; nudge?: string | null },
): Extract<Effect, { type: 'start_session' }> {
  const qa = qaOf(s.context);
  const pr = prOf(s.context);
  const transitions = promptTransitions(def, name, ticketKind(s));
  const nudge = p.nudge ?? null;
  const resume = nudge !== null ? (qa?.claude_session_id ?? null) : null;
  const full = () =>
    renderPrompt({
      stateName: name,
      state,
      snapshot: s,
      attachment: null,
      answer: p.answer,
      feedback: null,
      transitions,
    });
  const prompt = nudge === null ? full() : resume !== null ? nudge : `${full()}\n\n${nudge}`;
  return {
    type: 'start_session',
    state: name,
    prompt,
    // ADR-0020 §2: the edit-free `qa` alias, whatever the state lists (T02 holds it to ['qa']).
    tools: ['qa'],
    resume_claude_session_id: resume,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.max_turns !== undefined ? { max_turns: state.max_turns } : {}),
    max_budget_usd: Math.max(0, def.budget.usd - s.spend_usd),
    review: true,
    ...(transitions !== null ? { transitions } : {}),
    ...(qa !== null && pr !== null
      ? { checkout: { sha: qa.head_sha, pr_url: pr.pr_url, setup: state.checkout?.setup ?? null } }
      : {}),
  };
}
