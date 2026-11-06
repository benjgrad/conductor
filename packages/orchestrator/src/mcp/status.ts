import {
  latestPlanEntry,
  type BoardCard,
  type InputRequestKind,
  type SessionDetail,
  type TicketStatus,
} from '@conductor/shared';

// ADR-0031: who a ticket is waiting on, in one field, for a conversational client. `status`
// (needs_input ↔ running) changes every time an agent asks and is answered while `state` stays
// `implementing`; read separately they look like flip-flopping. `waiting_on` is the one answer to
// "does this need me?". Pure, so the cases are unit tests (status.test.ts).

/**
 * - `you`: an open question, or a transition the user can take (over MCP).
 * - `you_on_board`: only the board can unblock it (a permission prompt, an approval).
 * - `agent`: an agent is working.
 * - `checks`: conductor is checking (pre-PR checks, review, PR conditions) or waiting on an event.
 * - `machine`: queued for a machine, or its machine was lost.
 * - `nobody`: finished (done, failed, cancelled).
 */
export type WaitingOn = 'you' | 'you_on_board' | 'agent' | 'checks' | 'machine' | 'nobody';

export const WAITING_ON_USER: ReadonlySet<WaitingOn> = new Set(['you', 'you_on_board']);

export type CardLike = Pick<
  BoardCard,
  'status' | 'input_request' | 'human_transitions' | 'checking' | 'permission'
>;

/**
 * Who `card` waits on. `gated` = the human transitions that need a board approval
 * (`approvalGated`); `ticketStatus` covers a ticket with no session (queued, or cancelled before
 * it started).
 */
export function waitingOn(
  card: CardLike,
  opts: { gated?: ReadonlySet<string>; ticketStatus?: TicketStatus } = {},
): WaitingOn {
  if (opts.ticketStatus === 'done' || opts.ticketStatus === 'cancelled') return 'nobody';
  const status = card.status;
  if (status === null) return 'machine';
  if (status === 'done' || status === 'failed') return 'nobody';
  if (card.permission) return 'you_on_board';
  const transitions = card.human_transitions;
  if (card.input_request !== null || transitions.length > 0) {
    const gated = opts.gated ?? new Set<string>();
    const allGated = transitions.length > 0 && transitions.every((t) => gated.has(t.name));
    return allGated && card.input_request === null ? 'you_on_board' : 'you';
  }
  if (card.checking !== null || status === 'waiting_external') return 'checks';
  if (status === 'running') return 'agent';
  if (status === 'needs_input') return 'you';
  return 'machine';
}

const clip = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
};

const KIND_TEXT: Record<InputRequestKind, string> = {
  agent_question: 'the agent asks',
  budget_exceeded: 'the budget ran out',
  retries_exhausted: 'retries ran out',
  timeout: 'a step timed out',
  approval: 'an approval is needed',
  machine_lost: 'its machine was lost',
  handoff: 'ready for review',
};

export interface StatusLineInput {
  card: CardLike & Pick<BoardCard, 'workflow_state'>;
  waiting: WaitingOn;
  /** The current state's column title (defaults to the state name). */
  stateTitle?: string | null;
  /** How long the session has been in its state, in minutes, when known. */
  minutesInState?: number | null;
  /**
   * The open `agent_question` is a hand-off of finished work (a PR-ready summary through a
   * `question: true` gate, `isHandoffTransition`), not a question: "the agent reports".
   */
  handoff?: boolean;
  /** The ticket's own status: a cancelled ticket's session is `failed`, but it was cancelled. */
  ticketStatus?: TicketStatus;
}

/** One sentence a voice assistant can read out as it is. */
export function statusLine({
  card,
  waiting,
  stateTitle,
  minutesInState,
  handoff,
  ticketStatus,
}: StatusLineInput): string {
  const where = stateTitle ?? card.workflow_state ?? 'its current step';
  const names = card.human_transitions.map((t) => t.name).join(', ');
  switch (waiting) {
    case 'you':
      if (card.input_request) {
        // ADR-0037 P8: a hand-off is finished work to review, not a question.
        if (card.input_request.kind === 'handoff') {
          return `Ready for review: "${clip(card.input_request.question, 200)}"`;
        }
        const what =
          handoff === true && card.input_request.kind === 'agent_question'
            ? 'the agent reports'
            : KIND_TEXT[card.input_request.kind];
        return `Waiting on you: ${what}: "${clip(card.input_request.question, 200)}"`;
      }
      return `Waiting on you in ${where}: take one of ${names} (take_transition).`;
    case 'you_on_board':
      if (card.permission) {
        return (
          `Waiting on you on the board: the agent asks permission to use ${card.permission.tool} ` +
          `(${clip(card.permission.summary, 120)}).`
        );
      }
      return `Waiting on you on the board: ${names} needs an approval there.`;
    case 'agent':
      return minutesInState !== null && minutesInState !== undefined
        ? `The agent is working in ${where} (${Math.max(0, Math.round(minutesInState))} min so far).`
        : `The agent is working in ${where}.`;
    case 'checks':
      return card.checking
        ? `Conductor is checking: ${card.checking.label ?? `${card.checking.phase} before ${card.checking.title}`}.`
        : `Waiting on an outside event in ${where}.`;
    case 'machine':
      return card.status === 'lost'
        ? 'Its machine was lost; it waits for a machine to pick it up again.'
        : 'Queued: waiting for a machine to start it.';
    case 'nobody':
      if (ticketStatus === 'cancelled') {
        return 'Cancelled: nothing runs. reopen_ticket sends it back to the agent.';
      }
      return card.status === 'failed'
        ? 'Failed: nothing runs. reopen_ticket sends it back to the agent.'
        : 'Finished: nothing runs.';
  }
}

export const STATUS_REPORT_MAX = 1200;
const PLAN_EXCERPT = 400;
const OUTPUT_EXCERPT = 400;

/** The last `max` characters of the session's assistant output in the ring, or null. */
export function lastAssistantText(
  chunks: SessionDetail['recent_output'],
  max = OUTPUT_EXCERPT,
): string | null {
  const text = chunks
    .filter((c) => c.stream === 'assistant')
    .map((c) => c.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length <= max ? text : '…' + text.slice(text.length - (max - 1));
}

/**
 * ADR-0031 (FR5): a deterministic status report, ≤ STATUS_REPORT_MAX characters, built only
 * from what conductor already has: no agent turn, so it costs nothing and never answers the
 * agent's open question.
 */
export function statusReport(
  d: Pick<
    SessionDetail,
    'card' | 'context' | 'return_to' | 'moves' | 'spend_usd' | 'recent_output'
  >,
  line: string,
): string {
  const parts: string[] = [`${clip(d.card.title, 120)}: ${line}`];
  const entry = latestPlanEntry(d);
  const summary = entry ? (d.context[entry.from_state] as Record<string, unknown>).summary : null;
  if (typeof summary === 'string' && summary.trim() !== '') {
    parts.push(`Plan summary: ${clip(summary, 300)}`);
  }
  if (entry && typeof entry.plan === 'string') {
    parts.push(`Plan: ${clip(entry.plan, PLAN_EXCERPT)}`);
  }
  const moves = (d.moves ?? []).slice(-3);
  if (moves.length > 0) {
    parts.push(
      'Recent moves: ' +
        moves
          .map((m) => `${m.from ?? 'start'} → ${m.to}${m.transition ? ` (${m.transition})` : ''}`)
          .join('; '),
    );
  }
  if (d.card.pr_url) parts.push(`PR: ${d.card.pr_url}`);
  parts.push(`Spent $${d.spend_usd.toFixed(2)}.`);
  const said = lastAssistantText(d.recent_output);
  if (said !== null) parts.push(`Agent last said: ${said}`);
  // Each part is already short; the status comes first, so cutting the tail always keeps it.
  const out = parts.join('\n');
  return out.length <= STATUS_REPORT_MAX ? out : out.slice(0, STATUS_REPORT_MAX - 1) + '…';
}
