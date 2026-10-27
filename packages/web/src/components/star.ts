// UX-7: the Details tab as a story in STAR order. Pure: what each section shows, derived from the
// SessionDetail (and the parsed brief); StarDetails.tsx renders it.
import type { MoveDto, SessionDetail, SessionInputRequest, TicketKind } from '@conductor/shared';
import type { Brief } from '../brief/parse.js';
import { displayState } from '../workflow/review.js';
import { failedItemOfQuestion, firstErrorLine } from './ConductorChecks.js';
import { KIND_LABELS } from './format.js';
import {
  classifyRequest,
  formatSummary,
  lastMoveTransition,
  summarizeReport,
} from './request-preview.js';
import { moveTitle } from './transitions.js';

/** The engine's ask_user transition (shared engine/transitions.ts ASK_USER, not exported). */
const ASK_USER = 'ask_user';

/** The first non-empty line, trimmed. */
export function firstLine(s: string | null | undefined): string {
  return (
    (s ?? '')
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  );
}

/** A one-line summary: the first line without its markdown markers (heading, list, bold, code). */
export function summaryLine(s: string | null | undefined): string {
  return firstLine(s)
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/\*\*|__|`/g, '');
}

/** The first paragraph (up to a blank line), skipping leading blank lines and `#` headings. */
export function firstParagraph(md: string): string {
  const out: string[] = [];
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') {
      if (out.length > 0) break;
      continue;
    }
    if (out.length === 0 && /^#{1,6}\s/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- Situation

export interface Situation {
  /** The ticket's Context section, else the first paragraph of its body; '' if neither. */
  text: string;
  title: string;
  kind: TicketKind | null;
  repo: string;
  createdAt: string;
}

export function situation(
  detail: SessionDetail,
  brief: Brief | null,
  body: string | null,
): Situation {
  const { card } = detail;
  const text = brief?.context || (body === null ? '' : firstParagraph(body));
  return { text, title: card.title, kind: card.kind, repo: card.repo, createdAt: card.created_at };
}

// ---------------------------------------------------------------- Action

export type TimelineKind =
  'start' | 'plan' | 'move' | 'question' | 'answer' | 'check' | 'review' | 'live';

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  label: string;
  /** The move's reason (an answer's text, a question); null if none. */
  reason: string | null;
  /** More to show behind "Full plan ▸" (the plan) or the branch of a review. */
  detail?: string;
  /** The answer was clipped by the server (SessionInputRequest.truncated). */
  truncated?: boolean;
}

/** A gate-step or review label (`"a → b (entry)"`, `"… (review)"`), not a state of the workflow. */
function isStepLabel(state: string, workflow: SessionDetail['workflow']): boolean {
  return !(state in workflow.states) && / → .+ \(.+\)$/.test(state);
}

const isReview = (transition: string | null) =>
  transition !== null && transition.endsWith('ready_for_review');

/** The plan the session wrote leaving `from` (`context[from].plan`), else any state's plan. */
function planOf(detail: SessionDetail, from: string | null): string | null {
  const own = from === null ? undefined : detail.context[from]?.plan;
  if (typeof own === 'string' && own.trim() !== '') return own;
  for (const values of Object.values(detail.context)) {
    if (typeof values.plan === 'string' && values.plan.trim() !== '') return values.plan;
  }
  return null;
}

/** The engine writes the move in the answer's transaction; allow for the clocks of the two writes. */
const SAME_WRITE_MS = 5_000;

/**
 * The input request a move belongs to: an answer (`answered_at`) or a question (`created_at`)
 * nearest to the move, at most SAME_WRITE_MS after it and not already used.
 */
function matchRequest(
  requests: readonly SessionInputRequest[],
  used: Set<string>,
  at: string,
  field: 'answered_at' | 'created_at',
): SessionInputRequest | null {
  const t = Date.parse(at);
  let best: SessionInputRequest | null = null;
  let bestGap = Infinity;
  for (const r of requests) {
    const when = r[field];
    if (when === null || used.has(r.id)) continue;
    // An answer is written before its move; a question as (just after) the move lands.
    const gap = field === 'answered_at' ? t - Date.parse(when) : Date.parse(when) - t;
    if (gap < -SAME_WRITE_MS || (field === 'created_at' && gap > SAME_WRITE_MS)) continue;
    if (Math.abs(gap) < bestGap) {
      best = r;
      bestGap = Math.abs(gap);
    }
  }
  if (best) used.add(best.id);
  return best;
}

/** What a request that routed to a human is, in words. */
function requestLabel(r: Pick<SessionInputRequest, 'kind' | 'question'>, agent: string): string {
  if (r.kind === 'agent_question') return `${agent} asked`;
  if (classifyRequest(r) === 'step_failed') return 'Step failed';
  return KIND_LABELS[r.kind];
}

/**
 * FR-3: what happened, oldest first: the start, the plan, each move in plain words, questions and
 * answers (matched from `input_requests`), checks, the review, then what is happening now.
 */
export function timeline(detail: SessionDetail, agent: string): TimelineEntry[] {
  const { workflow, card } = detail;
  const requests = detail.input_requests ?? [];
  const usedAnswers = new Set<string>();
  const usedQuestions = new Set<string>();
  const out: TimelineEntry[] = [];
  const name = (s: string) => displayState(s, workflow);

  for (const m of detail.moves ?? []) {
    out.push(moveEntry(m));
  }

  function moveEntry(m: MoveDto): TimelineEntry {
    const base = { at: m.at, reason: m.reason };
    const toHuman = workflow.states[m.to]?.type === 'human';
    if (m.from === null) return { ...base, kind: 'start', label: `Started in ${name(m.to)}` };
    if (isReview(m.transition)) {
      if (toHuman) matchRequest(requests, usedQuestions, m.at, 'created_at');
      return {
        ...base,
        kind: 'review',
        label: 'Ready for review',
        ...(detail.branch ? { detail: detail.branch } : {}),
      };
    }
    if (m.transition === 'plan_ready') {
      const plan = planOf(detail, m.from);
      return { ...base, kind: 'plan', label: 'Plan ready', ...(plan ? { detail: plan } : {}) };
    }
    const fromHuman = workflow.states[m.from]?.type === 'human';
    if (fromHuman && m.transition === null) {
      const r = matchRequest(requests, usedAnswers, m.at, 'answered_at');
      return {
        at: m.at,
        kind: 'answer',
        label: 'You answered',
        reason: r?.answer ?? null,
        ...(r?.truncated ? { truncated: true } : {}),
      };
    }
    if (toHuman) {
      const r = matchRequest(requests, usedQuestions, m.at, 'created_at');
      const step = isStepLabel(m.from, workflow);
      const asked = m.transition === ASK_USER || r?.kind === 'agent_question';
      const label = step
        ? `${name(m.from)} failed`
        : asked
          ? `${agent} asked`
          : r
            ? requestLabel(r, agent)
            : (moveTitle(workflow, m) ?? `Moved to ${name(m.to)}`);
      return { at: m.at, kind: 'question', label, reason: m.reason ?? r?.question ?? null };
    }
    if (isStepLabel(m.from, workflow)) {
      return { ...base, kind: 'check', label: `${name(m.from)} passed` };
    }
    const title = moveTitle(workflow, m);
    return {
      ...base,
      kind: 'move',
      label: title ? `${title} → ${name(m.to)}` : `Moved to ${name(m.to)}`,
    };
  }

  const now = card.updated_at;
  if (card.checking) {
    out.push({
      at: now,
      kind: 'live',
      label: `Conductor is checking: ${card.checking.label ?? `Checks before ${card.checking.title}`}`,
      reason: null,
    });
  }
  const open = detail.pending_input;
  if (open && !usedQuestions.has(open.id)) {
    const cls = classifyRequest(open, lastMoveTransition(detail));
    out.push({
      at: open.created_at,
      kind: 'live',
      label:
        cls === 'review'
          ? 'Ready for review'
          : cls === 'step_failed'
            ? 'Step failed'
            : requestLabel(open, agent),
      reason: cls === 'review' ? null : open.question,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Result

export type ResultStatus =
  'In progress' | 'Waiting for you' | 'Ready for review' | 'Done' | 'Failed';

export interface Result {
  status: ResultStatus;
  prUrl: string | null;
  /** The running step's items (UX-5), counted; null outside a gate step. */
  checks: { passed: number; failed: number; total: number } | null;
  failure: { item: string | null; error: string | null } | null;
  /** UX-4's report summary, e.g. "complete · Acceptance 8/10, gates ✓". */
  acceptance: string | null;
  next: string;
}

/** FR-4: the outcome at a glance, and what happens next. */
export function result(detail: SessionDetail, agent: string): Result {
  const { card, workflow } = detail;
  const open = detail.pending_input;
  const cls = open ? classifyRequest(open, lastMoveTransition(detail)) : null;
  const moves = detail.moves ?? [];
  const state = card.workflow_state;
  const where = state ? displayState(state, workflow) : 'the queue';

  // TD: no PR state (open/merged) on the wire yet, so a merged PR shows as "Done" (M2r adds it).
  const status: ResultStatus =
    card.status === 'failed' || card.status === 'lost'
      ? 'Failed'
      : card.status === 'done'
        ? 'Done'
        : cls === 'review'
          ? 'Ready for review'
          : card.status === 'needs_input' ||
              card.status === 'waiting_external' ||
              card.human_transitions.length > 0
            ? 'Waiting for you'
            : 'In progress';

  const items = card.checking?.items;
  const checks =
    items && items.length > 0
      ? {
          passed: items.filter((i) => i.status === 'passed').length,
          failed: items.filter((i) => i.status === 'failed').length,
          total: items.length,
        }
      : null;

  let failure: Result['failure'] = null;
  if (open && cls === 'step_failed') {
    failure = failedItemOfQuestion(open.question) ?? {
      item: null,
      error: firstErrorLine(open.question),
    };
  } else if (status === 'Failed') {
    const last = moves.at(-1)?.reason;
    if (last) failure = { item: null, error: firstErrorLine(last) ?? firstLine(last) };
  }

  const reviewMove = [...moves].reverse().find((m) => isReview(m.transition));
  const report = cls === 'review' && open ? open.question : (reviewMove?.reason ?? null);
  const summary = report ? summarizeReport(report) : null;
  const acceptance = summary ? formatSummary(summary) || null : null;

  const stateType = state ? workflow.states[state]?.type : undefined;
  const next =
    status === 'Done' || status === 'Failed'
      ? 'Nothing: the ticket is closed.'
      : cls === 'review'
        ? 'Your call: review the PR, then approve or ask for changes.'
        : cls === 'step_failed'
          ? `Your call: retry or fix ${failure?.item ?? 'the failed step'}.`
          : cls === 'question'
            ? open?.kind === 'agent_question'
              ? `Your call: answer ${agent}'s question.`
              : 'Your call: decide how to go on.'
            : card.checking
              ? `Waiting for ${card.checking.label ?? `Checks before ${card.checking.title}`}.`
              : card.human_transitions.length > 0
                ? `Your call: ${card.human_transitions.map((t) => t.title).join(' or ')}.`
                : stateType === 'event'
                  ? `Waiting for ${where}.`
                  : card.status === 'queued' || card.status === 'assigned'
                    ? 'Waiting for a machine to start it.'
                    : `${agent} is working on ${where}.`;

  return { status, prUrl: card.pr_url, checks, failure, acceptance, next };
}
