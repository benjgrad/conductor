import type {
  BoardCard,
  WorkflowDefinition,
  BoardColumnInfo,
  BoardColumnKind,
  InputRequestKind,
  SessionStatus,
  TicketKind,
  TicketSize,
} from '@conductor/shared';
import { displayState, parseReviewState } from '../workflow/review.js';

export const KIND_LABELS: Record<InputRequestKind, string> = {
  agent_question: 'Question',
  retries_exhausted: 'Retries exhausted',
  budget_exceeded: 'Budget exceeded',
  timeout: 'Timed out',
  approval: 'Approval',
  machine_lost: 'Machine lost',
  handoff: 'Ready for review',
  check_config: 'Check config',
};

export const STATUS_LABELS: Record<SessionStatus, string> = {
  queued: 'queued',
  assigned: 'assigned',
  running: 'running',
  needs_input: 'needs input',
  waiting_external: 'waiting',
  done: 'done',
  failed: 'failed',
  lost: 'lost',
};

/**
 * The session panel header's one chip: its label (UXR-40 `panelStatusLabel`) and the `status-*`
 * class it is coloured by. UXR-32 FR-2: "Waiting for permission" while the agent is held on a
 * permission request, never the running state. Null: nothing to show yet.
 */
export function headStatus(
  card: Pick<BoardCard, 'status' | 'sub_status' | 'permission' | 'workflow_state'>,
  workflow?: Pick<WorkflowDefinition, 'states'>,
): { key: string; label: string } | null {
  if (card.sub_status === 'needs_permission' && card.permission !== undefined) {
    return { key: 'needs_permission', label: 'Waiting for permission' };
  }
  const label = panelStatusLabel(card.workflow_state, card.status, workflow);
  return label === null ? null : { key: card.status ?? 'none', label };
}

export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set(['done', 'failed', 'lost']);

/** "just now", "4m ago", "3h ago", "2d ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Never shows non-zero spend as "$0.00" (TD-080): a haiku session can cost $0.0023. */
export const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/** 754 → "12m 34s"; 4000 → "1h 6m". */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const TICKET_KIND_LABELS: Record<TicketKind, string> = {
  work: 'Work',
  personal: 'Personal',
};

/** ADR-0037 §4 (C2): a ticket's size, for the create form and the card tag's hover text. */
export const TICKET_SIZE_LABELS: Record<TicketSize, string> = {
  S: 'Small',
  M: 'Medium',
  L: 'Large',
};

/**
 * ADR-0036: the priority choices, most urgent first (the lower P is claimed first). P0 is reserved
 * for work that interrupts other running work, so a form offers it only when the ticket already
 * has it.
 */
export const PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: 'P0 · interrupts running work',
  1: 'P1 · urgent',
  2: 'P2 · high',
  3: 'P3 · normal',
  4: 'P4 · low',
};

/** The priorities a form offers: P1–P4, plus `current` when it is outside them (P0). */
export function priorityChoices(current?: number): number[] {
  const base = [1, 2, 3, 4];
  return current === undefined || base.includes(current)
    ? base
    : [current, ...base].sort((a, b) => a - b);
}

/** A priority's option label; an unknown value (an older server) is just `P<n>`. */
export function priorityLabel(p: number): string {
  return PRIORITY_LABELS[p] ?? `P${p}`;
}

/** What a card's meta row shows; an absent label is already said by the column or a badge. */
export interface CardMeta {
  stateLabel?: string;
  statusLabel?: string;
  /** The status for screen readers when the column heading carries it visually (NFR-2). */
  srStatusLabel?: string;
}

/** The status a column already says. "Work" columns are where work runs: agent, command, connector. */
const STATUS_IMPLIED_BY_KIND: Partial<Record<SessionStatus, ReadonlySet<BoardColumnKind>>> = {
  needs_input: new Set(['human']),
  waiting_external: new Set(['event']),
  running: new Set(['agent', 'command', 'connector']),
  queued: new Set(['queued']),
};

const norm = (s: string) => s.replace(/_/g, ' ').trim().toLowerCase();

/** An engine id for people: `await_approval` → "Await approval" (`stateTitle`'s fallback). */
export function humanize(id: string): string {
  const words = id.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether the meta row names the workflow: only when the board mixes workflows (UXR-30). */
export interface CardMetaOptions {
  showWorkflow?: boolean;
}

/**
 * UX card cleanup: a card says only what its column (and its badges) don't. UXR-30: in titles,
 * never engine ids; nothing while a gate step runs (the checking / pending line says it).
 */
export function cardMeta(
  card: Pick<BoardCard, 'workflow_state' | 'workflow_id' | 'status' | 'badges'> &
    Partial<Pick<BoardCard, 'state_title' | 'checking' | 'pending'>>,
  column: Pick<BoardColumnInfo, 'id' | 'title' | 'kind'>,
  opts: CardMetaOptions = {},
): CardMeta {
  const meta: CardMeta = {};
  const parts: string[] = [];
  if (opts.showWorkflow) parts.push(humanize(card.workflow_id));
  const state = card.workflow_state;
  // A synthetic gate-step label ("a → b (move: x)") is never shown, even without its step.
  const synthetic = state !== null && state.includes(' → ') && !parseReviewState(state);
  if (state !== null && !synthetic && !card.checking && !card.pending) {
    const review = parseReviewState(state);
    const title = review
      ? `Reviewing: ${humanize(review.from)} → ${humanize(review.to)}`
      : (card.state_title ?? humanize(state));
    if (state !== column.id && norm(title) !== norm(column.title)) parts.push(title);
  }
  if (parts.length > 0) meta.stateLabel = parts.join(' · ');
  const status = card.status;
  if (status === null) return meta;
  if (STATUS_IMPLIED_BY_KIND[status]?.has(column.kind)) {
    meta.srStatusLabel = STATUS_LABELS[status];
  } else if (!(card.badges as readonly string[]).includes(status)) {
    // A `failed` / `lost` badge already says it, for everyone.
    meta.statusLabel = STATUS_LABELS[status];
  }
  return meta;
}

/**
 * UXR-40 (FR-5): the session panel's one status chip, in titles: the state's title ("Needs
 * input", "Checks before Ready for testing"), plus the status only when the state can't say it
 * (failed / lost); before the first state, the status ("Queued"). Null with neither.
 */
export function panelStatusLabel(
  state: string | null,
  status: SessionStatus | null,
  workflow?: Pick<WorkflowDefinition, 'states'>,
): string | null {
  if (state === null) return status === null ? null : humanize(STATUS_LABELS[status]);
  // A review or gate-step label reads as `displayState` words; a state as its title.
  const shown = state.includes(' → ')
    ? displayState(state, workflow)
    : (workflow?.states[state]?.title ?? humanize(state));
  return status === 'failed' || status === 'lost' ? `${shown} · ${STATUS_LABELS[status]}` : shown;
}
