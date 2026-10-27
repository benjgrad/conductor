// M2-T15b1: the /api/admin/* routes (ADR-0017 §Invites, sign-up, resets, the admin; 10-contracts
// §Accounts and web auth), on a real createApi in password mode. Needs `pnpm db:up`.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  API_PATHS,
  AdminUserListResponseSchema,
  InviteCreatedSchema,
  InviteListResponseSchema,
  LOCAL_ACCOUNT_ID,
  ResetLinkCreatedSchema,
} from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTH } from '../../src/auth/config.js';
import { previewInvite } from '../../src/auth/invites.js';
import { createSession, hashToken } from '../../src/auth/sessions.js';
import { NOT_SUPPORTED_YET_MESSAGE } from '../../src/auth/signup.js';
import { isLocked, recordFailure } from '../../src/auth/throttle.js';
import type { MachineSockets } from '../../src/gateway/revoke.js';
import { useTestDatabase } from '../db.js';
import {
  HTTPS_URL,
  createUser,
  passwordAuth,
  startApi,
  type Res,
  type TestApi,
} from './helpers.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
const AUTH = passwordAuth(HTTPS_URL);
const COOKIE_NAME = AUTH.mode === 'password' ? AUTH.cookie.name : '';

let api: TestApi | null = null;
let bodies: string[] = [];
let disconnect: ReturnType<typeof vi.fn<MachineSockets['disconnectMachine']>>;

async function start(): Promise<TestApi> {
  await api?.close();
  disconnect = vi.fn<MachineSockets['disconnectMachine']>();
  api = await startApi({
    db: db.pool,
    auth: AUTH,
    api: { sockets: { disconnectMachine: disconnect } },
  });
  return api;
}

/** A request whose response body is kept for the hash scan. */
async function send(
  method: string,
  path: string,
  opts: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  // A bodiless action posts `{}` (10-contracts). node:http sends a DELETE body without a length
  // unless told (fetch always sets it), so set content-length here.
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

interface Who {
  userId: string;
  accountId: string;
  email: string;
  cookie: string;
}

/** A user (own personal account) with a session cookie, minted directly (no login limit). */
async function user(opts: { admin?: boolean } = {}): Promise<Who> {
  const u = await createUser(db.pool, { password: PASSWORD, admin: opts.admin ?? false });
  const s = await createSession(db.pool, {
    userId: u.userId,
    accountId: u.accountId,
    userAgent: null,
    ip: null,
    now: new Date(),
  });
  return { ...u, cookie: `${COOKIE_NAME}=${s.token}` };
}

/** Make `who` a member of `accountId` (so an admin of that account may act on them). */
async function addMember(accountId: string, userId: string) {
  await db.pool.query(
    "INSERT INTO account_member (account_id, user_id, role) VALUES ($1, $2, 'member')",
    [accountId, userId],
  );
}

async function machine(accountId: string): Promise<string> {
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
}

const sessionsOf = async (userId: string) =>
  (await db.pool.query('SELECT 1 FROM web_session WHERE user_id = $1', [userId])).rowCount;

async function wipeUsers() {
  for (const t of ['web_session', 'password_reset', 'invite', 'account_member']) {
    await db.pool.query(`DELETE FROM ${t}`);
  }
  await db.pool.query('UPDATE machine SET revoked_at = NULL');
  await db.pool.query('DELETE FROM machine_credential');
  await db.pool.query('DELETE FROM machine');
  await db.pool.query('DELETE FROM app_user');
  await db.pool.query('DELETE FROM login_throttle');
}

beforeEach(async () => {
  bodies = [];
  await wipeUsers();
  await start();
});

// NFR-2: no response holds a password hash or any token / session / credential hash.
afterEach(async () => {
  await api?.close();
  api = null;
  const all = bodies.join('\n');
  expect(all).not.toMatch(/\$argon2/);
  expect(all).not.toMatch(/password_hash|token_hash|id_hash|secret_hash/);
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

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** Every admin route, for the 401 / 403 sweeps. */
const routes = (userId: string, inviteId: string): [string, string][] => [
  ['GET', API_PATHS.adminUsers],
  ['POST', API_PATHS.adminUserResetLink(userId)],
  ['POST', API_PATHS.adminUserDisable(userId)],
  ['POST', API_PATHS.adminUserUnlock(userId)],
  ['GET', API_PATHS.adminInvites],
  ['POST', API_PATHS.adminInvites],
  ['DELETE', API_PATHS.adminInvite(inviteId)],
];

describe('GET /api/admin/users', () => {
  it("lists the members of the admin's accounts with `locked`, nothing else", async () => {
    const admin = await user({ admin: true });
    const member = await user();
    await addMember(admin.accountId, member.userId);
    const stranger = await user();
    for (let i = 0; i < 10; i++) await recordFailure(db.pool, member.email, new Date());

    const res = await send('GET', API_PATHS.adminUsers, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const rows = AdminUserListResponseSchema.parse(res.json);
    expect(rows.map((r) => r.id).sort()).toEqual([admin.userId, member.userId].sort());
    expect(rows.find((r) => r.id === member.userId)).toMatchObject({
      email: member.email,
      is_admin: false,
      disabled_at: null,
      locked: true,
    });
    expect(rows.find((r) => r.id === admin.userId)).toMatchObject({
      is_admin: true,
      locked: false,
    });
    expect(res.text).not.toContain(stranger.email);
    for (const r of res.json as unknown as Record<string, unknown>[]) {
      expect(Object.keys(r).sort()).toEqual(
        ['created_at', 'disabled_at', 'display_name', 'email', 'id', 'is_admin', 'locked'].sort(),
      );
    }
  });
});

describe('POST /api/admin/users/:id/reset-link', () => {
  it('201 with a one-hour /reset link that works once', async () => {
    const admin = await user({ admin: true });
    const res = await send('POST', API_PATHS.adminUserResetLink(admin.userId), {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(201);
    const link = ResetLinkCreatedSchema.parse(res.json);
    expect(link.url.startsWith(`${HTTPS_URL}/reset?token=`)).toBe(true);
    const row = await db.pool.query<{ created_by: string }>(
      'SELECT created_by FROM password_reset',
    );
    expect(row.rows).toEqual([{ created_by: admin.userId }]);

    const token = new URL(link.url).searchParams.get('token')!;
    const reset = await send('POST', API_PATHS.authReset, {
      body: { token, password: 'a brand new long passphrase' },
    });
    expect(reset.status).toBe(200);
    const again = await send('POST', API_PATHS.authReset, {
      body: { token, password: 'another brand new passphrase' },
    });
    expect(again.status).toBe(400);
  });

  it('is rate-limited per IP: the 11th in 10 minutes → 429 rate_limited', async () => {
    const admin = await user({ admin: true });
    const statuses: number[] = [];
    let last: Res | null = null;
    for (let i = 0; i < 11; i++) {
      last = await send('POST', API_PATHS.adminUserResetLink(admin.userId), {
        cookie: admin.cookie,
      });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([...Array<number>(10).fill(201), 429]);
    expect(last!.json.error?.code).toBe('rate_limited');
  });
});

describe('POST /api/admin/users/:id/disable', () => {
  it("disables a member, revokes their sessions and their owned accounts' machines, closes sockets", async () => {
    const admin = await user({ admin: true });
    const member = await user();
    await addMember(admin.accountId, member.userId);
    const mine = await machine(member.accountId);
    const adminsMachine = await machine(admin.accountId);

    const res = await send('POST', API_PATHS.adminUserDisable(member.userId), {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    const u = await db.pool.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM app_user WHERE id = $1',
      [member.userId],
    );
    expect(u.rows[0]!.disabled_at).not.toBeNull();
    expect(await sessionsOf(member.userId)).toBe(0);
    expect(await sessionsOf(admin.userId)).toBe(1);
    const revoked = async (id: string) =>
      (
        await db.pool.query<{ r: boolean }>(
          'SELECT revoked_at IS NOT NULL AS r FROM machine WHERE id = $1',
          [id],
        )
      ).rows[0]!.r;
    expect(await revoked(mine)).toBe(true);
    expect(await revoked(adminsMachine)).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect.mock.calls[0]![0]).toBe(mine);

    // The disabled user's cookie no longer works.
    expect((await send('GET', API_PATHS.authMe, { cookie: member.cookie })).status).toBe(401);
  });

  it('refuses to disable yourself (400)', async () => {
    const admin = await user({ admin: true });
    const res = await send('POST', API_PATHS.adminUserDisable(admin.userId), {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(400);
    expect(await sessionsOf(admin.userId)).toBe(1);
  });
});

describe('POST /api/admin/users/:id/unlock', () => {
  it("clears the member's lockout", async () => {
    const admin = await user({ admin: true });
    const member = await user();
    await addMember(admin.accountId, member.userId);
    const now = new Date();
    for (let i = 0; i < 10; i++) await recordFailure(db.pool, member.email, now);
    expect(await isLocked(db.pool, member.email, now)).toBe(true);
    const res = await send('POST', API_PATHS.adminUserUnlock(member.userId), {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await isLocked(db.pool, member.email, now)).toBe(false);
  });
});

describe('invites', () => {
  it('create (201) → listed → revoke (200) → the preview is invalid', async () => {
    const admin = await user({ admin: true });
    const created = await send('POST', API_PATHS.adminInvites, {
      cookie: admin.cookie,
      body: { email: ' Sam@Example.com ', days: 3 },
    });
    expect(created.status).toBe(201);
    const inv = InviteCreatedSchema.parse(created.json);
    expect(inv.url.startsWith(`${HTTPS_URL}/signup?invite=`)).toBe(true);
    const token = new URL(inv.url).searchParams.get('invite')!;
    expect((await previewInvite(db.pool, token, new Date())).valid).toBe(true);

    const list = await send('GET', API_PATHS.adminInvites, { cookie: admin.cookie });
    expect(list.status).toBe(200);
    const rows = InviteListResponseSchema.parse(list.json);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: inv.id,
      email: 'sam@example.com',
      is_admin: false,
      expires_at: inv.expires_at,
      used_at: null,
      revoked_at: null,
    });
    expect(list.text).not.toContain(token);

    const del = await send('DELETE', API_PATHS.adminInvite(inv.id), { cookie: admin.cookie });
    expect(del.status, del.text).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await previewInvite(db.pool, token, new Date())).valid).toBe(false);
    const after = InviteListResponseSchema.parse(
      (await send('GET', API_PATHS.adminInvites, { cookie: admin.cookie })).json,
    );
    expect(after[0]!.revoked_at).not.toBeNull();
  });

  it('FR-2: an API invite is general (claims_account ignored); sign-up with it → not_supported_yet', async () => {
    const admin = await user({ admin: true });
    const created = await send('POST', API_PATHS.adminInvites, {
      cookie: admin.cookie,
      body: { admin: true, claims_account: LOCAL_ACCOUNT_ID },
    });
    expect(created.status).toBe(201);
    const inv = InviteCreatedSchema.parse(created.json);
    const row = await db.pool.query(
      'SELECT claims_account, is_admin, created_by FROM invite WHERE id = $1',
      [inv.id],
    );
    expect(row.rows).toEqual([{ claims_account: null, is_admin: true, created_by: admin.userId }]);

    const signup = await send('POST', API_PATHS.authSignup, {
      body: {
        invite: new URL(inv.url).searchParams.get('invite')!,
        email: 'new@example.com',
        display_name: 'New',
        password: PASSWORD,
      },
    });
    expect(signup.status).toBe(400);
    expect(signup.json.error?.message).toBe(NOT_SUPPORTED_YET_MESSAGE);
    expect(signup.json.error?.details).toEqual([{ path: 'invite', message: 'not_supported_yet' }]);
  });

  it('a bad body → 400', async () => {
    const admin = await user({ admin: true });
    const res = await send('POST', API_PATHS.adminInvites, {
      cookie: admin.cookie,
      body: { days: 31 },
    });
    expect(res.status).toBe(400);
  });
});

describe('FR-3: two accounts', () => {
  it("admin A can't list or act on account B's users or invites (404, nothing changes)", async () => {
    const a = await user({ admin: true });
    const b = await user({ admin: true });
    const bInvite = InviteCreatedSchema.parse(
      (await send('POST', API_PATHS.adminInvites, { cookie: b.cookie, body: {} })).json,
    );
    const now = new Date();
    for (let i = 0; i < 10; i++) await recordFailure(db.pool, b.email, now);

    const users = AdminUserListResponseSchema.parse(
      (await send('GET', API_PATHS.adminUsers, { cookie: a.cookie })).json,
    );
    expect(users.map((u) => u.id)).toEqual([a.userId]);
    const invites = InviteListResponseSchema.parse(
      (await send('GET', API_PATHS.adminInvites, { cookie: a.cookie })).json,
    );
    expect(invites).toEqual([]);

    for (const path of [
      API_PATHS.adminUserResetLink(b.userId),
      API_PATHS.adminUserDisable(b.userId),
      API_PATHS.adminUserUnlock(b.userId),
    ]) {
      const res = await send('POST', path, { cookie: a.cookie });
      expect(res.status, path).toBe(404);
      expect(res.json.error?.code).toBe('not_found');
    }
    const del = await send('DELETE', API_PATHS.adminInvite(bInvite.id), { cookie: a.cookie });
    expect(del.status).toBe(404);

    const bRow = await db.pool.query('SELECT disabled_at FROM app_user WHERE id = $1', [b.userId]);
    expect(bRow.rows).toEqual([{ disabled_at: null }]);
    expect(await sessionsOf(b.userId)).toBe(1);
    expect(await isLocked(db.pool, b.email, now)).toBe(true);
    expect((await db.pool.query('SELECT 1 FROM password_reset')).rowCount).toBe(0);
    const inv = await db.pool.query('SELECT revoked_at FROM invite WHERE id = $1', [bInvite.id]);
    expect(inv.rows).toEqual([{ revoked_at: null }]);
  });

  it('unknown and malformed ids → 404', async () => {
    const a = await user({ admin: true });
    for (const id of [UNKNOWN, 'not-a-uuid']) {
      for (const path of [
        API_PATHS.adminUserResetLink(id),
        API_PATHS.adminUserDisable(id),
        API_PATHS.adminUserUnlock(id),
      ]) {
        expect((await send('POST', path, { cookie: a.cookie })).status, path).toBe(404);
      }
      expect((await send('DELETE', API_PATHS.adminInvite(id), { cookie: a.cookie })).status).toBe(
        404,
      );
    }
  });
});

describe('401 / 403', () => {
  it('no session → 401 on every route', async () => {
    const a = await user({ admin: true });
    for (const [method, path] of routes(a.userId, UNKNOWN)) {
      const res = await send(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.json.error?.code).toBe('unauthorized');
    }
  });

  it('a non-admin → 403 forbidden on every route', async () => {
    const nonAdmin = await user();
    for (const [method, path] of routes(nonAdmin.userId, UNKNOWN)) {
      const res = await send(method, path, { cookie: nonAdmin.cookie });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.error?.code).toBe('forbidden');
    }
  });

  it('a bad or missing Origin → 403 on every unsafe route, nothing changes', async () => {
    const a = await user({ admin: true });
    const member = await user();
    await addMember(a.accountId, member.userId);
    const unsafe = routes(member.userId, UNKNOWN).filter(([m]) => m !== 'GET');
    for (const headers of [{ origin: 'https://evil.test' }, { origin: '' }]) {
      for (const [method, path] of unsafe) {
        const res = await send(method, path, { cookie: a.cookie, headers });
        expect(res.status, `${method} ${path} ${headers.origin}`).toBe(403);
        expect(res.json.error?.code).toBe('forbidden');
      }
    }
    expect(await sessionsOf(member.userId)).toBe(1);
    expect((await db.pool.query('SELECT 1 FROM invite')).rowCount).toBe(0);
    expect((await db.pool.query('SELECT 1 FROM password_reset')).rowCount).toBe(0);
  });
});

describe('local mode', () => {
  it('the admin routes are not registered (404)', async () => {
    await api?.close();
    api = await startApi({ db: db.pool, auth: DEFAULT_AUTH });
    const res = await send('GET', API_PATHS.adminUsers);
    expect(res.status).toBe(404);
  });
});
