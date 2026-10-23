import type { InputRequestKind, SessionStatus } from '@conductor/shared';

export const KIND_LABELS: Record<InputRequestKind, string> = {
  agent_question: 'Question',
  retries_exhausted: 'Retries exhausted',
  budget_exceeded: 'Budget exceeded',
  timeout: 'Timed out',
  approval: 'Approval',
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
