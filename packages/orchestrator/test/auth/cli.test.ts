// M2-T15a: `conductor-admin` commands (ADR-0017 §Invites, sign-up, resets, the admin), run
// in-process against a test database. Needs `pnpm db:up`.
import { randomBytes, randomUUID } from 'node:crypto';
import { LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_TTL_MS,
  BOOTSTRAP_UNPINNED_WARNING,
  runAdminCli,
} from '../../src/auth/admin-commands.js';
import { previewInvite } from '../../src/auth/invites.js';
import { createSession, hashToken } from '../../src/auth/sessions.js';
import { WRONG_EMAIL_MESSAGE } from '../../src/auth/signup.js';
import { isLocked, recordFailure } from '../../src/auth/throttle.js';
import { useTestDatabase } from '../db.js';
import { LOOPBACK_URL, createUser, passwordAuth, startApi, type TestApi } from './helpers.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
let printed: string[] = [];
let api: TestApi | null = null;

const run = async (argv: string[], publicUrl: URL | null = new URL(LOOPBACK_URL)) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCli(argv, {
    db: db.pool,
    publicUrl,
    now: () => new Date(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  printed.push(...out, ...err);
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const urlIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? '';

async function wipeUsers() {
  for (const t of ['web_session', 'password_reset', 'invite', 'account_member']) {
    await db.pool.query(`DELETE FROM ${t}`);
  }
  await db.pool.query('UPDATE machine SET revoked_at = NULL');
  await db.pool.query('DELETE FROM machine_credential');
  await db.pool.query('DELETE FROM machine');
  await db.pool.query('DELETE FROM app_user');
}

beforeEach(async () => {
  printed = [];
  await wipeUsers();
});

// Nothing the CLI printed in a test holds a password hash or any hash stored by that test.
afterEach(async () => {
  await api?.close();
  api = null;
  const all = printed.join('\n');
  expect(all).not.toMatch(/\$argon2/);
  const hashes = await db.pool.query<{ h: Buffer }>(
    'SELECT token_hash AS h FROM invite UNION ALL SELECT token_hash FROM password_reset ' +
      'UNION ALL SELECT id_hash FROM web_session UNION ALL SELECT secret_hash FROM machine_credential',
  );
  const pw = await db.pool.query<{ h: string }>('SELECT password_hash AS h FROM app_user');
  for (const { h } of pw.rows) expect(all).not.toContain(h);
  for (const { h } of hashes.rows) {
    expect(all).not.toContain(h.toString('hex'));
    expect(all).not.toContain(h.toString('base64'));
    expect(all).not.toContain(h.toString('base64url'));
  }
});

describe('bootstrap', () => {
  it('prints a one-hour admin invite for `local` on an empty database, and refuses once a user exists', async () => {
    const before = Date.now();
    const r = await run(['bootstrap']);
    expect(r.code).toBe(0);
    const url = new URL(urlIn(r.out));
    expect(url.origin + url.pathname).toBe(`${LOOPBACK_URL}/signup`);
    const token = url.searchParams.get('invite')!;
    const p = await previewInvite(db.pool, token, new Date());
    expect(p.valid).toBe(true);
    const expiry = new Date(p.expires_at!).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + BOOTSTRAP_TTL_MS);
    expect(expiry).toBeLessThanOrEqual(Date.now() + BOOTSTRAP_TTL_MS);
    const row = await db.pool.query('SELECT is_admin, claims_account, created_by FROM invite');
    expect(row.rows).toEqual([
      { is_admin: true, claims_account: LOCAL_ACCOUNT_ID, created_by: null },
    ]);

    await createUser(db.pool, { password: PASSWORD });
    const again = await run(['bootstrap']);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/refusing/);
    expect(again.out).toBe('');
  });

  it('a second bootstrap (no user yet) revokes the first link', async () => {
    const first = new URL(urlIn((await run(['bootstrap'])).out)).searchParams.get('invite')!;
    const second = new URL(urlIn((await run(['bootstrap'])).out)).searchParams.get('invite')!;
    expect((await previewInvite(db.pool, first, new Date())).valid).toBe(false);
    expect((await previewInvite(db.pool, second, new Date())).valid).toBe(true);
  });

  it('without --email the invite is unpinned and a one-line warning recommends --email', async () => {
    const r = await run(['bootstrap']);
    expect(r.code).toBe(0);
    expect(r.err).toBe(BOOTSTRAP_UNPINNED_WARNING);
    expect(r.err).toMatch(/--email/);
    const row = await db.pool.query('SELECT email FROM invite');
    expect(row.rows).toEqual([{ email: null }]);
  });

  it('--email pins the invite: sign-up with another email → 400, with that email → 201', async () => {
    const r = await run(['bootstrap', '--email', ' Ben@Example.com ']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('ben@example.com');
    const row = await db.pool.query('SELECT email FROM invite');
    expect(row.rows).toEqual([{ email: 'ben@example.com' }]);
    const token = new URL(urlIn(r.out)).searchParams.get('invite')!;
    expect((await previewInvite(db.pool, token, new Date())).email).toBe('ben@example.com');

    api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL) });
    const signup = (email: string) =>
      api!.send('POST', '/auth/signup', {
        body: { invite: token, email, display_name: 'Ben', password: PASSWORD },
      });
    const wrong = await signup('other@example.com');
    expect(wrong.status).toBe(400);
    expect(wrong.json.error?.message).toBe(WRONG_EMAIL_MESSAGE);
    expect((await signup('ben@example.com')).status).toBe(201);
  });

  it('--email=<addr> works too; a missing or invalid email is a usage error with no invite', async () => {
    expect((await run(['bootstrap', '--email'])).code).toBe(2);
    expect((await run(['bootstrap', '--email='])).code).toBe(2);
    const bad = await run(['bootstrap', '--email', 'not-an-email']);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/invalid email/);
    expect((await run(['bootstrap', '--email', 'a@example.com', 'extra'])).code).toBe(2);
    expect(await db.pool.query('SELECT 1 FROM invite')).toHaveProperty('rowCount', 0);
    expect((await run(['bootstrap', '--email=ben@example.com'])).code).toBe(0);
    const row = await db.pool.query('SELECT email FROM invite');
    expect(row.rows).toEqual([{ email: 'ben@example.com' }]);
  });

  it('needs CONDUCTOR_PUBLIC_URL', async () => {
    const r = await run(['bootstrap'], null);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/CONDUCTOR_PUBLIC_URL/);
    expect(await db.pool.query('SELECT 1 FROM invite')).toHaveProperty('rowCount', 0);
  });
});

describe('reset-link', () => {
  it('prints a link that works once and revokes existing sessions', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL) });
    const login = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const r = await run(['reset-link', u.email.toUpperCase()]);
    expect(r.code).toBe(0);
    const url = new URL(urlIn(r.out));
    expect(url.pathname).toBe('/reset');
    const body = { token: url.searchParams.get('token')!, password: 'a brand new passphrase' };
    expect((await api.send('POST', '/auth/reset', { body })).status).toBe(200);
    expect((await api.send('POST', '/auth/reset', { body })).status).toBe(400);
    expect((await api.send('GET', '/api/me', { headers: { cookie } })).status).toBe(401);
  });

  it('an unknown email → exit 1', async () => {
    const r = await run(['reset-link', 'nobody@example.com']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });
});

describe('unlock, revoke-sessions, disable, list-users', () => {
  it('unlock clears a lock (user or not)', async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) await recordFailure(db.pool, 'locked@example.com', now);
    expect(await isLocked(db.pool, 'locked@example.com', now)).toBe(true);
    const r = await run(['unlock', ' Locked@Example.com ']);
    expect(r.code).toBe(0);
    expect(await isLocked(db.pool, 'locked@example.com', now)).toBe(false);
  });

  const sessionsOf = async (userId: string) =>
    (await db.pool.query('SELECT 1 FROM web_session WHERE user_id = $1', [userId])).rowCount;

  const twoSessions = async (u: { userId: string; accountId: string }) => {
    for (let i = 0; i < 2; i++) {
      await createSession(db.pool, {
        userId: u.userId,
        accountId: u.accountId,
        userAgent: null,
        ip: null,
        now: new Date(),
      });
    }
  };

  it('revoke-sessions deletes every session of the user, only theirs', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    const other = await createUser(db.pool, { password: PASSWORD });
    await twoSessions(u);
    await twoSessions(other);
    const r = await run(['revoke-sessions', u.email]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('revoked 2 session(s)');
    expect(await sessionsOf(u.userId)).toBe(0);
    expect(await sessionsOf(other.userId)).toBe(2);
  });

  it('disable sets disabled_at, revokes sessions and the machines of the accounts they own', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    const other = await createUser(db.pool, { password: PASSWORD });
    await twoSessions(u);
    const machine = async (accountId: string) => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO machine (id, account_id, name, hostname, os, arch, daemon_version, status,
                              cpu_total, mem_total_mb, disk_free_mb, budget_cpu, budget_mem_mb,
                              max_sessions, max_concurrent_builds)
         VALUES ($1, $2, 'm', 'm', 'darwin', 'arm64', '0', 'offline', 0, 0, 0, 0, 0, 0, 0)`,
        [id, accountId],
      );
      await db.pool.query(
        'INSERT INTO machine_credential (machine_id, account_id, secret_hash) VALUES ($1, $2, $3)',
        [id, accountId, hashToken(randomBytes(32).toString('base64url'))],
      );
      return id;
    };
    const mine = await machine(u.accountId);
    const theirs = await machine(other.accountId);
    const r = await run(['disable', u.email]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('revoked 2 session(s) and 1 machine(s)');
    const user = await db.pool.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM app_user WHERE id = $1',
      [u.userId],
    );
    expect(user.rows[0]!.disabled_at).not.toBeNull();
    expect(await sessionsOf(u.userId)).toBe(0);
    const revoked = async (id: string) =>
      (
        await db.pool.query<{ m: boolean; c: boolean }>(
          'SELECT m.revoked_at IS NOT NULL AS m, c.revoked_at IS NOT NULL AS c ' +
            'FROM machine m JOIN machine_credential c ON c.machine_id = m.id WHERE m.id = $1',
          [id],
        )
      ).rows[0];
    expect(await revoked(mine)).toEqual({ m: true, c: true });
    expect(await revoked(theirs)).toEqual({ m: false, c: false });
  });

  it('list-users lists users with plain facts', async () => {
    expect((await run(['list-users'])).out).toMatch(/no users/);
    const u = await createUser(db.pool, { password: PASSWORD, admin: true });
    const r = await run(['list-users']);
    expect(r.code).toBe(0);
    const line = r.out.split('\n').find((l) => l.startsWith(u.email))!;
    expect(line.split('\t').slice(2, 5)).toEqual(['yes', 'no', 'no']);
  });

  it('usage errors and unknown commands → exit 2', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['frobnicate'])).code).toBe(2);
    expect((await run(['unlock'])).code).toBe(2);
    expect((await run(['bootstrap', 'extra'])).code).toBe(2);
    expect((await run(['help'])).code).toBe(0);
  });
});
