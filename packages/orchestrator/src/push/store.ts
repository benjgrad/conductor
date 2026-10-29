import type { Queryable } from '../contracts.js';
import type { PushSubscriptionRow } from '../db/types.js';
import type { PushResult } from './sender.js';

// UX-15: push_subscription, per user and account-scoped (NFR-2). Nothing here returns an
// endpoint to a caller outside the orchestrator.

/** The 5th consecutive failure (other than 404 / 410) drops the subscription (FR-4). */
export const MAX_PUSH_FAILURES = 5;
const USER_AGENT_MAX = 512;

export interface PushOwner {
  account_id: string;
  user_id: string;
}

/**
 * Upsert by endpoint: the same browser subscribing again (possibly as another user) takes the
 * row over with its new keys and a clean failure count.
 */
export async function upsertSubscription(
  db: Queryable,
  owner: PushOwner,
  sub: { endpoint: string; p256dh: string; auth: string },
  userAgent: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO push_subscription (account_id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET account_id = EXCLUDED.account_id,
       user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, failures = 0`,
    [
      owner.account_id,
      owner.user_id,
      sub.endpoint,
      sub.p256dh,
      sub.auth,
      userAgent === null ? null : userAgent.slice(0, USER_AGENT_MAX),
    ],
  );
}

/** Delete the caller's own subscription by endpoint. Idempotent (nothing matched is fine). */
export async function deleteSubscription(
  db: Queryable,
  owner: PushOwner,
  endpoint: string,
): Promise<void> {
  await db.query(
    'DELETE FROM push_subscription WHERE endpoint = $1 AND account_id = $2 AND user_id = $3',
    [endpoint, owner.account_id, owner.user_id],
  );
}

export async function subscriptionsOf(
  db: Queryable,
  owner: PushOwner,
): Promise<PushSubscriptionRow[]> {
  const r = await db.query<PushSubscriptionRow>(
    'SELECT * FROM push_subscription WHERE account_id = $1 AND user_id = $2 ORDER BY created_at, id',
    [owner.account_id, owner.user_id],
  );
  return r.rows;
}

/**
 * Book one send's result on its subscription: ok → `last_ok_at`, failures reset; 404 / 410 →
 * deleted; anything else → `failures + 1`, deleted at MAX_PUSH_FAILURES. Returns what happened.
 */
export async function recordResult(
  db: Queryable,
  subscriptionId: string,
  result: PushResult,
  now: Date,
): Promise<'ok' | 'deleted' | 'failed'> {
  if (result.ok) {
    await db.query('UPDATE push_subscription SET last_ok_at = $2, failures = 0 WHERE id = $1', [
      subscriptionId,
      now,
    ]);
    return 'ok';
  }
  if (result.gone) {
    await db.query('DELETE FROM push_subscription WHERE id = $1', [subscriptionId]);
    return 'deleted';
  }
  const r = await db.query<{ failures: number }>(
    'UPDATE push_subscription SET failures = failures + 1 WHERE id = $1 RETURNING failures',
    [subscriptionId],
  );
  if ((r.rows[0]?.failures ?? 0) >= MAX_PUSH_FAILURES) {
    await db.query('DELETE FROM push_subscription WHERE id = $1', [subscriptionId]);
    return 'deleted';
  }
  return 'failed';
}
