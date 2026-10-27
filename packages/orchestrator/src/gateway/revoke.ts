import { CLOSE_REASONS, CLOSE_REVOKED, type AccountScope } from '@conductor/shared';
import { withTransaction } from '../db/index.js';
import { SCRUBBED_PAYLOAD_SQL } from '../engine/outbox.js';
import type { Db } from '../main.js';

// M2-T09: revoke a machine (ADR-0013 §Enrollment 5; 10-contracts §Machines protocol v2, "Revoke
// and the outbox (R4)").

/** Closes a machine's live daemon sockets; the gateway implements it. */
export interface MachineSockets {
  disconnectMachine(machineId: string, code: number, reason: string): void;
}

export interface RevokeResult {
  machine_id: string;
  /** The machine's non-terminal sessions: the caller (M2-T20) hands each to a human. */
  live_session_ids: string[];
}

/**
 * In one transaction: set `revoked_at` on the machine and its credentials, and fail every
 * `pending` / `sent` outbox row for `machine:<id>` with `last_error = 'machine_revoked'` (no
 * engine event; fenced kills from an earlier `lease_expired` included: the machine can never
 * take them). After the commit, close its socket with CLOSE_REVOKED. Idempotent.
 * null = no such machine in the scope's account (404).
 */
export async function revokeMachine(
  deps: { db: Db; sockets: MachineSockets },
  scope: AccountScope,
  machineId: string,
): Promise<RevokeResult | null> {
  const result = await withTransaction(deps.db, async (tx): Promise<RevokeResult | null> => {
    const m = await tx.query(
      `UPDATE machine SET revoked_at = COALESCE(revoked_at, now()), status = 'offline',
              updated_at = now()
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      [machineId, scope.account_id],
    );
    if (m.rowCount === 0) return null;
    await tx.query(
      `UPDATE machine_credential SET revoked_at = now()
        WHERE machine_id = $1 AND revoked_at IS NULL`,
      [machineId],
    );
    await tx.query(
      `UPDATE outbox SET status = 'failed', last_error = 'machine_revoked',
              payload = ${SCRUBBED_PAYLOAD_SQL}
        WHERE target = $1 AND status IN ('pending', 'sent')`,
      [`machine:${machineId}`],
    );
    const live = await tx.query<{ id: string }>(
      `SELECT id FROM session
        WHERE machine_id = $1 AND status NOT IN ('done', 'failed', 'lost')
        ORDER BY created_at, id`,
      [machineId],
    );
    return { machine_id: machineId, live_session_ids: live.rows.map((r) => r.id) };
  });
  // M2-T20 applies `machine.lost {reason: 'revoked'}` to each of `live_session_ids`.
  if (result) {
    deps.sockets.disconnectMachine(machineId, CLOSE_REVOKED, CLOSE_REASONS[CLOSE_REVOKED]);
  }
  return result;
}
