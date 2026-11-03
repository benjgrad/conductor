import { validateSchedule } from '@conductor/shared';
import type { BoardBus } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { TicketScheduleRow } from '../db/types.js';
import type { Db } from '../main.js';
import { fireSchedule, type FireResult } from './fire.js';

// ADR-0032: the schedule sweep. Every due, enabled schedule fires once per pass, each in its own
// transaction (one bad row never rolls back the others), locked FOR UPDATE SKIP LOCKED so two
// sweeps (or a second replica) never fire the same run twice.

export const SCHEDULE_SWEEP_BATCH = 50;

/** How often the orchestrator's schedule loop runs: cron has minute precision. */
export const SCHEDULE_SWEEP_INTERVAL_MS = 30_000;

export interface ScheduleSweepDeps {
  db: Db;
  boardBus: BoardBus;
  now: () => Date;
}

export interface ScheduleSweepStats {
  due: number;
  created: number;
  skipped: number;
  /** Already had its ticket, or another sweep took it. */
  duplicate: number;
  /** Disabled because its cron or timezone no longer parses. */
  disabled: number;
  errors: number;
}

type Fired = FireResult | { outcome: { status: 'gone' | 'disabled' }; events: [] };

export async function sweepSchedulesOnce(deps: ScheduleSweepDeps): Promise<ScheduleSweepStats> {
  const stats: ScheduleSweepStats = {
    due: 0,
    created: 0,
    skipped: 0,
    duplicate: 0,
    disabled: 0,
    errors: 0,
  };
  const now = deps.now();
  const due = await deps.db.query<{ id: string }>(
    'SELECT id FROM ticket_schedule WHERE enabled AND next_run_at <= $1 ' +
      'ORDER BY next_run_at LIMIT $2',
    [now, SCHEDULE_SWEEP_BATCH],
  );
  for (const { id } of due.rows) {
    stats.due++;
    try {
      const res = await withTransaction(deps.db, async (tx): Promise<Fired> => {
        const r = await tx.query<TicketScheduleRow>(
          'SELECT * FROM ticket_schedule WHERE id = $1 AND enabled AND next_run_at <= $2 ' +
            'FOR UPDATE SKIP LOCKED',
          [id, now],
        );
        const row = r.rows[0];
        if (row === undefined) return { outcome: { status: 'gone' }, events: [] };
        const invalid = validateSchedule(row.cron, row.timezone, now);
        if (invalid !== null && invalid.code !== 'schedule_too_frequent') {
          // Never re-fired on every tick: off until a person fixes it.
          await tx.query(
            'UPDATE ticket_schedule SET enabled = false, next_run_at = NULL, ' +
              "last_skipped_at = $2, last_skip_reason = 'invalid_schedule' WHERE id = $1",
            [row.id, now],
          );
          console.error(`[schedules] ${row.id} disabled: ${invalid.message}`);
          return { outcome: { status: 'disabled' }, events: [] };
        }
        return fireSchedule(tx, row, row.next_run_at!, now, { manual: false });
      });
      for (const ev of res.events) deps.boardBus.publish(ev);
      switch (res.outcome.status) {
        case 'created':
          stats.created++;
          break;
        case 'skipped':
          stats.skipped++;
          break;
        case 'disabled':
          stats.disabled++;
          break;
        default:
          stats.duplicate++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[schedules] ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return stats;
}
