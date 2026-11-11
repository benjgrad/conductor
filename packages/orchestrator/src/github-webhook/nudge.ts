import { PR_CONTEXT_KEY, STEP_CONTEXT_KEY } from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { sessionsToNudge, type NudgeCandidate, type WebhookTarget } from './events.js';

// R11: bring the matching sessions' next check forward to now, the way the internal nudges do
// (watch-nudge.ts for watches, concurrency.ts for held moves). The sweep then fires `timer.fired`
// / `watch.fired` and apply evaluates as usual; this never calls apply and never moves a deadline
// later (`> now` guards), so a repeated nudge changes nothing.

export interface NudgeCounts {
  conditions: number;
  watches: number;
}

/**
 * The account's live sessions that have a check still ahead: a conditions phase waiting on its
 * poll, or a watch. The repo, PR and branch are matched in `sessionsToNudge` (pure), because
 * `ticket.repo` is stored as given and only `repoChecksKey` makes it comparable.
 */
export async function candidatesOf(
  tx: Queryable,
  p: { accountId: string; now: Date },
): Promise<NudgeCandidate[]> {
  const r = await tx.query<NudgeCandidate>(
    `SELECT s.id, t.repo, s.context -> $3 ->> 'pr_url' AS pr_url, s.branch,
            (s.status = 'waiting_external' AND s.context -> $4 ->> 'phase' = 'conditions'
              AND s.state_deadline IS NOT NULL AND s.state_deadline > $2) AS conditions_pending,
            (s.watch_deadline IS NOT NULL AND s.watch_deadline > $2) AS watching
       FROM session s JOIN ticket t ON t.id = s.ticket_id
      WHERE t.account_id = $1 AND s.status NOT IN ('done', 'failed', 'lost')
        AND s.workflow_state IS NOT NULL
        AND ((s.state_deadline IS NOT NULL AND s.state_deadline > $2)
             OR (s.watch_deadline IS NOT NULL AND s.watch_deadline > $2))`,
    [p.accountId, p.now, PR_CONTEXT_KEY, STEP_CONTEXT_KEY],
  );
  return r.rows;
}

/** Wake the sessions `target` matches. Returns how many of each were brought forward. */
export async function nudgeForWebhook(
  tx: Queryable,
  p: { accountId: string; target: WebhookTarget; now: Date },
): Promise<NudgeCounts> {
  const { conditions, watches } = sessionsToNudge(p.target, await candidatesOf(tx, p));
  let c = 0;
  let w = 0;
  if (conditions.length > 0) {
    const r = await tx.query(
      `UPDATE session SET state_deadline = $2
        WHERE id = ANY($1::uuid[]) AND status = 'waiting_external'
          AND context -> $3 ->> 'phase' = 'conditions'
          AND state_deadline IS NOT NULL AND state_deadline > $2`,
      [conditions, p.now, STEP_CONTEXT_KEY],
    );
    c = r.rowCount ?? 0;
  }
  if (watches.length > 0) {
    const r = await tx.query(
      `UPDATE session SET watch_deadline = $2
        WHERE id = ANY($1::uuid[]) AND status NOT IN ('done', 'failed', 'lost')
          AND watch_deadline IS NOT NULL AND watch_deadline > $2`,
      [watches, p.now],
    );
    w = r.rowCount ?? 0;
  }
  return { conditions: c, watches: w };
}
