import { budgetVerdict, type SessionSnapshot } from '@conductor/shared';
import type { EngineService, OutputBus } from '../contracts.js';
import type { Db } from '../main.js';
import { DefinitionCache, splitStep } from './rows.js';

// Timeout sweep (M1-T04b; 10-contracts §Engine `timer.fired`). Finds sessions whose
// `state_deadline` has passed and feeds `timer.fired {state, deadline}` through the engine;
// apply ignores it (`stale_timer`) if the session moved on meanwhile.
// ADR-0037 P1 (T6): the same for `watch_deadline` (a watched human / event state's next check),
// fed as `watch.fired`. A merge or push on the same repo sets it to now (watch-nudge.ts), so the
// next tick checks the watch at once.
// ADR-0041: open input requests whose `default_at` passed, fed as `default.fired`: conductor
// delivers the agent's recommended answer (the wrapper closes the request, answered_by system).

export const SWEEP_BATCH = 100;

export interface SweepDeps {
  db: Db;
  engine: EngineService;
  now: () => Date;
  /** ADR-0041: notes a default answer in the Messages thread (a `debug` chunk). */
  outputBus?: OutputBus;
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
  await sweepDefaults(deps, stats);
  return stats;
}

/**
 * ADR-0041: each open request whose default is due, while its session still waits on a human.
 * apply ignores a stale one (`stale_timer`: the session moved, or a newer visit); its
 * `default_at` is then cleared, so it is not fired again.
 */
async function sweepDefaults(deps: SweepDeps, stats: SweepStats): Promise<void> {
  const due = await deps.db.query<{
    id: string;
    session_id: string;
    workflow_state: string;
    default_at: Date;
    default_answer: string | null;
  }>(
    'SELECT ir.id, ir.session_id, s.workflow_state, ir.default_at, ir.default_answer ' +
      'FROM input_request ir JOIN session s ON s.id = ir.session_id ' +
      'WHERE ir.answer IS NULL AND ir.default_at IS NOT NULL AND ir.default_at <= $1 ' +
      "AND s.workflow_state IS NOT NULL AND s.status = 'needs_input' " +
      'ORDER BY ir.default_at LIMIT $2',
    [deps.now(), SWEEP_BATCH],
  );
  for (const row of due.rows) {
    stats.fired++;
    try {
      const res = await deps.engine.applyEvent(row.session_id, {
        type: 'default.fired',
        state: row.workflow_state,
        deadline: row.default_at.toISOString(),
        input_request_id: row.id,
      });
      if (res.status === 'applied') {
        stats.applied++;
        deps.outputBus?.append(
          row.session_id,
          'debug',
          `Conductor answered for you (no human answer in time): ${row.default_answer ?? ''}`,
        );
        continue;
      }
      stats.ignored++;
      await deps.db.query(
        'UPDATE input_request SET default_at = NULL WHERE id = $1 AND default_at = $2',
        [row.id, row.default_at],
      );
    } catch (err) {
      stats.errors++;
      console.error(`[sweep] default ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
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

// 09 §Budgets: the wall-time trigger. The spend trigger runs in the EngineService right after a
// `spend.reported`; minutes grow with no event, so this sweep checks every active session's
// running clock (and its spend, belt and braces) and feeds `budget.exceeded` for each one over
// budget. apply re-checks the verdict on its own snapshot (`within_budget` otherwise).

/** How often the engine loop runs `sweepBudgets` (minutes need no second-level precision). */
export const BUDGET_SWEEP_INTERVAL_MS = 15_000;

const budgetDefs = new DefinitionCache();

export interface BudgetSweepStats {
  checked: number;
  exceeded: number;
  errors: number;
}

export async function sweepBudgets(deps: SweepDeps): Promise<BudgetSweepStats> {
  const stats: BudgetSweepStats = { checked: 0, exceeded: 0, errors: 0 };
  const now = deps.now();
  const rows = await deps.db.query<{
    id: string;
    workflow_id: string;
    workflow_version: number;
    status: SessionSnapshot['status'];
    workflow_state: string;
    spend_usd: string | number;
    wall_seconds: string | number;
    state_entered_at: Date;
    context: SessionSnapshot['context'];
  }>(
    `SELECT id, workflow_id, workflow_version, status, workflow_state,
            spend_usd, wall_seconds, state_entered_at, context
       FROM session
      WHERE status IN ('assigned', 'running', 'queued') AND workflow_state IS NOT NULL
      ORDER BY state_entered_at LIMIT $1`,
    [SWEEP_BATCH * 10],
  );
  for (const row of rows.rows) {
    stats.checked++;
    try {
      const def = await budgetDefs.get(deps.db, row.workflow_id, row.workflow_version);
      const { context, step } = splitStep(row.context ?? {});
      const verdict = budgetVerdict(
        def,
        {
          status: row.status,
          workflow_state: row.workflow_state,
          step,
          spend_usd: Number(row.spend_usd),
          wall_seconds: Number(row.wall_seconds),
          state_entered_at: row.state_entered_at.toISOString(),
          context,
        },
        now,
      );
      if (verdict === null) continue;
      const res = await deps.engine.applyEvent(row.id, { type: 'budget.exceeded', ...verdict });
      if (res.status === 'applied') stats.exceeded++;
    } catch (err) {
      stats.errors++;
      console.error(`[budget] session ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return stats;
}
