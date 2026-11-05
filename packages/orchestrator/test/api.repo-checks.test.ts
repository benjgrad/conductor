// ADR-0030: /api/repo-checks (password mode) and the engine's read of the override. The DB is the
// subject (account scoping, the upsert, the repo key), so this runs against a test database.
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import {
  API_PATHS,
  CONDUCTOR_V4_DEF,
  RepoCheckRunsResponseSchema,
  RepoChecksHealthResponseSchema,
  RepoChecksDetailSchema,
  RepoChecksDtoSchema,
  RepoChecksListResponseSchema,
} from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoChecks } from '../src/engine/rows.js';
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
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

async function signIn(t: TestApi) {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId, email: u.email };
}

const CHECKS = [{ name: 'Web build', cmd: 'cd m-one && npm ci && npm run build' }];
const q = (repo: string) => `${API_PATHS.repoChecks}?repo=${encodeURIComponent(repo)}`;
/** DELETE with a JSON body: node sends it chunked unless the length is given. */
const del = (t: TestApi, cookie: string, repo: string) => {
  const body = { repo };
  const length = String(Buffer.byteLength(JSON.stringify(body)));
  return t.send('DELETE', API_PATHS.repoChecks, {
    headers: { cookie, 'content-length': length },
    body,
  });
};

describe('/api/repo-checks', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('GET', API_PATHS.repoChecks);
    expect(res.status).toBe(401);
  });

  it('PUT upserts under the canonical key; GET and DELETE are scoped to the account', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const put = await api.send('PUT', API_PATHS.repoChecks, {
      headers: { cookie: a.cookie },
      body: { repo: 'git@github.com:Acme/MethodUI.git', checks: CHECKS },
    });
    expect(put.status).toBe(200);
    expect(RepoChecksDtoSchema.parse(put.json)).toMatchObject({
      repo: 'github.com/acme/methodui',
      setup: null,
      checks: CHECKS,
      updated_by: a.email,
    });
    // A second PUT replaces it.
    const again = await api.send('PUT', API_PATHS.repoChecks, {
      headers: { cookie: a.cookie },
      body: { repo: 'github.com/acme/methodui', setup: '', checks: CHECKS },
    });
    expect(RepoChecksDtoSchema.parse(again.json).setup).toBe('');

    const list = await api.send('GET', API_PATHS.repoChecks, { headers: { cookie: a.cookie } });
    expect(RepoChecksListResponseSchema.parse(list.json).repos).toHaveLength(1);
    const detail = await api.send('GET', q('github.com/acme/methodui'), {
      headers: { cookie: a.cookie },
    });
    expect(RepoChecksDetailSchema.parse(detail.json).override?.setup).toBe('');

    const theirs = await api.send('GET', API_PATHS.repoChecks, { headers: { cookie: b.cookie } });
    expect(RepoChecksListResponseSchema.parse(theirs.json).repos).toEqual([]);
    expect((await del(api, b.cookie, 'github.com/acme/methodui')).status).toBe(404);

    // The engine's read: the ticket's repo as stored, any spelling of the same repo.
    expect(await readRepoChecks(db.pool, a.accountId, 'github.com/Acme/MethodUI')).toEqual({
      setup: '',
      checks: CHECKS,
    });
    expect(await readRepoChecks(db.pool, b.accountId, 'github.com/acme/methodui')).toBeNull();

    const ok = await del(api, a.cookie, 'https://github.com/acme/MethodUI');
    expect([ok.status, ok.json]).toEqual([200, { ok: true }]);
    expect(await readRepoChecks(db.pool, a.accountId, 'github.com/acme/methodui')).toBeNull();
  });

  it('PUT 400s on duplicate check names', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const res = await api.send('PUT', API_PATHS.repoChecks, {
      headers: { cookie: a.cookie },
      body: { repo: 'github.com/acme/app', checks: [...CHECKS, ...CHECKS] },
    });
    expect([res.status, res.json.error?.code]).toEqual([400, 'bad_request']);
  });

  it('readRepoChecks ignores (and reports) a stored config that no longer parses', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    await db.pool.query(
      "INSERT INTO repo_checks (account_id, repo, config) VALUES ($1, 'github.com/acme/bad', '{}')",
      [a.accountId],
    );
    const seen: string[] = [];
    expect(
      await readRepoChecks(db.pool, a.accountId, 'github.com/acme/bad', (m) => seen.push(m)),
    ).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

// UXR-80: the run history routes. The SQL (scope through the session, the window, the run_cmd ↔
// command.exited join) and the cmd → check-name mapping are what's under test.
const BASE = Date.now();
const minutesAgo = (m: number) => new Date(BASE - m * 60_000);

async function machine(accountId: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
      'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
      "VALUES ($1, $2, 'Laptop', 'h', 'linux', 'x64', 8, 16000, 100000, 4, 8000, 2, 1)",
    [id, accountId],
  );
  return id;
}

/** A ticket + session in `repo`; returns a function seeding one finished check run. */
async function ticketWithRuns(accountId: string, repo: string, title: string) {
  await db.pool.query(
    "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 1, $1) " +
      'ON CONFLICT DO NOTHING',
    [JSON.stringify(CONDUCTOR_V4_DEF)],
  );
  const machineId = await machine(accountId);
  const t = await db.pool.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, body, workflow_id, status, kind) ' +
      "VALUES ($1, $2, $3, 'B', 'conductor', 'done', 'work') RETURNING id",
    [accountId, repo, title],
  );
  const ticketId = t.rows[0]!.id;
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, ' +
      "status, workflow_state) VALUES ($1, $2, $3, 'conductor', 1, 'done', 'done') RETURNING id",
    [accountId, ticketId, machineId],
  );
  const sessionId = s.rows[0]!.id;
  const runCheck = async (
    cmd: string,
    agoMin: number,
    exit: { exit_code: number | null; timed_out?: boolean; setup_failed?: boolean },
  ) => {
    const commandId = randomUUID();
    await db.pool.query(
      "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, $2, 'run_cmd', $3, $4, $5)",
      [
        commandId,
        `machine:${machineId}`,
        sessionId,
        JSON.stringify({ state: 'implementing', cmd, cwd: null, timeout_ms: null }),
        minutesAgo(agoMin + 2),
      ],
    );
    await db.pool.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
      [
        sessionId,
        JSON.stringify({ command_id: commandId, output_tail: '', timed_out: false, ...exit }),
        minutesAgo(agoMin),
      ],
    );
  };
  return { ticketId, runCheck };
}

const runsQ = (repo: string, limit?: number) =>
  `${API_PATHS.repoCheckRuns}?repo=${encodeURIComponent(repo)}${limit !== undefined ? `&limit=${limit}` : ''}`;

describe('/api/repo-checks/runs and /health (UXR-80)', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    expect((await api.send('GET', runsQ('github.com/a/b'))).status).toBe(401);
    expect((await api.send('GET', API_PATHS.repoChecksHealth)).status).toBe(401);
  });

  it('400s without a repo or with a bad limit', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const get = (path: string) => api!.send('GET', path, { headers: { cookie: a.cookie } });
    expect((await get(API_PATHS.repoCheckRuns)).status).toBe(400);
    expect((await get(runsQ('github.com/a/b', 0))).status).toBe(400);
    expect((await get(`${runsQ('github.com/a/b')}&limit=x`)).status).toBe(400);
    expect((await get(runsQ('github.com/a/b', 21))).status).toBe(400);
  });

  it('returns the newest runs per override check, scoped to the account and the window', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const checks = [
      { name: 'Tests', cmd: 'npm test' },
      { name: 'Build', cmd: 'npm run build' },
    ];
    await api.send('PUT', API_PATHS.repoChecks, {
      headers: { cookie: a.cookie },
      body: { repo: 'github.com/acme/app', checks },
    });
    const { ticketId, runCheck } = await ticketWithRuns(
      a.accountId,
      'github.com/Acme/App',
      'Fix it',
    );
    // 7 runs of `npm test`, newest (10 min ago) first in the response.
    await runCheck('npm test', 70, { exit_code: 0 });
    await runCheck('npm test', 60, { exit_code: 0 });
    await runCheck('npm test', 50, { exit_code: 1 });
    await runCheck('npm test', 40, { exit_code: 0 });
    await runCheck('npm test', 30, { exit_code: null, setup_failed: true });
    await runCheck('npm test', 20, { exit_code: null, timed_out: true });
    await runCheck('npm test', 10, { exit_code: 2 });
    // Outside the window.
    await runCheck('npm test', 31 * 24 * 60, { exit_code: 1 });
    // Another account's run of the same repo and command.
    const other = await ticketWithRuns(b.accountId, 'github.com/acme/app', 'Theirs');
    await other.runCheck('npm test', 5, { exit_code: 1 });

    const res = await api.send('GET', runsQ('github.com/acme/app'), {
      headers: { cookie: a.cookie },
    });
    expect(res.status).toBe(200);
    const body = RepoCheckRunsResponseSchema.parse(res.json);
    expect(body.repo).toBe('github.com/acme/app');
    expect(body.window_days).toBe(30);
    expect(body.checks.map((c) => c.name)).toEqual(['Tests', 'Build']);
    const tests = body.checks[0]!;
    expect(tests.runs.map((r) => r.status)).toEqual([
      'fail',
      'timed_out',
      'setup_failed',
      'pass',
      'fail',
    ]);
    expect(tests.runs[0]).toMatchObject({
      exit_code: 2,
      ticket_id: ticketId,
      ticket_title: 'Fix it',
      state: 'implementing',
      duration_ms: 120_000,
    });
    expect([tests.runs_in_window, tests.failures_in_window]).toEqual([7, 4]);
    expect(body.checks[1]).toMatchObject({ runs: [], runs_in_window: 0 });

    const two = RepoCheckRunsResponseSchema.parse(
      (await api.send('GET', runsQ('github.com/acme/app', 2), { headers: { cookie: a.cookie } }))
        .json,
    );
    expect(two.checks[0]!.runs).toHaveLength(2);

    const health = RepoChecksHealthResponseSchema.parse(
      (await api.send('GET', API_PATHS.repoChecksHealth, { headers: { cookie: a.cookie } })).json,
    );
    expect(health.repos).toEqual([
      {
        repo: 'github.com/acme/app',
        runs: 7,
        failures: 4,
        last_run_at: tests.runs[0]!.at,
        last_status: 'fail',
        recent: ['fail', 'timed_out', 'setup_failed', 'pass', 'fail'],
      },
    ]);
    const theirs = RepoChecksHealthResponseSchema.parse(
      (await api.send('GET', API_PATHS.repoChecksHealth, { headers: { cookie: b.cookie } })).json,
    );
    expect(theirs.repos.map((r) => [r.repo, r.runs])).toEqual([['github.com/acme/app', 1]]);
  });

  it('without an override, names the runs after the workflow gates’ checks', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const detail = RepoChecksDetailSchema.parse(
      (await api.send('GET', q('github.com/acme/plain'), { headers: { cookie: a.cookie } })).json,
    );
    const gateCheck = detail.effective[0]!.checks[0]!;
    const { runCheck } = await ticketWithRuns(a.accountId, 'github.com/acme/plain', 'T');
    await runCheck(gateCheck.cmd, 5, { exit_code: 0 });
    const body = RepoCheckRunsResponseSchema.parse(
      (await api.send('GET', runsQ('github.com/acme/plain'), { headers: { cookie: a.cookie } }))
        .json,
    );
    const named = body.checks.find((c) => c.cmd === gateCheck.cmd)!;
    expect(named.name).toBe(gateCheck.name);
    expect(named.runs.map((r) => r.status)).toEqual(['pass']);
    // Deduped by command across gates.
    expect(new Set(body.checks.map((c) => c.cmd)).size).toBe(body.checks.length);
  });
});
