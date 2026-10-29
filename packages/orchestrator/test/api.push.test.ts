// UX-15: the Web Push routes (10-contracts §Web Push), password mode, against a test database
// with a fake push sender. Needs `pnpm db:up`.
import { API_PATHS } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/sessions.js';
import type { PushSubscriptionRow } from '../src/db/types.js';
import { parsePushConfig, type PushConfig } from '../src/push/config.js';
import type { PushResult, PushSender, PushTarget } from '../src/push/sender.js';
import { generateVapidKeys } from '../src/push/sender.js';
import {
  HTTPS_URL,
  createUser,
  passwordAuth,
  startApi,
  type Res,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const AUTH = passwordAuth(HTTPS_URL);
const COOKIE_NAME = AUTH.mode === 'password' ? AUTH.cookie.name : '';
const keys = generateVapidKeys();
const PUSH: PushConfig = parsePushConfig({
  CONDUCTOR_VAPID_PUBLIC_KEY: keys.publicKey,
  CONDUCTOR_VAPID_PRIVATE_KEY: keys.privateKey,
  CONDUCTOR_VAPID_SUBJECT: 'mailto:ops@example.test',
})!;
// A fixed hash: argon2 is not under test here.
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

class FakeSender implements PushSender {
  calls: { target: PushTarget; payload: unknown }[] = [];
  results = new Map<string, PushResult>();
  send(target: PushTarget, payload: string): Promise<PushResult> {
    this.calls.push({ target, payload: JSON.parse(payload) as unknown });
    return Promise.resolve(this.results.get(target.endpoint) ?? { ok: true });
  }
}

let api: TestApi | null = null;
let bodies: string[] = [];
let sender = new FakeSender();

beforeEach(async () => {
  await db.pool.query('DELETE FROM push_subscription');
});

afterEach(async () => {
  await api?.close();
  api = null;
  bodies = [];
});

async function start(push: PushConfig | null = PUSH): Promise<void> {
  sender = new FakeSender();
  api = await startApi({ db: db.pool, auth: AUTH, api: { push, pushSender: sender } });
}

async function send(
  method: string,
  path: string,
  opts: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  const body = opts.body !== undefined ? opts.body : method !== 'GET' ? {} : undefined;
  const length =
    body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) };
  const res = await api!.send(method, path, {
    headers: { ...length, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(body !== undefined ? { body } : {}),
  });
  bodies.push(res.text);
  return res;
}

async function user(): Promise<{ userId: string; accountId: string; cookie: string }> {
  const u = await createUser(db.pool, { password: '', passwordHash: PASSWORD_HASH });
  const s = await createSession(db.pool, {
    userId: u.userId,
    accountId: u.accountId,
    userAgent: null,
    ip: null,
    now: new Date(),
  });
  return { ...u, cookie: `${COOKIE_NAME}=${s.token}` };
}

let seq = 0;
const endpoint = () => `https://push.example.test/send/${Date.now()}-${++seq}`;
const subBody = (ep: string, p256dh = 'BKey', auth = 'authsecret') => ({
  endpoint: ep,
  keys: { p256dh, auth },
  expirationTime: null,
});
const rows = async () =>
  (await db.pool.query<PushSubscriptionRow>('SELECT * FROM push_subscription ORDER BY created_at'))
    .rows;

describe('Web Push routes (UX-15)', () => {
  it('needs a session: 401 on every route', async () => {
    await start();
    for (const [m, p] of [
      ['GET', API_PATHS.pushVapidPublicKey],
      ['POST', API_PATHS.pushSubscriptions],
      ['DELETE', API_PATHS.pushSubscriptions],
      ['POST', API_PATHS.pushTest],
    ] as const) {
      const res = await send(m, p);
      expect([m, p, res.status, res.json.error?.code]).toEqual([m, p, 401, 'unauthorized']);
    }
  });

  it('refuses a write from a foreign Origin (403, CSRF)', async () => {
    await start();
    const me = await user();
    for (const m of ['POST', 'DELETE']) {
      const res = await send(m, API_PATHS.pushSubscriptions, {
        cookie: me.cookie,
        headers: { origin: 'https://evil.example' },
        body: subBody(endpoint()),
      });
      expect([m, res.status]).toEqual([m, 403]);
    }
    const t = await send('POST', API_PATHS.pushTest, {
      cookie: me.cookie,
      headers: { origin: 'https://evil.example' },
    });
    expect(t.status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it('404 push_disabled on every route without VAPID', async () => {
    await start(null);
    const me = await user();
    for (const [m, p] of [
      ['GET', API_PATHS.pushVapidPublicKey],
      ['POST', API_PATHS.pushSubscriptions],
      ['DELETE', API_PATHS.pushSubscriptions],
      ['POST', API_PATHS.pushTest],
    ] as const) {
      const res = await send(m, p, { cookie: me.cookie, body: subBody(endpoint()) });
      expect([m, p, res.status, res.json.error?.code]).toEqual([m, p, 404, 'push_disabled']);
    }
    expect(await rows()).toEqual([]);
    expect(sender.calls).toEqual([]);
  });

  it('GET vapid-public-key returns the public key only', async () => {
    await start();
    const me = await user();
    const res = await send('GET', API_PATHS.pushVapidPublicKey, { cookie: me.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ public_key: PUSH.publicKey });
  });

  it('POST subscriptions upserts by endpoint (keys replaced, failures reset)', async () => {
    await start();
    const me = await user();
    const ep = endpoint();
    const first = await send('POST', API_PATHS.pushSubscriptions, {
      cookie: me.cookie,
      headers: { 'user-agent': 'Phone/1' },
      body: subBody(ep),
    });
    expect([first.status, first.json]).toEqual([201, { ok: true }]);
    await db.pool.query('UPDATE push_subscription SET failures = 3');
    const again = await send('POST', API_PATHS.pushSubscriptions, {
      cookie: me.cookie,
      body: subBody(ep, 'BNewKey', 'newauth'),
    });
    expect(again.status).toBe(201);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      account_id: me.accountId,
      user_id: me.userId,
      endpoint: ep,
      p256dh: 'BNewKey',
      auth: 'newauth',
      failures: 0,
    });
  });

  it('400 on a non-https endpoint or missing keys', async () => {
    await start();
    const me = await user();
    for (const body of [
      subBody('http://push.example.test/x'),
      { endpoint: endpoint() },
      { endpoint: endpoint(), keys: { p256dh: '', auth: 'a' } },
    ]) {
      const res = await send('POST', API_PATHS.pushSubscriptions, { cookie: me.cookie, body });
      expect(res.status).toBe(400);
    }
    expect(await rows()).toEqual([]);
  });

  it("DELETE removes the caller's subscription, never another user's", async () => {
    await start();
    const me = await user();
    const other = await user();
    const mine = endpoint();
    const theirs = endpoint();
    await send('POST', API_PATHS.pushSubscriptions, { cookie: me.cookie, body: subBody(mine) });
    await send('POST', API_PATHS.pushSubscriptions, {
      cookie: other.cookie,
      body: subBody(theirs),
    });
    const res = await send('DELETE', API_PATHS.pushSubscriptions, {
      cookie: me.cookie,
      body: { endpoint: theirs },
    });
    expect([res.status, res.json]).toEqual([200, { ok: true }]);
    expect((await rows()).map((r) => r.endpoint).sort()).toEqual([mine, theirs].sort());

    const del = await send('DELETE', API_PATHS.pushSubscriptions, {
      cookie: me.cookie,
      body: { endpoint: mine },
    });
    expect(del.status).toBe(200);
    expect((await rows()).map((r) => r.endpoint)).toEqual([theirs]);
    // Idempotent.
    const again = await send('DELETE', API_PATHS.pushSubscriptions, {
      cookie: me.cookie,
      body: { endpoint: mine },
    });
    expect(again.status).toBe(200);
  });

  it("POST test sends 'Notifications are on' to the caller's subscriptions; a 410 deletes one", async () => {
    await start();
    const me = await user();
    const other = await user();
    const a = endpoint();
    const b = endpoint();
    const c = endpoint();
    for (const ep of [a, b]) {
      await send('POST', API_PATHS.pushSubscriptions, { cookie: me.cookie, body: subBody(ep) });
    }
    await send('POST', API_PATHS.pushSubscriptions, { cookie: other.cookie, body: subBody(c) });
    sender.results.set(b, { ok: false, gone: true, status: 410, error: 'http_410' });

    const res = await send('POST', API_PATHS.pushTest, { cookie: me.cookie });
    expect([res.status, res.json]).toEqual([200, { sent: 1 }]);
    expect(sender.calls.map((c2) => c2.target.endpoint).sort()).toEqual([a, b].sort());
    expect(sender.calls[0]!.payload).toEqual({
      title: 'Conductor',
      body: 'Notifications are on',
      url: '/#/',
      tag: 'conductor-test',
    });
    expect((await rows()).map((r) => r.endpoint).sort()).toEqual([a, c].sort());
    const ok = (await rows()).find((r) => r.endpoint === a)!;
    expect(ok.last_ok_at).not.toBeNull();
  });

  it('never sends an endpoint back', async () => {
    await start();
    const me = await user();
    const ep = endpoint();
    await send('POST', API_PATHS.pushSubscriptions, { cookie: me.cookie, body: subBody(ep) });
    await send('GET', API_PATHS.pushVapidPublicKey, { cookie: me.cookie });
    await send('POST', API_PATHS.pushTest, { cookie: me.cookie });
    await send('DELETE', API_PATHS.pushSubscriptions, {
      cookie: me.cookie,
      body: { endpoint: ep },
    });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain('push.example.test');
  });
});
