import { withTransaction, type Tx } from '../db/index.js';
import type { OutboxRow, PushSubscriptionRow } from '../db/types.js';
import { backoffSeconds, DISPATCH_BATCH } from '../engine/dispatcher.js';
import type { Db } from '../main.js';
import type { PushOutboxPayload } from './enqueue.js';
import { PUSH_TTL_SECONDS, type PushSender } from './sender.js';
import { recordResult } from './store.js';

// UX-15: the push dispatcher, its own worker loop beside the machine dispatcher (NFR-1: a slow
// push service only delays pushes). It handles only `push_needs_input` rows (target `user:<id>`);
// the machine dispatcher only `machine:` ones.
//
// Each row is handled in its own transaction holding its lock (FOR UPDATE SKIP LOCKED), so two
// dispatchers never send the same row. Per-subscription idempotency: `payload.delivered` lists
// the subscriptions already sent, so a retry only sends to the ones that failed. A crash between
// a send and the COMMIT resends that one once (at least once); the notification `tag` (the
// input request id) makes the browser replace the duplicate. Bounded: a row older than the TTL
// is `failed`/`expired`, and a subscription that keeps failing is dropped (MAX_PUSH_FAILURES).

export interface PushDispatchStats {
  sent: number;
  failed: number;
  deleted: number;
  acked: number;
  expired: number;
  errors: number;
}

export interface PushDispatcherDeps {
  db: Db;
  sender: PushSender;
  now: () => Date;
}

const userOf = (target: string): string => target.slice('user:'.length);

/** One pass over the due push rows. */
export async function dispatchPushOnce(deps: PushDispatcherDeps): Promise<PushDispatchStats> {
  const stats: PushDispatchStats = {
    sent: 0,
    failed: 0,
    deleted: 0,
    acked: 0,
    expired: 0,
    errors: 0,
  };
  const due = await deps.db.query<{ id: string }>(
    "SELECT id FROM outbox WHERE kind = 'push_needs_input' AND status IN ('pending', 'sent') " +
      "AND next_attempt_at <= $1 AND target LIKE 'user:%' ORDER BY id LIMIT $2",
    [deps.now(), DISPATCH_BATCH],
  );
  for (const { id } of due.rows) {
    try {
      await withTransaction(deps.db, (tx) => dispatchPushRow(deps, tx, id, stats));
    } catch (err) {
      stats.errors++;
      console.error(`[push] row ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return stats;
}

async function dispatchPushRow(
  deps: PushDispatcherDeps,
  tx: Tx,
  id: string,
  stats: PushDispatchStats,
): Promise<void> {
  const now = deps.now();
  const r = await tx.query<OutboxRow>(
    "SELECT * FROM outbox WHERE id = $1 AND status IN ('pending', 'sent') " +
      'AND next_attempt_at <= $2 FOR UPDATE SKIP LOCKED',
    [id, now],
  );
  const row = r.rows[0];
  if (!row) return; // taken by another dispatcher, or done meanwhile
  const payload = row.payload as unknown as PushOutboxPayload;
  // The terminal UPDATEs drop the notification text: the question is kept on its input_request.
  const terminal = (status: 'acked' | 'failed', lastError: string | null) =>
    tx.query(
      "UPDATE outbox SET status = $2, last_error = $3, payload = jsonb_set(payload, '{notification}', 'null'::jsonb) " +
        'WHERE id = $1',
      [id, status, lastError],
    );

  if (now.getTime() - row.created_at.getTime() >= PUSH_TTL_SECONDS * 1000) {
    await terminal('failed', 'expired');
    stats.expired++;
    return;
  }
  const delivered = new Set(payload.delivered);
  const subs = await tx.query<PushSubscriptionRow>(
    'SELECT * FROM push_subscription WHERE account_id = $1 AND user_id = $2 ORDER BY created_at, id',
    [row.account_id, userOf(row.target)],
  );
  const body = JSON.stringify(payload.notification);
  let pending = 0;
  let lastError: string | null = null;
  for (const sub of subs.rows) {
    if (delivered.has(sub.id)) continue;
    const result = await deps.sender.send(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      body,
    );
    const outcome = await recordResult(tx, sub.id, result, now);
    if (outcome === 'ok') {
      delivered.add(sub.id);
      stats.sent++;
    } else if (outcome === 'deleted') {
      stats.deleted++;
    } else {
      pending++;
      stats.failed++;
      lastError = result.ok ? null : result.error;
    }
  }
  if (pending === 0) {
    await tx.query(
      "UPDATE outbox SET payload = jsonb_set(payload, '{delivered}', $2::jsonb) WHERE id = $1",
      [id, JSON.stringify([...delivered])],
    );
    await terminal('acked', null);
    stats.acked++;
    return;
  }
  const next = new Date(now.getTime() + backoffSeconds(row.attempts + 1) * 1000);
  await tx.query(
    'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = $2, last_error = $3, ' +
      "payload = jsonb_set(payload, '{delivered}', $4::jsonb) WHERE id = $1",
    [id, next, lastError, JSON.stringify([...delivered])],
  );
}
