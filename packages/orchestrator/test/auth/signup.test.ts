// M2-T15a: POST /auth/signup (ADR-0017 §Invites; bootstrap claims `local`). Needs `pnpm db:up`.
import { LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInvite } from '../../src/auth/invites.js';
import { newSessionToken } from '../../src/auth/sessions.js';
import {
  INVALID_INVITE_MESSAGE,
  NOT_SUPPORTED_YET_MESSAGE,
  WRONG_EMAIL_MESSAGE,
} from '../../src/auth/signup.js';
import { useTestDatabase } from '../db.js';
import { LOOPBACK_URL, cookieOf, passwordAuth, startApi, type TestApi } from './helpers.js';

const db = useTestDatabase();
const publicUrl = new URL(LOOPBACK_URL);
const PASSWORD = 'correct horse battery staple';
// Sign-up allows 5 requests per 10 minutes per IP: each test gets its own API (own limiter).
let api: TestApi;

beforeEach(async () => {
  // Every test starts from a fresh instance with no users and `local` unowned.
  await db.pool.query('DELETE FROM web_session');
  await db.pool.query('DELETE FROM invite');
  await db.pool.query('DELETE FROM account_member');
  await db.pool.query('DELETE FROM app_user');
  await db.pool.query("UPDATE account SET name = 'local' WHERE id = $1", [LOCAL_ACCOUNT_ID]);
  api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL) });
});

afterEach(async () => {
  await api.close();
});

const bootstrapInvite = (opts: { email?: string; ttlMs?: number; now?: Date } = {}) =>
  createInvite(db.pool, {
    publicUrl,
    now: opts.now ?? new Date(),
    ttlMs: opts.ttlMs ?? 3600_000,
    isAdmin: true,
    claimsAccount: LOCAL_ACCOUNT_ID,
    ...(opts.email ? { email: opts.email } : {}),
  });

const signup = (invite: string, email = 'ben@example.com', display_name = 'Ben') =>
  api.send('POST', '/auth/signup', { body: { invite, email, display_name, password: PASSWORD } });

const userCount = async () =>
  Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM app_user')).rows[0]!.n);
const usedAt = async (id: string) =>
  (await db.pool.query<{ used_at: Date | null }>('SELECT used_at FROM invite WHERE id = $1', [id]))
    .rows[0]!.used_at;

describe('POST /auth/signup with the bootstrap invite', () => {
  it('makes the user an admin and the owner of `local`, renamed, and signs them in', async () => {
    const inv = await bootstrapInvite();
    const res = await signup(inv.token, ' Ben@Example.com ', 'Ben Grady');
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      user: { email: 'ben@example.com', display_name: 'Ben Grady', is_admin: true },
      account: { id: LOCAL_ACCOUNT_ID, name: 'Ben Grady' },
      auth_mode: 'password',
    });
    const user = await db.pool.query<{ id: string; is_admin: boolean; password_hash: string }>(
      'SELECT id, is_admin, password_hash FROM app_user',
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0]!.is_admin).toBe(true);
    expect(user.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    const member = await db.pool.query('SELECT role FROM account_member WHERE account_id = $1', [
      LOCAL_ACCOUNT_ID,
    ]);
    expect(member.rows).toEqual([{ role: 'owner' }]);
    const acct = await db.pool.query('SELECT name FROM account WHERE id = $1', [LOCAL_ACCOUNT_ID]);
    expect(acct.rows[0]).toEqual({ name: 'Ben Grady' });
    expect(await usedAt(inv.id)).not.toBeNull();
    const me = await api.send('GET', '/api/me', { headers: { cookie: cookieOf(res) } });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({
      user: { id: user.rows[0]!.id },
      account: { id: LOCAL_ACCOUNT_ID },
    });
  });

  it('two concurrent sign-ups with one invite → exactly one user', async () => {
    const inv = await bootstrapInvite();
    const results = await Promise.all([
      signup(inv.token, 'a@example.com'),
      signup(inv.token, 'b@example.com'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await userCount()).toBe(1);
  });

  it('a second claims invite after `local` is owned is refused', async () => {
    const first = await bootstrapInvite();
    const second = await bootstrapInvite();
    expect((await signup(first.token)).status).toBe(201);
    const res = await signup(second.token, 'other@example.com');
    expect(res.status).toBe(400);
    expect(res.json.error?.message).toBe(INVALID_INVITE_MESSAGE);
    expect(await userCount()).toBe(1);
  });
});

describe('POST /auth/signup refusals create no user', () => {
  it('no such invite, a malformed token, used, expired, revoked', async () => {
    const used = await bootstrapInvite();
    await db.pool.query('UPDATE invite SET used_at = now() WHERE id = $1', [used.id]);
    const expired = await bootstrapInvite({ now: new Date(Date.now() - 2 * 3600_000) });
    const revoked = await bootstrapInvite();
    await db.pool.query('UPDATE invite SET revoked_at = now() WHERE id = $1', [revoked.id]);
    // 4 calls: under the per-IP limit of 5.
    for (const token of [newSessionToken(), used.token, expired.token, revoked.token]) {
      const res = await signup(token);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatchObject({
        code: 'bad_request',
        message: INVALID_INVITE_MESSAGE,
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(await userCount()).toBe(0);
    expect(await usedAt(revoked.id)).toBeNull();
  });

  it('the wrong email for a pinned invite', async () => {
    const inv = await bootstrapInvite({ email: 'ben@example.com' });
    const res = await signup(inv.token, 'mallory@example.com');
    expect(res.status).toBe(400);
    expect(res.json.error?.message).toBe(WRONG_EMAIL_MESSAGE);
    expect(res.json.error?.details?.[0]?.path).toBe('email');
    expect(await userCount()).toBe(0);
    expect(await usedAt(inv.id)).toBeNull();
    expect((await signup(inv.token, 'BEN@example.com')).status).toBe(201);
  });

  it('an invite without claims_account → 400 not_supported_yet (M2-T15b)', async () => {
    const inv = await createInvite(db.pool, { publicUrl, now: new Date() });
    const res = await signup(inv.token);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({
      code: 'bad_request',
      message: NOT_SUPPORTED_YET_MESSAGE,
      details: [{ path: 'invite', message: 'not_supported_yet' }],
    });
    expect(await userCount()).toBe(0);
    expect(await usedAt(inv.id)).toBeNull();
  });

  it('a weak password → 400 at path `password`, the invite unused', async () => {
    const inv = await bootstrapInvite();
    const res = await api.send('POST', '/auth/signup', {
      body: { invite: inv.token, email: 'ben@example.com', display_name: 'Ben', password: 'short' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.details?.map((d) => d.path)).toContain('password');
    expect(await userCount()).toBe(0);
    expect(await usedAt(inv.id)).toBeNull();
  });

  it('the sign-up route is rate-limited per IP (the 6th in 10 minutes → 429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await signup(newSessionToken())).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });
});
