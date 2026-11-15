import type { MoveDto, SessionDetail } from './rest.js';
import type { OutputChunk } from './output.js';

// Ticket "Improved handoff" (06 §Hand-off brief): whenever a ticket stops on a human, the first
// thing they read is one plain sentence on WHY it stopped and a short summary of WHAT WAS DONE, in
// the agent's own words. Both are derived from what conductor already stores (the open request,
// the session's moves with their `cause`, the state's result summary, the agent's last output),
// so no agent turn is spent and nothing is parsed out of the engine's technical question text
// beyond a few fixed shapes. Pure: the web panel and the MCP status report share it.

export interface HandoffBrief {
  /** One plain sentence: why the ticket is waiting on a human now. Never command output. */
  why: string;
  /** What was done, in the agent's words (clipped); null when conductor has nothing from it. */
  summary: string | null;
}

export const HANDOFF_WHY_MAX = 220;
export const HANDOFF_SUMMARY_MAX = 500;

export type HandoffBriefInput = Pick<
  SessionDetail,
  'card' | 'pending_input' | 'context' | 'return_to' | 'recent_output' | 'workflow'
> & { moves?: SessionDetail['moves'] };

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

function clip(s: string, n: number): string {
  const f = flat(s);
  return f.length <= n ? f : `${f.slice(0, n - 1).trimEnd()}…`;
}

/** The last `max` characters of the session's assistant output, or null. */
export function lastAssistantText(chunks: readonly OutputChunk[], max = 400): string | null {
  const text = flat(
    chunks
      .filter((c) => c.stream === 'assistant')
      .map((c) => c.text)
      .join(''),
  );
  if (text === '') return null;
  return text.length <= max ? text : '…' + text.slice(text.length - (max - 1));
}

/** The latest move into the current state, if any. */
function lastMoveInto(d: HandoffBriefInput): MoveDto | null {
  const moves = d.moves ?? [];
  for (let i = moves.length - 1; i >= 0; i--) {
    if (moves[i]!.to === d.card.workflow_state) return moves[i]!;
  }
  return null;
}

function stateTitle(d: HandoffBriefInput, name: string | null): string {
  if (name === null) return 'its current step';
  const st = d.workflow.states[name] as { title?: string } | undefined;
  return st?.title ?? name;
}

/** The title of transition `name` out of `from`, else the name with `_` as spaces. */
function transitionTitle(d: HandoffBriefInput, from: string | null, name: string): string {
  const on =
    from !== null
      ? (d.workflow.states[from] as { on?: Record<string, unknown> } | undefined)?.on
      : undefined;
  const t = on?.[name];
  if (t !== null && typeof t === 'object' && typeof (t as { title?: unknown }).title === 'string') {
    return (t as { title: string }).title;
  }
  return name.replace(/_/g, ' ');
}

const RETRY_LIMIT = /^(.*?)\s*\(retry limit (\d+)\)\s*$/s;
const AGENT_EXITED = /^the agent exited\b/i;

/** A move reason in plain words: an agent process exit is never quoted (its stderr is detail). */
function plainDetail(reason: string): string {
  if (AGENT_EXITED.test(reason)) return "the agent's process exited before it reported back";
  return clip(reason, 140);
}

/** The first sentence of `text` (to `.`, `?` or `!` before a space or the end), else all of it. */
function firstSentence(text: string): string {
  const f = flat(text);
  const m = /[.?!](?=\s|$)/.exec(f);
  return m ? f.slice(0, m.index + 1) : f;
}

function why(d: HandoffBriefInput, last: MoveDto | null): string {
  const req = d.pending_input;
  const here = stateTitle(d, d.card.workflow_state);
  const origin = req?.origin_transition ?? (last?.actor === 'agent' ? last.transition : null);
  if (req?.kind === 'handoff' || (origin?.endsWith('ready_for_review') ?? false)) {
    return d.card.pr_url
      ? 'The work is finished and its pull request is open for your review.'
      : 'The work is finished and handed off for your review.';
  }
  if (origin === 'plan_needs_approval') {
    return 'The plan needs your approval before implementation starts.';
  }
  if (req?.kind === 'agent_question') {
    return origin && origin !== 'ask_user'
      ? `The agent stopped to ask you something ("${transitionTitle(d, d.return_to, origin)}").`
      : 'The agent stopped to ask you a question.';
  }
  if (req?.kind === 'check_config') {
    return "Conductor's own check setup failed, on the main branch too, so it isn't this branch's fault.";
  }
  if (req?.kind === 'budget_exceeded') {
    const m = /: ((?:spent|ran) .*?)\.(?=\s|$)/.exec(req.question);
    return m
      ? `It ran out of budget (${m[1]}), so conductor paused it.`
      : 'It ran out of budget, so conductor paused it.';
  }
  if (req?.kind === 'machine_lost') {
    return clip(
      `The machine running it stopped responding: ${firstSentence(req.question)}`,
      HANDOFF_WHY_MAX,
    );
  }
  const reason = last?.reason ?? null;
  switch (last?.cause ?? null) {
    case 'retries_exhausted': {
      const m = reason !== null ? RETRY_LIMIT.exec(reason) : null;
      if (m) {
        return `It kept failing and conductor stopped after ${m[2]} tries: ${plainDetail(m[1]!)}.`;
      }
      return 'It kept failing and conductor stopped retrying.';
    }
    case 'condition_timeout':
      return "Conductor waited for the pull request's conditions (such as CI) and they weren't met in time.";
    case 'condition_unmet':
      return 'A pull request condition failed (such as CI or a merge conflict).';
    case 'check_failed':
    case 'review_unmet':
      return reason !== null
        ? `A check before the hand-off failed: ${plainDetail(reason)}.`
        : 'A check before the hand-off failed.';
    case 'action_failed':
      return 'Conductor could not finish a step of the hand-off (for example opening the pull request).';
    case 'timeout':
      return 'The step ran past its time limit.';
    case 'fallback':
      return reason !== null && AGENT_EXITED.test(reason)
        ? 'The agent stopped before it finished: its process exited without reporting back.'
        : 'The agent stopped without choosing a next step, so conductor handed it to you.';
    case 'watch_broken':
      return reason !== null
        ? `Something it was watching broke: ${plainDetail(reason)}.`
        : 'Something it was watching broke.';
    case 'machine_lost':
      return 'The machine running it stopped responding.';
    case 'budget_exceeded':
      return 'It ran out of budget, so conductor paused it.';
    default:
      break;
  }
  if (req?.kind === 'timeout') return 'The step ran past its time limit.';
  if (req?.kind === 'retries_exhausted' || req?.step_failed === true) {
    return 'A step failed and conductor needs you to decide what happens next.';
  }
  if (last?.actor === 'human') return `Someone moved it to "${here}".`;
  return `It is waiting in "${here}" for you to take the next step.`;
}

const same = (a: string, b: string | undefined): boolean => b !== undefined && flat(a) === flat(b);

function summary(d: HandoffBriefInput): string | null {
  const question = d.pending_input?.question;
  const keep = (s: unknown): string | null =>
    typeof s === 'string' && s.trim() !== '' && !same(s, question)
      ? clip(s, HANDOFF_SUMMARY_MAX)
      : null;
  // 1. The asking state's own result summary (e.g. planning's `summary`).
  if (d.return_to !== null) {
    const own = (d.context[d.return_to] as Record<string, unknown> | undefined)?.summary;
    const s = keep(own);
    if (s !== null) return s;
  }
  // 2. The agent's latest reason in this visit of the asking state (its hand-off text).
  const moves = d.moves ?? [];
  let start = 0;
  if (d.return_to !== null) {
    for (let i = moves.length - 1; i >= 0; i--) {
      if (moves[i]!.to === d.return_to) {
        start = i + 1;
        break;
      }
    }
  }
  for (let i = moves.length - 1; i >= start; i--) {
    const m = moves[i]!;
    if (m.actor !== 'agent') continue;
    const s = keep(m.reason);
    if (s !== null) return s;
  }
  // 3. What the agent last said.
  const said = lastAssistantText(d.recent_output, HANDOFF_SUMMARY_MAX);
  return said !== null && !same(said, question) ? said : null;
}

/**
 * The hand-off brief of a session waiting on a human: an open request, or a human state. null
 * while an agent or conductor is working (nothing is handed off).
 */
export function handoffBrief(d: HandoffBriefInput): HandoffBrief | null {
  const state = d.card.workflow_state;
  const type = state !== null ? d.workflow.states[state]?.type : undefined;
  if (d.pending_input === null && type !== 'human') return null;
  return { why: clip(why(d, lastMoveInto(d)), HANDOFF_WHY_MAX), summary: summary(d) };
}
