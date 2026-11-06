import type { EngineService } from '../contracts.js';
import type { Db } from '../main.js';

// Timeout sweep (M1-T04b; 10-contracts §Engine `timer.fired`). Finds sessions whose
// `state_deadline` has passed and feeds `timer.fired {state, deadline}` through the engine;
// apply ignores it (`stale_timer`) if the session moved on meanwhile.
// ADR-0037 P1 (T6): the same for `watch_deadline` (a watched human / event state's next check),
// fed as `watch.fired`. A merge or push on the same repo sets it to now (watch-nudge.ts), so the
// next tick checks the watch at once.

export const SWEEP_BATCH = 100;

export interface SweepDeps {
  db: Db;
  engine: EngineService;
  now: () => Date;
}

export interface SweepStats {
  fired: number;
  applied: number;
  ignored: number;
  errors: number;
}

type Timer = 'state_deadline' | 'watch_deadline';

export async function sweepOnce(deps: SweepDeps): Promise<SweepStats> {
  const stats: SweepStats = { fired: 0, applied: 0, ignored: 0, errors: 0 };
  await sweepTimers(deps, 'state_deadline', stats);
  await sweepTimers(deps, 'watch_deadline', stats);
  return stats;
}

/** One kind of deadline: `state_deadline` → `timer.fired`, `watch_deadline` → `watch.fired`. */
async function sweepTimers(deps: SweepDeps, column: Timer, stats: SweepStats): Promise<void> {
  const due = await deps.db.query<{
    id: string;
    workflow_state: string;
    deadline: Date;
  }>(
    `SELECT id, workflow_state, ${column} AS deadline FROM session ` +
      `WHERE ${column} IS NOT NULL AND ${column} <= $1 AND workflow_state IS NOT NULL ` +
      `AND status NOT IN ('done', 'failed', 'lost') ORDER BY ${column} LIMIT $2`,
    [deps.now(), SWEEP_BATCH],
  );
  for (const row of due.rows) {
    stats.fired++;
    try {
      const deadline = row.deadline.toISOString();
      const res = await deps.engine.applyEvent(row.id, {
        type: column === 'state_deadline' ? 'timer.fired' : 'watch.fired',
        state: row.workflow_state,
        deadline,
      });
      if (res.status === 'applied') {
        stats.applied++;
        continue;
      }
      stats.ignored++;
      // An expired deadline apply won't act on (e.g. the status no longer takes timers) would be
      // re-fired on every tick. Disarm it, guarded so a deadline re-armed meanwhile survives.
      // TD: apply should clear or re-arm the deadline itself whenever it ignores a matching timer.
      await deps.db.query(
        `UPDATE session SET ${column} = NULL ` +
          `WHERE id = $1 AND workflow_state = $2 AND ${column} = $3`,
        [row.id, row.workflow_state, row.deadline],
      );
    } catch (err) {
      stats.errors++;
      console.error(`[sweep] session ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
}
