import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ENROLLMENT_TOKEN_TTL_MS,
  type AccountScope,
  type EnrollRequest,
  type EnrollResponse,
} from '@conductor/shared';
import { withTransaction } from '../db/index.js';
import type { Db } from '../main.js';

// M2-T09: machine enrollment (ADR-0013 §Enrollment). A one-time 128-bit token, scoped to an
// account, becomes a machine with a server-generated id and a 256-bit credential. Only SHA-256
// hashes are stored. REST exposure (POST /api/machines/enroll, …/enrollment-tokens) is M2-T17's.

const ENROLLMENT_TOKEN_BYTES = 16;
const CREDENTIAL_BYTES = 32;

/** SHA-256 of a token or credential: what `token_hash` / `secret_hash` store. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export interface EnrollmentTokenIssued {
  id: string;
  /** base64url; shown once (inside the install command), never stored. */
  token: string;
  expires_at: Date;
}

/** A single-use enrollment token for the scope's account, valid for ENROLLMENT_TOKEN_TTL_MS. */
export async function createEnrollmentToken(
  db: Db,
  scope: AccountScope,
): Promise<EnrollmentTokenIssued> {
  const token = randomBytes(ENROLLMENT_TOKEN_BYTES).toString('base64url');
  const createdBy = scope.actor.kind === 'user' ? scope.actor.user_id : null;
  const r = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO enrollment_token (account_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
     RETURNING id, expires_at`,
    [scope.account_id, hashSecret(token), createdBy, ENROLLMENT_TOKEN_TTL_MS],
  );
  const row = r.rows[0]!;
  return { id: row.id, token, expires_at: row.expires_at };
}

/**
 * Consume `req.token` and create the machine and its credential, in one transaction. null = the
 * token is unknown, used or expired (T17 answers 401). Two concurrent uses serialise on the
 * token row: the second sees `used_at` set and gets null.
 */
export async function enrollMachine(db: Db, req: EnrollRequest): Promise<EnrollResponse | null> {
  return withTransaction(db, async (tx) => {
    const t = await tx.query<{ id: string; account_id: string }>(
      `UPDATE enrollment_token SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id, account_id`,
      [hashSecret(req.token)],
    );
    const token = t.rows[0];
    if (!token) return null;

    const machineId = randomUUID();
    // Capacity is 0 and status offline until the daemon's first `register` fills in its facts,
    // so the claim never offers it work before then.
    await tx.query(
      `INSERT INTO machine (id, account_id, name, hostname, os, arch, daemon_version, status,
                            cpu_total, mem_total_mb, disk_free_mb, budget_cpu, budget_mem_mb,
                            max_sessions, max_concurrent_builds)
       VALUES ($1, $2, $3, $3, $4, $5, $6, 'offline', 0, 0, 0, 0, 0, 0, 0)`,
      [machineId, token.account_id, req.hostname, req.os, req.arch, req.daemon_version],
    );
    const credential = randomBytes(CREDENTIAL_BYTES).toString('base64url');
    await tx.query(
      `INSERT INTO machine_credential (machine_id, account_id, secret_hash) VALUES ($1, $2, $3)`,
      [machineId, token.account_id, hashSecret(credential)],
    );
    await tx.query(`UPDATE enrollment_token SET used_by_machine = $2 WHERE id = $1`, [
      token.id,
      machineId,
    ]);
    return { machine_id: machineId, credential };
  });
}
