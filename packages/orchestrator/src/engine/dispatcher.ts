import { randomUUID } from 'node:crypto';
import type { BoardSseEvent } from '@conductor/shared';
import {
  commandEnvelopeForOutboxRow,
  type BoardBus,
  type EngineService,
  type OutboxTransport,
} from '../contracts.js';
import { withTransaction, type Tx } from '../db/index.js';
import type { OutboxRow } from '../db/types.js';
import type { Db } from '../main.js';
import { SCRUBBED_PAYLOAD_SQL } from './outbox.js';

// Outbox dispatcher (M1-T04b; 10-contracts §Outbox state machine). Each due row is handled in
// its own short transaction holding the row lock (FOR UPDATE SKIP LOCKED), so two dispatchers
// never send the same row at once and a gateway ack for it waits for our guarded UPDATE.

/** Seconds until the next send after the n-th send (n >= 1): 5, 10, 20, 40, then 60. */
export function backoffSeconds(n: number): number {
  return n >= 5 ? 60 : 5 * 2 ** (Math.max(n, 1) - 1);
}

/** A start_session `sent` this many times and due again has timed out (sent at 0, 5, 15 s). */
export const START_SESSION_ACK_ATTEMPTS = 3;
export const DISPATCH_BATCH = 100;

export interface DispatchStats {
  sent: number;
  notConnected: number;
  stale: number;
  ackTimeouts: number;
  errors: number;
}

export interface DispatcherDeps {
  db: Db;
  engine: EngineService;
  boardBus: BoardBus;
  now: () => Date;
}

type DueRow = OutboxRow & { session_token: string | null };

const machineOf = (target: string): string | null =>
  target.startsWith('machine:') ? target.slice('machine:'.length) : null;

/** One pass over the due outbox rows. */
export async function dispatchOnce(
  deps: DispatcherDeps,
  transport: OutboxTransport,
): Promise<DispatchStats> {
  const stats: DispatchStats = { sent: 0, notConnected: 0, stale: 0, ackTimeouts: 0, errors: 0 };
  const now = deps.now();
  const due = await deps.db.query<{ id: string; target: string }>(
    "SELECT id, target FROM outbox WHERE status IN ('pending', 'sent') " +
      "AND next_attempt_at <= $1 AND target LIKE 'machine:%' ORDER BY id LIMIT $2",
    [now, DISPATCH_BATCH],
  );
  for (const { id, target } of due.rows) {
    const machineId = machineOf(target)!;
    if (!transport.isConnected(machineId)) {
      stats.notConnected++;
      continue;
    }
    try {
      const publish = await withTransaction(deps.db, (tx) =>
        dispatchRow(deps, tx, id, machineId, transport, stats),
      );
      for (const ev of publish) deps.boardBus.publish(ev);
    } catch (err) {
      stats.errors++;
      console.error(`[outbox] row ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return stats;
}

async function dispatchRow(
  deps: DispatcherDeps,
  tx: Tx,
  id: string,
  machineId: string,
  transport: OutboxTransport,
  stats: DispatchStats,
): Promise<BoardSseEvent[]> {
  const now = deps.now();
  const r = await tx.query<DueRow>(
    'SELECT o.*, s.fencing_token AS session_token FROM outbox o ' +
      'LEFT JOIN session s ON s.id = o.session_id ' +
      "WHERE o.id = $1 AND o.status IN ('pending', 'sent') AND o.next_attempt_at <= $2 " +
      'FOR UPDATE OF o SKIP LOCKED',
    [id, now],
  );
  const row = r.rows[0];
  if (!row) return []; // taken by another dispatcher, acked, or rescheduled meanwhile

  if (
    row.fencing_token !== null &&
    row.session_token !== null &&
    BigInt(row.fencing_token) < BigInt(row.session_token)
  ) {
    await tx.query(
      "UPDATE outbox SET status = 'failed', last_error = 'stale_fencing_token', " +
        `payload = ${SCRUBBED_PAYLOAD_SQL} ` +
        "WHERE id = $1 AND status IN ('pending', 'sent')",
      [id],
    );
    stats.stale++;
    return [];
  }

  if (
    row.kind === 'start_session' &&
    row.status === 'sent' &&
    row.attempts >= START_SESSION_ACK_ATTEMPTS
  ) {
    const u = await tx.query(
      "UPDATE outbox SET status = 'failed', last_error = 'ack_timeout', " +
        `payload = ${SCRUBBED_PAYLOAD_SQL} ` +
        "WHERE id = $1 AND status = 'sent'",
      [id],
    );
    stats.ackTimeouts++;
    if (u.rowCount !== 1 || row.session_id === null) return [];
    const res = await deps.engine.applyEvent(
      row.session_id,
      {
        type: 'command.refused',
        command_id: row.command_id,
        command_kind: 'start_session',
        reason: 'ack_timeout',
      },
      { tx },
    );
    return res.status === 'applied' ? res.boardEvents : [];
  }

  const result = await transport.send(machineId, commandEnvelopeForOutboxRow(row, randomUUID()));
  if (result === 'not_connected') {
    stats.notConnected++;
    return [];
  }
  const next = new Date(now.getTime() + backoffSeconds(row.attempts + 1) * 1000);
  await tx.query(
    "UPDATE outbox SET status = 'sent', attempts = attempts + 1, next_attempt_at = $2 " +
      "WHERE id = $1 AND status IN ('pending', 'sent')",
    [id, next],
  );
  stats.sent++;
  return [];
}
