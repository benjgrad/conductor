import { API_PATHS, type GithubWebhookStatus } from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import type { GithubWebhookRow } from '../db/types.js';
import { newWebhookSecret } from './signature.js';

// R11: the account's webhook secret and its deliveries. One implementation for the REST routes
// and `conductor-admin github-webhook`.

/** Deliveries are kept this long for dedup (GitHub redelivers within hours, not weeks). */
export const DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;

/** Where GitHub delivers for `accountId`, on `origin` (no trailing slash). */
export function webhookUrl(origin: string, accountId: string): string {
  return `${origin.replace(/\/+$/, '')}${API_PATHS.githubWebhookDelivery(accountId)}`;
}

/** A new secret for the account (the old one stops working at once). */
export async function rotateWebhookSecret(
  db: Queryable,
  accountId: string,
  now: Date,
): Promise<string> {
  const secret = newWebhookSecret();
  await db.query(
    `INSERT INTO github_webhook (account_id, secret, created_at, rotated_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (account_id) DO UPDATE SET secret = EXCLUDED.secret, rotated_at = EXCLUDED.rotated_at`,
    [accountId, secret, now],
  );
  return secret;
}

/** The account's secret, or null when none is set (every delivery is then refused). */
export async function webhookSecretOf(db: Queryable, accountId: string): Promise<string | null> {
  const r = await db.query<Pick<GithubWebhookRow, 'secret'>>(
    'SELECT secret FROM github_webhook WHERE account_id = $1',
    [accountId],
  );
  return r.rows[0]?.secret ?? null;
}

export async function webhookStatus(
  db: Queryable,
  accountId: string,
  origin: string,
): Promise<GithubWebhookStatus> {
  const r = await db.query<{ rotated_at: Date | null; last: Date | null }>(
    `SELECT (SELECT rotated_at FROM github_webhook WHERE account_id = $1) AS rotated_at,
            (SELECT max(received_at) FROM github_webhook_delivery WHERE account_id = $1) AS last`,
    [accountId],
  );
  const row = r.rows[0];
  return {
    url: webhookUrl(origin, accountId),
    configured: row?.rotated_at != null,
    rotated_at: row?.rotated_at?.toISOString() ?? null,
    last_delivery_at: row?.last?.toISOString() ?? null,
  };
}

/**
 * Record a delivery once (FR-4). False when `deliveryId` was already recorded: a redelivery, which
 * must change nothing. Also prunes deliveries older than DELIVERY_RETENTION_MS.
 */
export async function recordDelivery(
  tx: Queryable,
  p: { deliveryId: string; accountId: string; event: string; now: Date },
): Promise<boolean> {
  await tx.query('DELETE FROM github_webhook_delivery WHERE received_at < $1', [
    new Date(p.now.getTime() - DELIVERY_RETENTION_MS),
  ]);
  const r = await tx.query(
    `INSERT INTO github_webhook_delivery (delivery_id, account_id, event, received_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (delivery_id) DO NOTHING`,
    [p.deliveryId, p.accountId, p.event, p.now],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function setDeliveryNudged(
  tx: Queryable,
  deliveryId: string,
  nudged: number,
): Promise<void> {
  await tx.query('UPDATE github_webhook_delivery SET sessions_nudged = $2 WHERE delivery_id = $1', [
    deliveryId,
    nudged,
  ]);
}
