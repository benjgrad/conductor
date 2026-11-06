import { PR_CONTEXT_KEY, type EngineEvent, type SessionSnapshot } from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0037 P1 (T6, ADR-0037 Q1): conductor knows when the merges and pushes it performs happen, so
// a watched ticket on the same repo is checked at once instead of at its next poll. A scheduler
// nudge, not a webhook: the triggering transaction sets the other sessions' `watch_deadline` to
// now and the sweep (every second) fires their `watch.fired`. Merges done outside conductor are
// seen at the next poll.

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'lost']);

/**
 * Does this applied event change what the repo's default branch (or a pushed branch) looks like?
 * (a) a `merge_pr` action succeeded; (b) a human moved the ticket into a terminal state from a
 * state with conductor's PR ("Merged, done"); (c) `open_pr` pushed the session's branch.
 */
export function nudgesWatches(
  event: EngineEvent,
  before: SessionSnapshot,
  after: SessionSnapshot,
): boolean {
  if (event.type === 'action.completed') {
    return event.error === null && (event.action === 'merge_pr' || event.action === 'open_pr');
  }
  if (event.type === 'human.transition') {
    return (
      before.step === null &&
      !TERMINAL.has(before.status) &&
      TERMINAL.has(after.status) &&
      before.context[PR_CONTEXT_KEY]?.pr_url !== undefined
    );
  }
  return false;
}

/**
 * Bring forward the next watch check of every other live session of the account on `repo` that
 * is watching. Returns how many were nudged.
 */
export async function nudgeSameRepoWatches(
  tx: Queryable,
  p: { accountId: string; repo: string; exceptSessionId: string; now: Date },
): Promise<number> {
  const r = await tx.query(
    `UPDATE session s SET watch_deadline = $4
       FROM ticket t
      WHERE s.ticket_id = t.id AND t.account_id = $1 AND t.repo = $2 AND s.id <> $3
        AND s.watch_deadline IS NOT NULL AND s.watch_deadline > $4
        AND s.status NOT IN ('done', 'failed', 'lost')`,
    [p.accountId, p.repo, p.exceptSessionId, p.now],
  );
  return r.rowCount ?? 0;
}
