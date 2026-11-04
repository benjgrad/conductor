import type { Queryable } from '../contracts.js';
import { hashSecret } from './enroll.js';

// M2-T09 machine credentials, shared by the WS upgrade (gateway/index.ts) and the daemon's HTTP
// routes (06 §Attachments: GET API_PATHS.daemonAttachmentContent).

export interface MachineAuth {
  machineId: string;
  accountId: string;
}

/**
 * The live credential's machine and account, or null (unknown, revoked, or a revoked machine).
 * Records `last_used_at`.
 */
export async function authenticateMachine(
  db: Queryable,
  credential: string,
): Promise<MachineAuth | null> {
  const r = await db.query<{ machine_id: string; account_id: string }>(
    `UPDATE machine_credential c SET last_used_at = now()
       FROM machine m
      WHERE c.secret_hash = $1 AND c.revoked_at IS NULL
        AND m.id = c.machine_id AND m.revoked_at IS NULL
      RETURNING c.machine_id, c.account_id`,
    [hashSecret(credential)],
  );
  const row = r.rows[0];
  return row ? { machineId: row.machine_id, accountId: row.account_id } : null;
}
