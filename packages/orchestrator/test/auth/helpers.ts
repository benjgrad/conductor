// M2-T08: helpers for the auth tests. A real createApi on a real listener, driven with node:http
// so Host, Origin, Cookie and X-Forwarded-For can be set exactly.
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApi, type ApiOptions } from '../../src/api/index.js';
import { parseServerConfig, type AuthConfig } from '../../src/auth/config.js';
import { argon2Hasher, type PasswordHasher } from '../../src/auth/password.js';
import {
  FakeEngineService,
  InMemoryBoardBus,
  InMemoryOutputBus,
  type EngineService,
} from '../../src/contracts.js';
import type { ApiHandle } from '../../src/main.js';

export const HTTPS_URL = 'https://conductor.test';
export const LOOPBACK_URL = 'http://127.0.0.1:7400';

export const passwordAuth = (url: string): AuthConfig =>
  parseServerConfig({ CONDUCTOR_AUTH: 'password', CONDUCTOR_PUBLIC_URL: url }).auth;

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: { error?: { code: string; message: string; details?: { path: string }[] } } & Record<
    string,
    unknown
  >;
}

export interface TestApi {
  api: ApiHandle;
  port: number;
  /** Request with the public URL's Host and Origin (overridable), JSON body when given. */
  send: (
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown },
  ) => Promise<Res>;
  close: () => Promise<void>;
}

/** A mutable clock: `clock.now()` for the API, `clock.advance(ms)` in the test. */
export function fakeClock(start = new Date('2026-10-27T12:00:00Z')) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

export async function startApi(opts: {
  db: pg.Pool;
  auth: AuthConfig;
  trustedProxy?: string | null;
  now?: () => Date;
  hasher?: PasswordHasher;
  /** Default: a fresh FakeEngineService. */
  engine?: EngineService;
  /** Any other createApi option (M2-T17: sockets, installUrl, servedVersion). */
  api?: Partial<ApiOptions>;
}): Promise<TestApi> {
  const api = createApi({
    db: opts.db,
    engine: opts.engine ?? new FakeEngineService(),
    boardBus: new InMemoryBoardBus(),
    outputBus: new InMemoryOutputBus(),
    auth: opts.auth,
    security: {},
    ...(opts.trustedProxy !== undefined ? { trustedProxy: opts.trustedProxy } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.hasher ? { hasher: opts.hasher } : {}),
    ...opts.api,
  });
  await api.listen(0, '127.0.0.1');
  const port = (api.server.address() as AddressInfo).port;
  const base =
    opts.auth.mode === 'password'
      ? { host: opts.auth.publicHost, origin: opts.auth.publicOrigin }
      : { host: `127.0.0.1:${port}` };
  const send: TestApi['send'] = (method, path, o = {}) =>
    new Promise((resolve, reject) => {
      const body = o.body === undefined ? undefined : JSON.stringify(o.body);
      const headers: Record<string, string> = {
        ...base,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      };
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => {
          let json: Res['json'] = {};
          try {
            json = text ? (JSON.parse(text) as Res['json']) : {};
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  return { api, port, send, close: () => api.close() };
}

/** `name=value` from a response's Set-Cookie (first cookie). */
export function cookieOf(res: Res): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined) throw new Error('no Set-Cookie');
  return first.split(';')[0]!;
}

export const setCookieHeader = (res: Res): string => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
};

let userSeq = 0;

/** A user with a personal account it owns. Returns ids. */
export async function createUser(
  db: pg.Pool,
  opts: {
    email?: string;
    password: string;
    disabled?: boolean;
    admin?: boolean;
    passwordHash?: string;
  },
): Promise<{ userId: string; accountId: string; email: string }> {
  userSeq += 1;
  const email = opts.email ?? `user${userSeq}-${Date.now()}@example.test`;
  const hash = opts.passwordHash ?? (await argon2Hasher.hash(opts.password));
  const acct = await db.query<{ id: string }>(
    'INSERT INTO account (name) VALUES ($1) RETURNING id',
    [`acct ${email}`],
  );
  const accountId = acct.rows[0]!.id;
  const user = await db.query<{ id: string }>(
    'INSERT INTO app_user (email, display_name, password_hash, is_admin, disabled_at) ' +
      'VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [email, `User ${userSeq}`, hash, opts.admin ?? false, opts.disabled ? new Date() : null],
  );
  const userId = user.rows[0]!.id;
  await db.query(
    "INSERT INTO account_member (account_id, user_id, role) VALUES ($1, $2, 'owner')",
    [accountId, userId],
  );
  return { userId, accountId, email };
}
