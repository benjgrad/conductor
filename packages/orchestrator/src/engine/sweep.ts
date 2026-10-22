import type { EngineService } from '../contracts.js';
import type { Db } from '../main.js';

// Timeout sweep (M1-T04b; 10-contracts §Engine `timer.fired`). Finds sessions whose
// `state_deadline` has passed and feeds `timer.fired {state, deadline}` through the engine;
// apply ignores it (`stale_timer`) if the session moved on meanwhile.

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

export async function sweepOnce(deps: SweepDeps): Promise<SweepStats> {
  const stats: SweepStats = { fired: 0, applied: 0, ignored: 0, errors: 0 };
  const due = await deps.db.query<{
    id: string;
    workflow_state: string;
    state_deadline: Date;
  }>(
    'SELECT id, workflow_state, state_deadline FROM session ' +
      'WHERE state_deadline IS NOT NULL AND state_deadline <= $1 AND workflow_state IS NOT NULL ' +
      "AND status NOT IN ('done', 'failed', 'lost') ORDER BY state_deadline LIMIT $2",
    [deps.now(), SWEEP_BATCH],
  );
  for (const row of due.rows) {
    stats.fired++;
    try {
      const deadline = row.state_deadline.toISOString();
      const res = await deps.engine.applyEvent(row.id, {
        type: 'timer.fired',
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
        'UPDATE session SET state_deadline = NULL ' +
          'WHERE id = $1 AND workflow_state = $2 AND state_deadline = $3',
        [row.id, row.workflow_state, row.state_deadline],
      );
    } catch (err) {
      stats.errors++;
      console.error(`[sweep] session ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return stats;
}
