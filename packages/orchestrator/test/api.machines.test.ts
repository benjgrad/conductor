// M2-T17: the machines REST routes in `password` mode (10-contracts §Accounts and web auth,
// ADR-0013 §Enrollment): enrollment tokens, the public enroll, list, detail, rename, revoke, the
// account boundary and the enroll rate limit.
import {
  API_PATHS,
  CLOSE_REASONS,
  CLOSE_REVOKED,
  EnrollResponseSchema,
  EnrollmentTokenCreatedSchema,
  MachineDetailSchema,
  MachineListResponseSchema,
  MachineRowSchema,
} from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineSockets } from '../src/gateway/revoke.js';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  passwordAuth,
  startApi,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
const SERVED = '0.2.0';

let api: TestApi;
let sockets: { disconnectMachine: ReturnType<typeof vi.fn<MachineSockets['disconnectMachine']>> };
let a: { cookie: string; accountId: string };
let b: { cookie: string; accountId: string };

async function signIn(t: TestApi): Promise<{ cookie: string; accountId: string }> {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });

const enrollBody = (token: string) => ({
  token,
  hostname: 'mac-mini',
  os: 'darwin',
  arch: 'arm64',
  daemon_version: '0.1.0',
});

/** A token for `who` and the machine enrolled with it; returns the machine id. */
async function enrollFor(who: { cookie: string }): Promise<string> {
  const t = await api.send('POST', API_PATHS.machineEnrollmentTokens, { ...as(who), body: {} });
  expect(t.status).toBe(201);
  const { token } = EnrollmentTokenCreatedSchema.parse(t.json);
  const e = await api.send('POST', API_PATHS.machinesEnroll, { body: enrollBody(token) });
  expect(e.status).toBe(201);
  return EnrollResponseSchema.parse(e.json).machine_id;
}

beforeEach(async () => {
  sockets = { disconnectMachine: vi.fn<MachineSockets['disconnectMachine']>() };
  api = await startApi({
    db: db.pool,
    auth: passwordAuth(HTTPS_URL),
    api: { sockets, servedVersion: SERVED },
  });
  a = await signIn(api);
  b = await signIn(api);
});

afterEach(async () => {
  await api.close();
});

describe('enrollment tokens and enroll', () => {
  it('the token commands are the curl | sh and irm | iex lines on the public URL', async () => {
    const res = await api.send('POST', API_PATHS.machineEnrollmentTokens, { ...as(a), body: {} });
    expect(res.status).toBe(201);
    const created = EnrollmentTokenCreatedSchema.parse(res.json);
    expect(created.command).toBe(
      `curl -fsSL ${HTTPS_URL}/install.sh | sh -s -- --token ${created.token}`,
    );
    expect(created.command_windows).toBe(
      `$env:CONDUCTOR_ENROLL_TOKEN='${created.token}'; irm ${HTTPS_URL}/install.ps1 | iex`,
    );
    expect(Date.parse(created.expires_at)).toBeGreaterThan(Date.now());

    const anon = await api.send('POST', API_PATHS.machineEnrollmentTokens, { body: {} });
    expect(anon.status).toBe(401);
    expect(anon.json.error?.code).toBe('unauthorized');
  });

  it('enroll needs no session; a used or unknown token is 401', async () => {
    const t = await api.send('POST', API_PATHS.machineEnrollmentTokens, { ...as(a), body: {} });
    const { token } = EnrollmentTokenCreatedSchema.parse(t.json);
    const ok = await api.send('POST', API_PATHS.machinesEnroll, { body: enrollBody(token) });
    expect(ok.status).toBe(201);
    const enrolled = EnrollResponseSchema.parse(ok.json);
    const row = await db.pool.query<{ account_id: string }>(
      'SELECT account_id FROM machine WHERE id = $1',
      [enrolled.machine_id],
    );
    expect(row.rows[0]?.account_id).toBe(a.accountId);

    for (const bad of [token, 'not-a-real-token']) {
      const res = await api.send('POST', API_PATHS.machinesEnroll, { body: enrollBody(bad) });
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe('unauthorized');
    }
    const invalid = await api.send('POST', API_PATHS.machinesEnroll, { body: {} });
    expect(invalid.status).toBe(400);
  });

  it('the 11th enroll in 10 minutes from one IP is 429', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await api.send('POST', API_PATHS.machinesEnroll, {
        body: enrollBody(`bad-${i}`),
      });
      expect(res.status).toBe(401);
    }
    const res = await api.send('POST', API_PATHS.machinesEnroll, { body: enrollBody('bad-10') });
    expect(res.status).toBe(429);
    expect(res.json.error?.code).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('list, detail, rename, revoke', () => {
  it('the enrolled machine lists, with outdated computed against the served version', async () => {
    const id = await enrollFor(a);
    const list = await api.send('GET', API_PATHS.machines, as(a));
    expect(list.status).toBe(200);
    const rows = MachineListResponseSchema.parse(list.json);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      hostname: 'mac-mini',
      name: 'mac-mini',
      daemon_version: '0.1.0',
      outdated: true,
      repo_count: 0,
      running_sessions: 0,
      revoked_at: null,
      status: 'offline',
    });

    await db.pool.query("UPDATE machine SET daemon_version = '0.2.0' WHERE id = $1", [id]);
    const again = MachineListResponseSchema.parse(
      (await api.send('GET', API_PATHS.machines, as(a))).json,
    );
    expect(again[0]?.outdated).toBe(false);

    // the other account sees none of it
    const other = await api.send('GET', API_PATHS.machines, as(b));
    expect(other.status).toBe(200);
    expect(other.json).toEqual([]);
  });

  it('detail carries repos, capabilities by kind, open alerts and live sessions', async () => {
    const id = await enrollFor(a);
    await db.pool.query(
      `INSERT INTO machine_repo (machine_id, account_id, repo, path, head_commit, remote,
                                 default_branch, mode)
       VALUES ($1, $2, 'github.com/org/app', '/Users/me/app', $3, 'github.com/org/app', 'main',
               'checkout')`,
      [id, a.accountId, 'a'.repeat(40)],
    );
    await db.pool.query(
      `INSERT INTO machine_capability (machine_id, account_id, key, kind, name, version, detail)
       VALUES ($1, $2, 'cli:gh:authed', 'cli', 'gh', '2.60.0', '{"authed": true}'),
              ($1, $2, 'skill:review@github.com/org/app', 'skill', 'review', NULL,
               '{"repo": "github.com/org/app"}')`,
      [id, a.accountId],
    );
    // one open alert and one cleared (not shown)
    await db.pool.query(
      `INSERT INTO machine_alert (machine_id, account_id, kind, detail, cleared_at)
       VALUES ($1, $2, 'git_tamper', '{"repo": "github.com/org/app", "files": [".git/config"]}',
               NULL),
              ($1, $2, 'git_tamper', '{"repo": "github.com/org/app", "files": ["x"]}', now())`,
      [id, a.accountId],
    );

    const res = await api.send('GET', API_PATHS.machine(id), as(a));
    expect(res.status).toBe(200);
    const detail = MachineDetailSchema.parse(res.json);
    expect(detail).toMatchObject({ id, os: 'darwin', arch: 'arm64', repo_count: 1 });
    expect(detail.repos).toEqual([
      {
        remote: 'github.com/org/app',
        path: '/Users/me/app',
        mode: 'checkout',
        default_branch: 'main',
      },
    ]);
    expect(detail.capabilities.cli).toEqual([
      { name: 'gh', version: '2.60.0', authed: true, repo: null },
    ]);
    expect(detail.capabilities.skill).toEqual([
      { name: 'review', version: null, authed: null, repo: 'github.com/org/app' },
    ]);
    expect(detail.capabilities.mcp).toEqual([]);
    expect(detail.alerts).toMatchObject([
      { kind: 'git_tamper', repo: 'github.com/org/app', session_id: null, files: ['.git/config'] },
    ]);
    expect(detail.live_sessions).toEqual([]);
  });

  it('rename returns the MachineRow and sticks; an empty name is 400', async () => {
    const id = await enrollFor(a);
    const res = await api.send('PATCH', API_PATHS.machine(id), {
      ...as(a),
      body: { name: '  build box ' },
    });
    expect(res.status).toBe(200);
    expect(MachineRowSchema.parse(res.json)).toMatchObject({ id, name: 'build box' });
    const rows = MachineListResponseSchema.parse(
      (await api.send('GET', API_PATHS.machines, as(a))).json,
    );
    expect(rows[0]?.name).toBe('build box');

    const empty = await api.send('PATCH', API_PATHS.machine(id), {
      ...as(a),
      body: { name: '  ' },
    });
    expect(empty.status).toBe(400);
    expect(empty.json.error?.code).toBe('bad_request');
  });

  it('revoke sets revoked_at and closes the socket with 4001', async () => {
    const id = await enrollFor(a);
    const res = await api.send('POST', API_PATHS.machineRevoke(id), { ...as(a), body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(sockets.disconnectMachine).toHaveBeenCalledWith(
      id,
      CLOSE_REVOKED,
      CLOSE_REASONS[CLOSE_REVOKED],
    );
    const detail = MachineDetailSchema.parse(
      (await api.send('GET', API_PATHS.machine(id), as(a))).json,
    );
    expect(detail.revoked_at).not.toBeNull();
    // revoked machines stay listed
    const rows = MachineListResponseSchema.parse(
      (await api.send('GET', API_PATHS.machines, as(a))).json,
    );
    expect(rows[0]?.revoked_at).toBe(detail.revoked_at);
  });

  it("another account's machine (and an unknown id) is 404 on every machine route", async () => {
    const id = await enrollFor(a);
    for (const target of [id, 'no-such-machine']) {
      const get = await api.send('GET', API_PATHS.machine(target), as(b));
      const patch = await api.send('PATCH', API_PATHS.machine(target), {
        ...as(b),
        body: { name: 'mine now' },
      });
      const revoke = await api.send('POST', API_PATHS.machineRevoke(target), {
        ...as(b),
        body: {},
      });
      for (const r of [get, patch, revoke]) {
        expect(r.status).toBe(404);
        expect(r.json.error?.code).toBe('not_found');
      }
    }
    expect(sockets.disconnectMachine).not.toHaveBeenCalled();
    const row = await db.pool.query<{ name: string | null; revoked_at: Date | null }>(
      'SELECT name, revoked_at FROM machine WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ name: 'mac-mini', revoked_at: null });
  });
});
