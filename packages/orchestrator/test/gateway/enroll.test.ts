// M2-T09: enrollment tokens and enrollMachine (ADR-0013 §Enrollment). Needs `pnpm db:up`.
import { ENROLLMENT_TOKEN_TTL_MS, LOCAL_ACCOUNT_ID, localScope } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import type { EnrollmentTokenRow, MachineCredentialRow, MachineRow } from '../../src/db/types.js';
import { createEnrollmentToken, enrollMachine, hashSecret } from '../../src/gateway/enroll.js';
import { useTestDatabase } from '../db.js';
import { newAccount } from './auth-harness.js';

const db = useTestDatabase();

const request = (token: string) => ({
  token,
  hostname: 'laptop.local',
  os: 'darwin',
  arch: 'arm64',
  daemon_version: '0.2.0+abc',
});

describe('createEnrollmentToken', () => {
  it('stores only the hash of a 128-bit token, scoped to the account, for 30 minutes', async () => {
    const scope = await newAccount(db.pool);
    const before = Date.now();
    const issued = await createEnrollmentToken(db.pool, scope);
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(16);
    const row = (
      await db.pool.query<EnrollmentTokenRow>('SELECT * FROM enrollment_token WHERE id = $1', [
        issued.id,
      ])
    ).rows[0]!;
    expect(row.token_hash.equals(hashSecret(issued.token))).toBe(true);
    expect(row).toMatchObject({
      account_id: scope.account_id,
      created_by: scope.actor.kind === 'user' ? scope.actor.user_id : null,
      used_at: null,
      used_by_machine: null,
    });
    const ttl = row.expires_at.getTime() - before;
    expect(ttl).toBeGreaterThan(ENROLLMENT_TOKEN_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(ENROLLMENT_TOKEN_TTL_MS + 5_000);
  });

  it('records no user for a non-user actor', async () => {
    const issued = await createEnrollmentToken(db.pool, localScope({ kind: 'system' }));
    const row = (
      await db.pool.query<EnrollmentTokenRow>('SELECT * FROM enrollment_token WHERE id = $1', [
        issued.id,
      ])
    ).rows[0]!;
    expect(row).toMatchObject({ account_id: LOCAL_ACCOUNT_ID, created_by: null });
  });
});

describe('enrollMachine', () => {
  it('a token enrolls once: a machine in its account and a 256-bit credential', async () => {
    const scope = await newAccount(db.pool);
    const { id, token } = await createEnrollmentToken(db.pool, scope);
    const res = await enrollMachine(db.pool, request(token));
    expect(res).not.toBeNull();
    const { machine_id, credential } = res!;
    expect(Buffer.from(credential, 'base64url')).toHaveLength(32);

    const m = (await db.pool.query<MachineRow>('SELECT * FROM machine WHERE id = $1', [machine_id]))
      .rows[0]!;
    expect(m).toMatchObject({
      account_id: scope.account_id,
      name: 'laptop.local',
      hostname: 'laptop.local',
      os: 'darwin',
      arch: 'arm64',
      daemon_version: '0.2.0+abc',
      status: 'offline',
      max_sessions: 0,
      revoked_at: null,
    });
    const creds = (
      await db.pool.query<MachineCredentialRow>(
        'SELECT * FROM machine_credential WHERE machine_id = $1',
        [machine_id],
      )
    ).rows;
    expect(creds).toHaveLength(1);
    expect(creds[0]!.secret_hash.equals(hashSecret(credential))).toBe(true);
    expect(creds[0]).toMatchObject({ account_id: scope.account_id, revoked_at: null });
    const t = (
      await db.pool.query<EnrollmentTokenRow>('SELECT * FROM enrollment_token WHERE id = $1', [id])
    ).rows[0]!;
    expect(t.used_by_machine).toBe(machine_id);
    expect(t.used_at).toBeInstanceOf(Date);

    // A second use fails and creates nothing.
    expect(await enrollMachine(db.pool, request(token))).toBeNull();
    const n = await db.pool.query('SELECT 1 FROM machine WHERE account_id = $1', [
      scope.account_id,
    ]);
    expect(n.rowCount).toBe(1);
  });

  it('an expired token fails', async () => {
    const scope = await newAccount(db.pool);
    const { id, token } = await createEnrollmentToken(db.pool, scope);
    await db.pool.query(
      `UPDATE enrollment_token SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await enrollMachine(db.pool, request(token))).toBeNull();
    const t = await db.pool.query('SELECT used_at FROM enrollment_token WHERE id = $1', [id]);
    expect(t.rows).toEqual([{ used_at: null }]);
  });

  it('a token not in the table (never issued, or not this one) fails', async () => {
    const scope = await newAccount(db.pool);
    const { token } = await createEnrollmentToken(db.pool, scope);
    expect(await enrollMachine(db.pool, request(`${token}x`))).toBeNull();
    expect(await enrollMachine(db.pool, request('not-a-token'))).toBeNull();
    const n = await db.pool.query('SELECT 1 FROM machine WHERE account_id = $1', [
      scope.account_id,
    ]);
    expect(n.rowCount).toBe(0);
  });

  it('two concurrent uses of one token create exactly one machine', async () => {
    const scope = await newAccount(db.pool);
    const { token } = await createEnrollmentToken(db.pool, scope);
    const results = await Promise.all([
      enrollMachine(db.pool, request(token)),
      enrollMachine(db.pool, request(token)),
      enrollMachine(db.pool, request(token)),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const n = await db.pool.query('SELECT 1 FROM machine WHERE account_id = $1', [
      scope.account_id,
    ]);
    expect(n.rowCount).toBe(1);
  });

  it("the credential's and the token's plaintext are in no table", async () => {
    const scope = await newAccount(db.pool);
    const { token } = await createEnrollmentToken(db.pool, scope);
    const { credential } = (await enrollMachine(db.pool, request(token)))!;
    const tables = (
      await db.pool.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.name);
    expect(tables).toContain('machine_credential');
    for (const secret of [credential, token]) {
      // The text and the hex/base64 forms of the raw bytes.
      const needles = [
        secret,
        Buffer.from(secret, 'base64url').toString('hex'),
        Buffer.from(secret, 'base64url').toString('base64'),
      ];
      for (const table of tables) {
        const { rows } = await db.pool.query<{ row: string }>(
          `SELECT t::text AS row FROM ${table} t`,
        );
        for (const { row } of rows) {
          for (const needle of needles)
            expect([table, row.includes(needle)]).toEqual([table, false]);
        }
      }
    }
  });
});
