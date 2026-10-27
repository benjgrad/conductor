// M2-T08: web sessions (ADR-0017 §Session cookie): expiry, logout, password change, hashing.
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAST_SEEN_THROTTLE_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  createSession,
  hashToken,
  lookupSession,
} from '../../src/auth/sessions.js';
import { useTestDatabase } from '../db.js';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  fakeClock,
  passwordAuth,
  setCookieHeader,
  startApi,
  type TestApi,
} from './helpers.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
const DAY = 24 * 3600_000;
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

const session = async (now: Date) => {
  const u = await createUser(db.pool, { password: PASSWORD });
  const s = await createSession(db.pool, {
    userId: u.userId,
    accountId: u.accountId,
    userAgent: 'test',
    ip: '127.0.0.1',
    now,
  });
  return { ...u, ...s };
};

const lastSeen = async (idHash: Buffer) =>
  (
    await db.pool.query<{ last_seen_at: Date }>(
      'SELECT last_seen_at FROM web_session WHERE id_hash = $1',
      [idHash],
    )
  ).rows[0]?.last_seen_at;

describe('lookupSession expiry', () => {
  it('idle for 7 days → gone (and the row deleted)', async () => {
    const clock = fakeClock();
    const s = await session(clock.now());
    clock.advance(SESSION_IDLE_MS - 1);
    expect(await lookupSession(db.pool, s.token, clock.now())).not.toBeNull();
    // that use moved last_seen_at: idle counts from here
    clock.advance(SESSION_IDLE_MS + 1);
    expect(await lookupSession(db.pool, s.token, clock.now())).toBeNull();
    expect(await lastSeen(s.idHash)).toBeUndefined();
  });

  it('used every 6 days, it still ends 30 days after creation', async () => {
    const clock = fakeClock();
    const s = await session(clock.now());
    for (let d = 6; d < 30; d += 6) {
      clock.advance(6 * DAY);
      expect(await lookupSession(db.pool, s.token, clock.now()), `day ${d}`).not.toBeNull();
    }
    clock.advance(SESSION_ABSOLUTE_MS - 24 * DAY);
    expect(await lookupSession(db.pool, s.token, clock.now())).toBeNull();
  });

  it('last_seen_at is written at most every 5 minutes', async () => {
    const clock = fakeClock();
    const s = await session(clock.now());
    const created = clock.now().getTime();
    clock.advance(LAST_SEEN_THROTTLE_MS - 1000);
    expect((await lookupSession(db.pool, s.token, clock.now()))?.user.id).toBe(s.userId);
    expect((await lastSeen(s.idHash))?.getTime()).toBe(created);
    clock.advance(2000);
    await lookupSession(db.pool, s.token, clock.now());
    expect((await lastSeen(s.idHash))?.getTime()).toBe(clock.now().getTime());
  });

  it('a disabled user has no session; a malformed token is null', async () => {
    const clock = fakeClock();
    const s = await session(clock.now());
    await db.pool.query('UPDATE app_user SET disabled_at = now() WHERE id = $1', [s.userId]);
    expect(await lookupSession(db.pool, s.token, clock.now())).toBeNull();
    expect(await lookupSession(db.pool, 'short', clock.now())).toBeNull();
  });

  it('expiry applies through the API too (fake clock): /api/me → 401', async () => {
    const clock = fakeClock();
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL), now: clock.now });
    const login = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    const cookie = cookieOf(login);
    expect((await api.send('GET', '/api/me', { headers: { cookie } })).status).toBe(200);
    clock.advance(SESSION_IDLE_MS + LAST_SEEN_THROTTLE_MS);
    expect((await api.send('GET', '/api/me', { headers: { cookie } })).status).toBe(401);
  });
});

describe('the stored id is a hash', () => {
  it('the cookie value appears nowhere in web_session', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const login = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    const token = cookieOf(login).split('=')[1]!;
    const raw = Buffer.from(token, 'base64url');
    expect(raw.length).toBe(32);
    const rows = await db.pool.query<Record<string, unknown>>(
      'SELECT encode(id_hash, $2) AS id_hex, encode(id_hash, $3) AS id_b64, * ' +
        'FROM web_session WHERE user_id = $1',
      [u.userId, 'hex', 'base64'],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.id_hash).toEqual(hashToken(token));
    const dump = JSON.stringify(row, (_k, v: unknown) =>
      Buffer.isBuffer(v) ? v.toString('hex') : v,
    );
    for (const needle of [token, raw.toString('hex'), raw.toString('base64')]) {
      expect(dump).not.toContain(needle);
    }
  });
});

describe('POST /auth/logout', () => {
  it('deletes the row and clears the cookie', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const login = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    const cookie = cookieOf(login);
    const count = async () =>
      (await db.pool.query('SELECT 1 FROM web_session WHERE user_id = $1', [u.userId])).rowCount;
    expect(await count()).toBe(1);
    const out = await api.send('POST', '/auth/logout', { headers: { cookie }, body: {} });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true });
    expect(setCookieHeader(out)).toMatch(
      /^__Host-conductor_session=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0$/,
    );
    expect(await count()).toBe(0);
    expect((await api.send('GET', '/api/me', { headers: { cookie } })).status).toBe(401);
    // without a session it still answers 200 and clears the cookie
    const again = await api.send('POST', '/auth/logout', { body: {} });
    expect(again.status).toBe(200);
    expect(setCookieHeader(again)).toContain('Max-Age=0');
  });
});

describe('POST /auth/password', () => {
  it('revokes the other sessions, not the current one', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const login = () =>
      api!.send('POST', '/auth/login', { body: { email: u.email, password: PASSWORD } });
    const a = cookieOf(await login());
    const b = cookieOf(await login());
    const NEW = 'a brand new passphrase';
    const res = await api.send('POST', '/auth/password', {
      headers: { cookie: a },
      body: { current: PASSWORD, new: NEW },
    });
    expect(res.status).toBe(200);
    expect((await api.send('GET', '/api/me', { headers: { cookie: a } })).status).toBe(200);
    expect((await api.send('GET', '/api/me', { headers: { cookie: b } })).status).toBe(401);
    const rows = await db.pool.query('SELECT 1 FROM web_session WHERE user_id = $1', [u.userId]);
    expect(rows.rowCount).toBe(1);
    // the new password signs in, the old one doesn't
    expect(
      (await api.send('POST', '/auth/login', { body: { email: u.email, password: NEW } })).status,
    ).toBe(200);
    expect((await login()).status).toBe(401);
  });

  it('wrong current → 400 at path current; a weak new one → 400 at path password; no session → 401', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const login = await api.send('POST', '/auth/login', {
      body: { email: u.email, password: PASSWORD },
    });
    const cookie = cookieOf(login);
    const wrong = await api.send('POST', '/auth/password', {
      headers: { cookie },
      body: { current: 'not my password', new: 'a brand new passphrase' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error?.code).toBe('bad_request');
    expect(wrong.json.error?.details?.map((d) => d.path)).toEqual(['current']);
    const weak = await api.send('POST', '/auth/password', {
      headers: { cookie },
      body: { current: PASSWORD, new: 'short' },
    });
    expect(weak.status).toBe(400);
    expect(weak.json.error?.details?.map((d) => d.path)).toEqual(['password']);
    const gone = await api.send('POST', '/auth/password', {
      body: { current: PASSWORD, new: 'a brand new passphrase' },
    });
    expect(gone.status).toBe(401);
    expect(gone.json.error?.code).toBe('unauthorized');
    // nothing changed
    expect((await api.send('GET', '/api/me', { headers: { cookie } })).status).toBe(200);
  });
});
