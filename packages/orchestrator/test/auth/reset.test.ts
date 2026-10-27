// M2-T15a: reset links and POST /auth/reset (ADR-0017 §Invites, sign-up, resets). Needs `pnpm db:up`.
import { createHash } from 'node:crypto';
import { RESET_LINK_TTL_MS } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { INVALID_RESET_MESSAGE, createResetLink } from '../../src/auth/reset.js';
import { useTestDatabase } from '../db.js';
import {
  LOOPBACK_URL,
  cookieOf,
  createUser,
  fakeClock,
  passwordAuth,
  startApi,
  type TestApi,
} from './helpers.js';

const db = useTestDatabase();
const publicUrl = new URL(LOOPBACK_URL);
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase';
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

async function setup() {
  const clock = fakeClock(new Date());
  api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL), now: clock.now });
  const u = await createUser(db.pool, { password: OLD });
  const link = await createResetLink(db.pool, { userId: u.userId, publicUrl, now: clock.now() });
  return { clock, api, u, link, token: tokenOf(link.url) };
}

const login = (a: TestApi, email: string, password: string) =>
  a.send('POST', '/auth/login', { body: { email, password } });

describe('createResetLink', () => {
  it('a one-hour /reset link; only the SHA-256 is stored', async () => {
    const { u, link, token, clock } = await setup();
    expect(link.url).toBe(`${LOOPBACK_URL}/reset?token=${token}`);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(link.expires_at.getTime() - clock.now().getTime()).toBe(RESET_LINK_TTL_MS);
    const row = await db.pool.query<{ token_hash: Buffer; whole: string }>(
      'SELECT token_hash, password_reset::text AS whole FROM password_reset WHERE user_id = $1',
      [u.userId],
    );
    expect(row.rows[0]!.token_hash).toEqual(createHash('sha256').update(token).digest());
    expect(row.rows[0]!.whole).not.toContain(token);
  });
});

describe('POST /auth/reset', () => {
  it('sets the password, revokes every session, and works once', async () => {
    const { api, u, token } = await setup();
    const s1 = cookieOf(await login(api, u.email, OLD));
    const s2 = cookieOf(await login(api, u.email, OLD));
    const res = await api.send('POST', '/auth/reset', { body: { token, password: NEW } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    for (const cookie of [s1, s2]) {
      expect((await api.send('GET', '/api/me', { headers: { cookie } })).status).toBe(401);
    }
    expect((await login(api, u.email, OLD)).status).toBe(401);
    expect((await login(api, u.email, NEW)).status).toBe(200);
    const again = await api.send('POST', '/auth/reset', {
      body: { token, password: 'yet another passphrase' },
    });
    expect(again.status).toBe(400);
    expect(again.json.error?.message).toBe(INVALID_RESET_MESSAGE);
    expect((await login(api, u.email, NEW)).status).toBe(200);
  });

  it('expires after one hour', async () => {
    const { api, clock, token, u } = await setup();
    clock.advance(RESET_LINK_TTL_MS);
    const res = await api.send('POST', '/auth/reset', { body: { token, password: NEW } });
    expect(res.status).toBe(400);
    expect(res.json.error?.message).toBe(INVALID_RESET_MESSAGE);
    expect((await login(api, u.email, OLD)).status).toBe(200);
  });

  it('a weak password → 400 at `password`, and the link still works afterwards', async () => {
    const { api, token, u } = await setup();
    const weak = await api.send('POST', '/auth/reset', { body: { token, password: u.email } });
    expect(weak.status).toBe(400);
    expect(weak.json.error?.details?.map((d) => d.path)).toContain('password');
    expect((await api.send('POST', '/auth/reset', { body: { token, password: NEW } })).status).toBe(
      200,
    );
  });

  it('a reset burns the user’s other open links; unknown and disabled are refused', async () => {
    const { api, clock, u, token } = await setup();
    const other = await createResetLink(db.pool, { userId: u.userId, publicUrl, now: clock.now() });
    expect((await api.send('POST', '/auth/reset', { body: { token, password: NEW } })).status).toBe(
      200,
    );
    const burnt = await api.send('POST', '/auth/reset', {
      body: { token: tokenOf(other.url), password: 'yet another passphrase' },
    });
    expect(burnt.status).toBe(400);
    const d = await createUser(db.pool, { password: OLD, disabled: true });
    const dl = await createResetLink(db.pool, { userId: d.userId, publicUrl, now: clock.now() });
    const disabled = await api.send('POST', '/auth/reset', {
      body: { token: tokenOf(dl.url), password: NEW },
    });
    expect(disabled.status).toBe(400);
    const unknown = await api.send('POST', '/auth/reset', {
      body: { token: 'nope', password: NEW },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error?.message).toBe(INVALID_RESET_MESSAGE);
  });
});
