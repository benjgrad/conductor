// M2-T08: login throttling (ADR-0017 §Rate limiting and lockout): the per-email lock in
// `login_throttle` and the per-IP limit (`@fastify/rate-limit`, X-Forwarded-For only from
// CONDUCTOR_TRUSTED_PROXY).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { argon2Hasher } from '../../src/auth/password.js';
import {
  LOCK_BASE_MS,
  LOCK_MAX_MS,
  isLocked,
  recordFailure,
  recordSuccess,
} from '../../src/auth/throttle.js';
import { useTestDatabase } from '../db.js';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  fakeClock,
  passwordAuth,
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

let ipSeq = 0;
/** A fresh client address per request, believed because the peer is the trusted proxy. */
const fromNewIp = () => ({ 'x-forwarded-for': `203.0.113.${(ipSeq++ % 250) + 1}` });

const throttleRow = async (email: string) =>
  (
    await db.pool.query<{ failures: number; lockouts: number; locked_until: Date | null }>(
      'SELECT failures, lockouts, locked_until FROM login_throttle WHERE email_norm = $1',
      [email],
    )
  ).rows[0];

describe('per-email lockout', () => {
  it('the 10th failure locks; the right password is then refused until the lock ends', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    const clock = fakeClock();
    api = await startApi({
      db: db.pool,
      auth: passwordAuth(HTTPS_URL),
      trustedProxy: '127.0.0.1',
      now: clock.now,
    });
    const login = (password: string) =>
      api!.send('POST', '/auth/login', {
        headers: fromNewIp(),
        body: { email: u.email, password },
      });

    let wrongText = '';
    for (let i = 1; i <= 10; i++) {
      const r = await login('a wrong password!!');
      expect(r.status, `failure ${i}`).toBe(401);
      wrongText = r.text;
      if (i === 9) expect(await isLocked(db.pool, u.email, clock.now())).toBe(false);
    }
    expect(await isLocked(db.pool, u.email, clock.now())).toBe(true);
    // the 11th, with the right password: the same 401, no cookie
    const refused = await login(PASSWORD);
    expect(refused.status).toBe(401);
    expect(refused.text).toBe(wrongText);
    expect(refused.headers['set-cookie']).toBeUndefined();
    clock.advance(LOCK_BASE_MS - 1000);
    expect((await login(PASSWORD)).status).toBe(401);

    // after the lock, the right password works and resets the count
    clock.advance(2000);
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(200);
    expect(await throttleRow(u.email)).toBeUndefined();
    // a fresh count: 9 failures don't lock
    for (let i = 0; i < 9; i++) await login('a wrong password!!');
    expect(await isLocked(db.pool, u.email, clock.now())).toBe(false);
    // About 22 password checks (scrypt): past the 5 s default under a loaded full run.
  }, 20_000);

  it('an unknown email locks the same way', async () => {
    const clock = fakeClock();
    api = await startApi({
      db: db.pool,
      auth: passwordAuth(HTTPS_URL),
      trustedProxy: '127.0.0.1',
      now: clock.now,
    });
    const email = 'nobody-here@example.test';
    for (let i = 0; i < 10; i++) {
      const r = await api.send('POST', '/auth/login', {
        headers: fromNewIp(),
        body: { email, password: PASSWORD },
      });
      expect(r.status).toBe(401);
    }
    const row = await throttleRow(email);
    expect(row?.locked_until?.getTime()).toBe(clock.now().getTime() + LOCK_BASE_MS);
    expect(await isLocked(db.pool, email, clock.now())).toBe(true);
  });

  it('each further lockout doubles, capped at 24 h; success resets', async () => {
    const email = 'doubling@example.test';
    let t = new Date('2026-10-27T00:00:00Z');
    const lockFor = async () => {
      for (let i = 0; i < 10; i++) await recordFailure(db.pool, email, t);
      const row = await throttleRow(email);
      const ms = row!.locked_until!.getTime() - t.getTime();
      t = new Date(row!.locked_until!.getTime() + 1);
      return ms;
    };
    expect(await lockFor()).toBe(LOCK_BASE_MS);
    expect(await lockFor()).toBe(2 * LOCK_BASE_MS);
    expect(await lockFor()).toBe(4 * LOCK_BASE_MS);
    for (let i = 0; i < 4; i++) await lockFor();
    expect(await lockFor()).toBe(LOCK_MAX_MS);
    await recordSuccess(db.pool, email);
    expect(await lockFor()).toBe(LOCK_BASE_MS);
  });
});

describe('POST /auth/password lockout (M2-T08b)', () => {
  const NEW = 'a brand new passphrase';
  const WRONG = 'a wrong password!!';

  /** A signed-in user on an API with a fake clock; every request from a fresh forwarded IP. */
  const setup = async (hasher?: typeof argon2Hasher) => {
    const u = await createUser(db.pool, { password: PASSWORD });
    const clock = fakeClock();
    api = await startApi({
      db: db.pool,
      auth: passwordAuth(HTTPS_URL),
      trustedProxy: '127.0.0.1',
      now: clock.now,
      ...(hasher ? { hasher } : {}),
    });
    const login = (password: string) =>
      api!.send('POST', '/auth/login', {
        headers: fromNewIp(),
        body: { email: u.email, password },
      });
    const signedIn = await login(PASSWORD);
    expect(signedIn.status).toBe(200);
    const cookie = cookieOf(signedIn);
    const change = (current: string, next = NEW) =>
      api!.send('POST', '/auth/password', {
        headers: { ...fromNewIp(), cookie },
        body: { current, new: next },
      });
    const storedHash = async () =>
      (
        await db.pool.query<{ password_hash: string }>(
          'SELECT password_hash FROM app_user WHERE id = $1',
          [u.userId],
        )
      ).rows[0]!.password_hash;
    return { u, clock, login, change, storedHash };
  };

  it('10 wrong `current` lock the email; the right one is then refused with the same 400', async () => {
    const { u, clock, change, storedHash } = await setup();
    let wrongText = '';
    for (let i = 1; i <= 10; i++) {
      const r = await change(WRONG);
      expect(r.status, `failure ${i}`).toBe(400);
      expect(r.json.error?.details?.map((d) => d.path)).toEqual(['current']);
      wrongText = r.text;
      if (i === 9) expect(await isLocked(db.pool, u.email, clock.now())).toBe(false);
    }
    expect(await isLocked(db.pool, u.email, clock.now())).toBe(true);
    const refused = await change(PASSWORD);
    expect(refused.status).toBe(400);
    expect(refused.text).toBe(wrongText);
    expect(await argon2Hasher.verify(await storedHash(), PASSWORD)).toBe(true);
  });

  it('the lock is shared with login, and both work again once it ends', async () => {
    const { u, clock, login, change } = await setup();
    for (let i = 0; i < 10; i++) expect((await change(WRONG)).status).toBe(400);
    const refused = await login(PASSWORD);
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.text)).toEqual({
      error: { code: 'unauthorized', message: 'Email or password is wrong' },
    });
    expect(refused.headers['set-cookie']).toBeUndefined();

    clock.advance(LOCK_BASE_MS + 1000);
    expect((await change(PASSWORD)).status).toBe(200);
    expect((await login(NEW)).status).toBe(200);
    expect(await throttleRow(u.email)).toBeUndefined();
  });

  it('login and change-password failures add up in one counter', async () => {
    const { u, clock, login, change } = await setup();
    for (let i = 0; i < 5; i++) expect((await login(WRONG)).status).toBe(401);
    for (let i = 0; i < 4; i++) expect((await change(WRONG)).status).toBe(400);
    expect(await isLocked(db.pool, u.email, clock.now())).toBe(false);
    expect((await change(WRONG)).status).toBe(400);
    expect(await isLocked(db.pool, u.email, clock.now())).toBe(true);
    expect((await login(PASSWORD)).status).toBe(401);
  });

  it('the lock applies to a stored email with a different case', async () => {
    const email = `Mixed.Case-${Date.now()}@Example.Test`;
    const u = await createUser(db.pool, { email, password: PASSWORD });
    const clock = fakeClock();
    api = await startApi({
      db: db.pool,
      auth: passwordAuth(HTTPS_URL),
      trustedProxy: '127.0.0.1',
      now: clock.now,
    });
    const signedIn = await api.send('POST', '/auth/login', {
      headers: fromNewIp(),
      body: { email: u.email, password: PASSWORD },
    });
    const cookie = cookieOf(signedIn);
    for (let i = 0; i < 10; i++) {
      await api.send('POST', '/auth/password', {
        headers: { ...fromNewIp(), cookie },
        body: { current: WRONG, new: NEW },
      });
    }
    expect(await isLocked(db.pool, email.toLowerCase(), clock.now())).toBe(true);
    const r = await api.send('POST', '/auth/login', {
      headers: fromNewIp(),
      body: { email, password: PASSWORD },
    });
    expect(r.status).toBe(401);
  });

  it('a successful change resets the count', async () => {
    const { u, clock, change } = await setup();
    for (let i = 0; i < 9; i++) expect((await change(WRONG)).status).toBe(400);
    expect((await throttleRow(u.email))?.failures).toBe(9);
    expect((await change(PASSWORD)).status).toBe(200);
    expect(await throttleRow(u.email)).toBeUndefined();
    for (let i = 0; i < 9; i++) expect((await change(WRONG, PASSWORD)).status).toBe(400);
    expect(await isLocked(db.pool, u.email, clock.now())).toBe(false);
  });

  it('a weak new password does not reset the count', async () => {
    const { u, change } = await setup();
    for (let i = 0; i < 3; i++) await change(WRONG);
    const weak = await change(PASSWORD, 'short');
    expect(weak.json.error?.details?.map((d) => d.path)).toEqual(['password']);
    expect((await throttleRow(u.email))?.failures).toBe(3);
  });

  it('exactly one verify per request, locked or not', async () => {
    const verify = vi.fn(argon2Hasher.verify);
    const { u, clock, change, storedHash } = await setup({ ...argon2Hasher, verify });
    const hash = await storedHash();
    verify.mockClear();

    const unlocked = await change(WRONG);
    expect(unlocked.status).toBe(400);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(hash, WRONG);

    for (let i = 0; i < 10; i++) await recordFailure(db.pool, u.email, clock.now());
    verify.mockClear();
    const lockedWrong = await change(WRONG);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockClear();
    const lockedRight = await change(PASSWORD);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(lockedRight.status).toBe(400);
    expect(lockedRight.text).toBe(lockedWrong.text);
    expect(lockedWrong.text).toBe(unlocked.text);

    clock.advance(LOCK_BASE_MS + 1000);
    verify.mockClear();
    expect((await change(PASSWORD)).status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('per-IP limit', () => {
  const tooMany = async (send: TestApi['send'], headers: () => Record<string, string>) => {
    const statuses: number[] = [];
    let last = null as Awaited<ReturnType<TestApi['send']>> | null;
    for (let i = 0; i < 11; i++) {
      last = await send('POST', '/auth/login', {
        headers: headers(),
        body: { email: `ip-test-${i}@example.test`, password: PASSWORD },
      });
      statuses.push(last.status);
    }
    return { statuses, last: last! };
  };

  it('the 11th login in a minute from one IP gets 429 rate_limited with Retry-After', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const { statuses, last } = await tooMany(api.send, () => ({}));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(last.json.error?.code).toBe('rate_limited');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('the 11th POST /auth/password in a minute from one IP gets 429 with Retry-After', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL), trustedProxy: '127.0.0.1' });
    const signedIn = await api.send('POST', '/auth/login', {
      headers: fromNewIp(),
      body: { email: u.email, password: PASSWORD },
    });
    const cookie = cookieOf(signedIn);
    const statuses: number[] = [];
    let last = null as Awaited<ReturnType<TestApi['send']>> | null;
    for (let i = 0; i < 11; i++) {
      last = await api.send('POST', '/auth/password', {
        headers: { 'x-forwarded-for': '198.51.100.99', cookie },
        body: { current: 'a wrong password!!', new: 'a brand new passphrase' },
      });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(last!.json.error?.code).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('X-Forwarded-For is ignored unless the peer is CONDUCTOR_TRUSTED_PROXY', async () => {
    api = await startApi({
      db: db.pool,
      auth: passwordAuth(HTTPS_URL),
      trustedProxy: '10.255.0.1',
    });
    const untrusted = await tooMany(api.send, fromNewIp);
    expect(untrusted.statuses[10]).toBe(429);
    await api.close();

    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL), trustedProxy: '127.0.0.1' });
    const trusted = await tooMany(api.send, fromNewIp);
    expect(trusted.statuses.every((s) => s === 401)).toBe(true);
  });

  it('the session records the forwarded client IP only from the trusted proxy', async () => {
    const u = await createUser(db.pool, { password: PASSWORD });
    const ipOf = async (trustedProxy: string) => {
      api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL), trustedProxy });
      const r = await api.send('POST', '/auth/login', {
        headers: { 'x-forwarded-for': '198.51.100.7' },
        body: { email: u.email, password: PASSWORD },
      });
      expect(r.status).toBe(200);
      await api.close();
      api = null;
      const row = await db.pool.query<{ ip: string }>(
        'SELECT ip FROM web_session WHERE user_id = $1 ORDER BY created_at DESC, ip LIMIT 1',
        [u.userId],
      );
      await db.pool.query('DELETE FROM web_session WHERE user_id = $1', [u.userId]);
      return row.rows[0]!.ip;
    };
    expect(await ipOf('127.0.0.1')).toBe('198.51.100.7');
    expect(await ipOf('10.255.0.1')).toBe('127.0.0.1');
  });
});
