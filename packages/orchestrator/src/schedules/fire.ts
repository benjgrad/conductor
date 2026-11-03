import {
  formatScheduleTime,
  nextRunAfter,
  type BoardSseEvent,
  type ScheduleSkipReason,
  type TicketStatus,
} from '@conductor/shared';
import { sessionlessCardUpserted, insertTicketRow } from '../api/tickets.js';
import type { Queryable } from '../contracts.js';
import type { TicketRow, TicketScheduleRow } from '../db/types.js';

// ADR-0032: one run of a schedule, inside the caller's transaction (the schedule row locked).
// The sweep fires a due run; `run_schedule_now` fires a manual one. A due run is skipped while the
// previous run's ticket is still open (no pile-up behind an unanswered escalation); a run never
// makes two tickets (`ticket_schedule_run_key`); a sweep moves `next_run_at` to the first run after
// now, so missed runs are not caught up.

/** A ticket still in play: not done, failed or cancelled (waiting on a person included). */
const OPEN: ReadonlySet<TicketStatus> = new Set(['ready', 'claimed', 'in_progress']);

export type FireOutcome =
  | { status: 'created'; ticket: TicketRow }
  | { status: 'skipped'; reason: ScheduleSkipReason }
  /** The run already has its ticket (a retried or concurrent fire): nothing new. */
  | { status: 'duplicate' }
  /** A manual run refused: the previous run is open and `force` was not given. */
  | { status: 'refused'; reason: 'previous_run_open' };

export interface FireResult {
  outcome: FireOutcome;
  /** Board events to publish after COMMIT. */
  events: BoardSseEvent[];
}

/** The status of the schedule's last run's ticket; null = none. */
async function lastRunStatus(tx: Queryable, row: TicketScheduleRow): Promise<TicketStatus | null> {
  if (row.last_ticket_id === null) return null;
  const r = await tx.query<{ status: TicketStatus }>('SELECT status FROM ticket WHERE id = $1', [
    row.last_ticket_id,
  ]);
  return r.rows[0]?.status ?? null;
}

/** The first run after `now` (no catch-up); null when it never runs again or no longer parses. */
function nextAfter(row: TicketScheduleRow, now: Date): Date | null {
  try {
    return nextRunAfter(row.cron, row.timezone, now);
  } catch {
    return null;
  }
}

/** The scheduled ticket's title: the template's, with the run time in the schedule's timezone. */
export function runTitle(row: Pick<TicketScheduleRow, 'title' | 'timezone'>, at: Date): string {
  return `${row.title} · ${formatScheduleTime(at, row.timezone)}`;
}

/**
 * Fire one run of `row` (locked by the caller) for `scheduledFor`. `manual`: a run now; it leaves
 * `next_run_at` alone, and with an open previous run it is refused unless `force`.
 */
export async function fireSchedule(
  tx: Queryable,
  row: TicketScheduleRow,
  scheduledFor: Date,
  now: Date,
  opts: { manual: boolean; force?: boolean },
): Promise<FireResult> {
  const advance = opts.manual ? row.next_run_at : nextAfter(row, now);
  const last = await lastRunStatus(tx, row);
  if (last !== null && OPEN.has(last)) {
    if (opts.manual && opts.force !== true) {
      return { outcome: { status: 'refused', reason: 'previous_run_open' }, events: [] };
    }
    if (!opts.manual) {
      await tx.query(
        "UPDATE ticket_schedule SET last_skipped_at = $2, last_skip_reason = 'previous_run_open', " +
          'next_run_at = $3 WHERE id = $1',
        [row.id, now, advance],
      );
      return { outcome: { status: 'skipped', reason: 'previous_run_open' }, events: [] };
    }
  }

  const ticket = await insertTicketRow(tx, {
    account_id: row.account_id,
    external_ref: null,
    repo: row.repo,
    title: runTitle(row, scheduledFor),
    body: row.body,
    workflow_id: row.workflow_id,
    required_tags: row.required_tags,
    repo_allow_machines: row.machine_ids,
    priority: row.priority,
    kind: row.kind,
    schedule_id: row.id,
    scheduled_for: scheduledFor,
  });
  if (ticket === null) {
    await tx.query('UPDATE ticket_schedule SET next_run_at = $2 WHERE id = $1', [row.id, advance]);
    return { outcome: { status: 'duplicate' }, events: [] };
  }
  await tx.query(
    'UPDATE ticket_schedule SET last_run_at = $2, last_ticket_id = $3, next_run_at = $4 ' +
      'WHERE id = $1',
    [row.id, now, ticket.id, advance],
  );
  // Last write of the transaction (insertBoardEvents holds the board lock to COMMIT).
  const events = await sessionlessCardUpserted(tx, {
    ...ticket,
    agent_name: null,
    schedule_name: row.name,
  });
  return { outcome: { status: 'created', ticket }, events };
}
