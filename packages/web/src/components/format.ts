import type {
  BoardCard,
  BoardColumnInfo,
  BoardColumnKind,
  InputRequestKind,
  SessionStatus,
  TicketKind,
} from '@conductor/shared';
import { stateLabel } from '../workflow/review.js';

export const KIND_LABELS: Record<InputRequestKind, string> = {
  agent_question: 'Question',
  retries_exhausted: 'Retries exhausted',
  budget_exceeded: 'Budget exceeded',
  timeout: 'Timed out',
  approval: 'Approval',
  machine_lost: 'Machine lost',
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

/** UX card cleanup: a card says only what its column (and its badges) don't. */
export function cardMeta(
  card: Pick<BoardCard, 'workflow_state' | 'workflow_id' | 'status' | 'badges'>,
  column: Pick<BoardColumnInfo, 'id' | 'title' | 'kind'>,
): CardMeta {
  const meta: CardMeta = {};
  const label = card.workflow_state ? stateLabel(card.workflow_state) : card.workflow_id;
  if (card.workflow_state !== column.id && norm(label) !== norm(column.title)) {
    meta.stateLabel = label;
  }
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
