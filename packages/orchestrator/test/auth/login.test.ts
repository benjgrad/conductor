// M2-T08: POST /auth/login and GET /api/me (ADR-0017 §Auth: behaviour, 10-contracts §Accounts
// and web auth).
import { MeResponseSchema, localMeResponse } from '@conductor/shared';
import { hash } from '@node-rs/argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTH } from '../../src/auth/config.js';
import { DUMMY_HASH, argon2Hasher, needsRehash } from '../../src/auth/password.js';
import { useTestDatabase } from '../db.js';
import {
  HTTPS_URL,
  LOOPBACK_URL,
  cookieOf,
  createUser,
  passwordAuth,
  setCookieHeader,
  startApi,
  type TestApi,
} from './helpers.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

describe('POST /auth/login', () => {
  it('https public URL: __Host-conductor_session; HttpOnly; Secure; SameSite=Lax; Path=/', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(/^__Host-conductor_session=[A-Za-z0-9_-]{43}; /);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      expect(cookie.split('; ')).toContain(flag);
    }
    const me = MeResponseSchema.parse(res.json);
    expect(me).toMatchObject({
      user: { id: u.userId, email: u.email, is_admin: false },
      account: { id: u.accountId },
      auth_mode: 'password',
    });
    // the cookie is a session: GET /api/me answers with it, 401 without
    const withCookie = await api.send('GET', '/api/me', { headers: { cookie: cookieOf(res) } });
    expect(withCookie.status).toBe(200);
    expect(withCookie.json).toEqual(me);
    const without = await api.send('GET', '/api/me');
    expect(without.status).toBe(401);
    expect(without.json.error?.code).toBe('unauthorized');
  });

  it('loopback http public URL: conductor_session without Secure', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL) });
    const res = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(/^conductor_session=[A-Za-z0-9_-]{43}; /);
    expect(cookie.split('; ')).not.toContain('Secure');
    expect(cookie.split('; ')).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']),
    );
  });

  it('email is trimmed and case-insensitive', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('POST', '/auth/login', {
      body: { email: `  ${u.email.toUpperCase()} `, password: PASSWORD },
    });
    expect(res.status).toBe(200);
  });

  it('wrong password, unknown email and a disabled user: byte-identical 401s', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    const d = await createUser(db.pool, { password: PASSWORD, disabled: true });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const wrong = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: 'not the password at all' },
    });
    const unknown = await api.send('POST', '/auth/login', {
      body: { email: 'nobody@example.test', password: PASSWORD },
    });
    const disabled = await api.send('POST', '/auth/login', {
      body: { email: d.email, password: PASSWORD },
    });
    const malformed = await api.send('POST', '/auth/login', {
      body: { email: 'not-an-email', password: PASSWORD },
    });
    for (const r of [wrong, unknown, disabled, malformed]) {
      expect(r.status).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.headers['content-type']).toBe(wrong.headers['content-type']);
    }
    expect(unknown.text).toBe(wrong.text);
    expect(disabled.text).toBe(wrong.text);
    expect(malformed.text).toBe(wrong.text);
    expect(JSON.parse(wrong.text)).toEqual({
      error: { code: 'unauthorized', message: 'Email or password is wrong' },
    });
  });

  it('the unknown-email path still runs one argon2 verify (against the dummy hash)', async () => {
    const verify = vi.fn(argon2Hasher.verify);
    api = await startApi({
      db: db.pool,
      auth: passwordAuth(HTTPS_URL),
      hasher: { ...argon2Hasher, verify },
    });
    const res = await api.send('POST', '/auth/login', {
      body: { email: 'ghost@example.test', password: PASSWORD },
    });
    expect(res.status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(DUMMY_HASH, PASSWORD);
    expect(needsRehash(DUMMY_HASH)).toBe(false);
  });

  it('re-hashes a hash with weaker parameters on a successful login', async () => {
    const weak = await hash(PASSWORD, {
      algorithm: 2,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    expect(needsRehash(weak)).toBe(true);
    const u = await createUser(db.pool, { password: PASSWORD, passwordHash: weak });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const row = await db.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM app_user WHERE id = $1',
      [u.userId],
    );
    expect(row.rows[0]!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await argon2Hasher.verify(row.rows[0]!.password_hash, PASSWORD)).toBe(true);
  });
});

describe('local mode', () => {
  it('GET /api/me is the local user; there is no sign-in route', async () => {
    api = await startApi({ db: db.pool, auth: DEFAULT_AUTH });
    const me = await api.send('GET', '/api/me');
    expect(me.status).toBe(200);
    expect(me.json).toEqual(localMeResponse());
    const login = await api.send('POST', '/auth/login', {
      body: { email: 'a@b.c', password: PASSWORD },
    });
    expect(login.status).toBe(404);
  });
});
