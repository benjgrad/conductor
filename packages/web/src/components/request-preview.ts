import type {
  HumanTransitionOption,
  InputRequestDto,
  InputRequestKind,
  SessionDetail,
  TransitionSessionRequest,
} from '@conductor/shared';
import { isEngineMove } from '@conductor/shared';

// UX-4: what an open input request is (a review request, a plan to approve, a failed step, or a
// real question) and the short preview the board card shows. Pure, so the card and the panel agree.

export type RequestClass = 'review' | 'plan_approval' | 'step_failed' | 'question';

/** Max characters of a card preview: the CSS clamps it to 3 lines; this bounds the DOM. */
export const PREVIEW_MAX = 280;

const isReviewTransition = (name: string | null | undefined) =>
  typeof name === 'string' && name.endsWith('ready_for_review');

/** 06 §Plan approval: conductor v2's planning question "Plan needs approval". */
// TD-185: a plan request is still recognised by this name; the approve and answer targets are
// derived from the state's human transitions (planOptions, WF-T04).
export const PLAN_APPROVAL_TRANSITION = 'plan_needs_approval';

/** Older servers send no `step_failed`: the engine's failed-step questions start like this. */
const STEP_FAILED_TEXT =
  /^(Conductor could not|Requirements to .* were not met|The requirements review)/;

/**
 * `fallbackTransition`: the session's last move into its current state (`lastMoveTransition`),
 * used when the server sends no `origin_transition`.
 */
export function classifyRequest(
  req: Pick<InputRequestDto, 'kind' | 'question' | 'origin_transition' | 'step_failed'>,
  fallbackTransition?: string | null,
): RequestClass {
  const origin = req.origin_transition !== undefined ? req.origin_transition : fallbackTransition;
  if (isReviewTransition(origin)) return 'review';
  if (origin === PLAN_APPROVAL_TRANSITION) return 'plan_approval';
  if (req.step_failed !== undefined) return req.step_failed ? 'step_failed' : 'question';
  if (
    (req.kind === 'retries_exhausted' || req.kind === 'timeout') &&
    STEP_FAILED_TEXT.test(req.question)
  ) {
    return 'step_failed';
  }
  return 'question';
}

/** The transition of the session's last move into its current state, if any. */
export function lastMoveTransition(detail: Pick<SessionDetail, 'moves' | 'card'>): string | null {
  const moves = detail.moves ?? [];
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i]!;
    // An engine route is not a transition someone took (`isNamedMove`).
    if (m.to === detail.card.workflow_state) return isEngineMove(m) ? null : m.transition;
  }
  return null;
}

/**
 * 06 §Plan approval: the human transition that answers the agent that asked (the resolved
 * `$return_to`, a `needs_text` button), which Approve plan / Request changes post. `returnTo` is
 * the session's `return_to` (the panel); the board has no `return_to`, so it passes the ids of
 * its agent columns and gets the one `needs_text` option into an agent state. null when there is
 * none (or the board can't tell which): the caller falls back to the generic buttons.
 */
// TD-184: the board has no return_to, so this guesses the answer (and, in planOptions, the
// approve) option from its agent columns (fails safe).
export function planAnswerOption<T extends HumanTransitionOption>(
  options: readonly T[],
  returnTo: string | ReadonlySet<string> | null | undefined,
): T | null {
  if (returnTo == null) return null;
  if (typeof returnTo === 'string') {
    return options.find((o) => o.needs_text && o.goto === returnTo) ?? null;
  }
  const matches = options.filter((o) => o.needs_text && returnTo.has(o.goto));
  return matches.length === 1 ? matches[0]! : null;
}

/** 06 §Plan approval: what Approve plan and Request changes post. */
export interface PlanOptions<T extends HumanTransitionOption = HumanTransitionOption> {
  /** The text-required option back to the asking state (`revise_plan` in v5, `answer` in v4). */
  answer: T;
  /**
   * The current state's own approval: no text, into an agent state that isn't the asking one
   * (`approve_plan` in v5). null: Approve plan posts `answer` with PLAN_APPROVED_TEXT (v4).
   */
  approve: T | null;
}

/**
 * 06 §Plan approval: the approve option, derived from the transitions rather than a name. Not
 * the answer option, needs no text, and goes into an agent state other than the asking one (so a
 * v4 `needs_input`'s `done` or `waiting_on_someone` never qualifies). Only when exactly one does:
 * an ambiguous workflow falls back to the canned answer.
 */
export function planApproveOption<T extends HumanTransitionOption>(
  options: readonly T[],
  answer: T,
  agentStates: ReadonlySet<string>,
): T | null {
  const candidates = options.filter(
    (o) =>
      o.name !== answer.name && !o.needs_text && o.goto !== answer.goto && agentStates.has(o.goto),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * The plan answer (`planAnswerOption`) and approve (`planApproveOption`) options; null when there
 * is no answer option. `agentStates`: the workflow's agent states (the panel) or the board's agent
 * columns (the card).
 */
// TD-184: on the board both are guessed from the agent columns (fails safe).
export function planOptions<T extends HumanTransitionOption>(
  options: readonly T[],
  returnTo: string | ReadonlySet<string> | null | undefined,
  agentStates: ReadonlySet<string>,
): PlanOptions<T> | null {
  const answer = planAnswerOption(options, returnTo);
  return answer ? { answer, approve: planApproveOption(options, answer, agentStates) } : null;
}

/** The agent states of a workflow, for `planOptions` in the panel. */
export function agentStatesOf(workflow: Pick<SessionDetail['workflow'], 'states'>): Set<string> {
  return new Set(
    Object.entries(workflow.states)
      .filter(([, s]) => s.type === 'agent')
      .map(([name]) => name),
  );
}

/** The text of the Approve plan button's transition when there is no approve option (v4). */
// TD-185: only for workflows without an approve transition.
export const PLAN_APPROVED_TEXT =
  'Plan approved. Proceed: call complete_state with plan_ready and this plan.';

/**
 * Approve plan's request: the approve option (with the note, if any), else the answer option
 * with PLAN_APPROVED_TEXT. A blank note is left out (the API rejects an empty `text`).
 */
export function planApproveRequest(p: PlanOptions, note?: string): TransitionSessionRequest {
  if (!p.approve) return { name: p.answer.name, text: PLAN_APPROVED_TEXT };
  const text = note?.trim();
  return text ? { name: p.approve.name, text } : { name: p.approve.name };
}

/** Request changes' request: always the answer option with the feedback. */
export function planChangesRequest(p: PlanOptions, feedback: string): TransitionSessionRequest {
  return { name: p.answer.name, text: planChangesText(feedback) };
}

/** The text of Request changes: the human's feedback after a fixed lead line. */
export function planChangesText(feedback: string): string {
  return `Changes requested to the plan:\n\n${feedback.trim()}`;
}

const HEADER_LINE = /^\s*[*_]*(TASK|BRANCH|STATUS)[*_]*\s*:/i;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}\s/;
/** A bare section label, e.g. `ACCEPTANCE:` or `**NEW UNKNOWNS (lead):**`. */
const BARE_LABEL = /^\s*[*_]*[A-Z][A-Z ()-]*[*_]*:[*_]*\s*$/;
/** A report field, e.g. `GATES: typecheck ✅` or `TECH DEBT: none`. */
const REPORT_FIELD = /^\s*[*_]*[A-Z][A-Z ()-]*[*_]*:/;
const CHECKBOX = /^\s*[-*]\s*\[( |x|X|-)\]/;

/** A line without its markdown markers (heading, quote, bullet, checkbox, bold, code ticks). */
function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    .replace(/^\[( |x|X|-)\]\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The meaningful lines: after a leading TASK/BRANCH/STATUS header block, without fences,
 * headings (`## Question` is a title, not the question) and bare section labels. `prose` also
 * skips a report's checkbox items and `FIELD: value` lines.
 */
function meaningfulLines(text: string, limit: number, prose = false): string[] {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === '' || HEADER_LINE.test(lines[i]!))) i++;
  const out: string[] = [];
  for (; i < lines.length && out.length < limit; i++) {
    const line = lines[i]!;
    if (FENCE.test(line) || HEADING.test(line) || BARE_LABEL.test(line)) continue;
    if (prose && (CHECKBOX.test(line) || REPORT_FIELD.test(line))) continue;
    const p = plain(line);
    if (p !== '') out.push(p);
  }
  return out;
}

/** Abbreviations whose dot doesn't end a sentence. */
const ABBREVIATION = /(^|\s|\()(e\.g|i\.e|etc|vs|cf|approx)\.$/i;

/** The first sentence of `line` (to a `.`, `?` or `!` before a space or the end), else all of it. */
function firstSentence(line: string): string {
  for (const m of line.matchAll(/[.?!](?=\s|$)/g)) {
    const head = line.slice(0, m.index + 1);
    if (!ABBREVIATION.test(head)) return head;
  }
  return line;
}

function cap(s: string): string {
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : s;
}

/**
 * The card's short preview of a request's text (FR-1, FR-3). A review leads with its report
 * summary when one parses (e.g. "complete · Acceptance 5/5 ✓, gates ✓"), then its first prose.
 */
export function previewText(text: string, cls: RequestClass): string {
  if (cls === 'review') {
    const s = summarizeReport(text);
    const summary = s ? formatSummary(s) : '';
    const prose = meaningfulLines(text, summary ? 2 : 3, true);
    const parts = summary ? [summary, ...prose] : prose;
    return cap((parts.length > 0 ? parts : meaningfulLines(text, 3)).join(' · '));
  }
  const first = meaningfulLines(text, 1)[0] ?? '';
  if (cls === 'step_failed') return cap(first);
  return cap(firstSentence(first));
}

export interface ReportSummary {
  status?: string;
  /** ACCEPTANCE `[x]` items. */
  accepted?: number;
  /** ACCEPTANCE `[x]` + `[ ]` items (the agent's own). */
  total?: number;
  /** ACCEPTANCE `[-]` items: owned by the lead or Ben, not unmet. */
  forReview?: number;
  gates?: 'ok' | 'failed';
}

/** STATUS, ACCEPTANCE `[x]` / `[ ]` / `[-]` counts and GATES of an implementer report; null if none. */
export function summarizeReport(text: string): ReportSummary | null {
  const lines = text.split('\n');
  const out: ReportSummary = {};
  const status = lines.find((l) => /^\s*[*_]*STATUS[*_]*\s*:/i.test(l));
  if (status) {
    const v = plain(status.slice(status.indexOf(':') + 1));
    if (v !== '') out.status = v;
  }
  const start = lines.findIndex((l) => /^\s*[*_]*ACCEPTANCE[*_]*\s*:/i.test(l));
  let boxes: string[];
  if (start >= 0) {
    boxes = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (CHECKBOX.test(l)) boxes.push(l);
      else if (REPORT_FIELD.test(l)) break;
    }
  } else {
    boxes = lines.filter((l) => CHECKBOX.test(l));
  }
  const mark = (l: string) => /\[( |x|X|-)\]/.exec(l)![1]!.toLowerCase();
  const own = boxes.filter((l) => mark(l) !== '-');
  if (own.length > 0) {
    out.total = own.length;
    out.accepted = own.filter((l) => mark(l) === 'x').length;
  }
  const lead = boxes.length - own.length;
  if (lead > 0) out.forReview = lead;
  const gates = lines.find((l) => /^\s*[*_]*GATES[*_]*\s*:/i.test(l));
  if (gates?.includes('❌')) out.gates = 'failed';
  else if (gates?.includes('✅')) out.gates = 'ok';
  return Object.keys(out).length > 0 ? out : null;
}

/** e.g. "complete · Acceptance 8/10, gates ✓ · 1 for review". */
export function formatSummary(s: ReportSummary): string {
  const parts: string[] = [];
  if (s.status) parts.push(s.status);
  const counts: string[] = [];
  if (s.total !== undefined) {
    counts.push(`Acceptance ${s.accepted}/${s.total}${s.accepted === s.total ? ' ✓' : ''}`);
  }
  if (s.gates) counts.push(`gates ${s.gates === 'ok' ? '✓' : '✗'}`);
  if (counts.length > 0) parts.push(counts.join(', '));
  if (s.forReview) parts.push(`${s.forReview} for review`);
  return parts.join(' · ');
}

/**
 * UXR-35 (11-web-ui §Requests): how a request looks in the panel. Each tone has its own colour,
 * and only a failure is red. A permission prompt is not an input request: its box passes
 * `'permission'` itself.
 */
export type RequestTone = 'question' | 'review' | 'permission' | 'failure';

/** The kinds of a request that a failed run raises (an old server sends no `step_failed`). */
const FAILURE_KINDS: ReadonlySet<InputRequestKind> = new Set([
  'retries_exhausted',
  'timeout',
  'machine_lost',
]);

export function requestTone(cls: RequestClass, kind: InputRequestKind): RequestTone {
  if (cls === 'review') return 'review';
  if (cls === 'step_failed') return 'failure';
  if (cls === 'question' && FAILURE_KINDS.has(kind)) return 'failure';
  return 'question';
}

/** The request's tone from the session detail (null: no open request). */
export function detailRequestTone(
  detail: Pick<SessionDetail, 'pending_input' | 'moves' | 'card'>,
): RequestTone | null {
  const req = detail.pending_input;
  if (!req) return null;
  return requestTone(classifyRequest(req, lastMoveTransition(detail)), req.kind);
}

/**
 * FR-2: the review's Approve. The one human option that needs no text and goes into a terminal
 * state (`done`, "Merged, done"): the button that approves a review on the board. null when no
 * option, or more than one, qualifies (the panel then shows only the generic buttons).
 */
export function reviewApproveOption<T extends HumanTransitionOption>(
  options: readonly T[],
  workflow: Pick<SessionDetail['workflow'], 'states'>,
): T | null {
  const candidates = options.filter(
    (o) => !o.needs_text && workflow.states[o.goto]?.type === 'terminal',
  );
  return candidates.length === 1 ? candidates[0]! : null;
}
