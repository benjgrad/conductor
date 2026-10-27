// M2-T17: POST /api/tickets repo check (U-048, ADR-0013 §Routing; 10-contracts §Accounts and web
// auth, §Repo grammar). `password` mode: the repo must pass `canonicalRepo` and is stored
// canonical; `local` mode keeps M1's rule. A repo no machine of the account has is created with
// `warnings: ['no_machine_has_repo']`.
import { API_PATHS, TicketDtoSchema } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTH } from '../src/auth/config.js';
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

const ticket = (repo: string) => ({ title: 'T', body: '', repo, kind: 'work' });

async function signIn(t: TestApi): Promise<{ cookie: string; accountId: string }> {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

/** A non-revoked machine of the account whose inventory has `remote`. */
async function machineWithRepo(accountId: string, remote: string, revoked = false) {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  await db.pool.query(
    `INSERT INTO machine (id, account_id, hostname, os, arch, status, cpu_total, mem_total_mb,
                          disk_free_mb, budget_cpu, budget_mem_mb, max_sessions,
                          max_concurrent_builds, revoked_at)
     VALUES ($1, $2, 'h', 'darwin', 'arm64', 'offline', 0, 0, 0, 0, 0, 0, 0, $3)`,
    [id, accountId, revoked ? new Date() : null],
  );
  await db.pool.query(
    `INSERT INTO machine_repo (machine_id, account_id, repo, path, head_commit, remote)
     VALUES ($1, $2, $3, '/Users/me/app', $4, $3)`,
    [id, accountId, remote, 'a'.repeat(40)],
  );
}

describe('password mode', () => {
  it('a repo that is not host/org/repo is 400 at path repo, and nothing is inserted', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    for (const repo of ['ext::sh -c x', '/tmp/some/repo', '../x', 'file:///tmp/x']) {
      const res = await api.send('POST', API_PATHS.tickets, {
        headers: { cookie: a.cookie },
        body: ticket(repo),
      });
      expect(res.status, repo).toBe(400);
      expect(res.json.error?.code).toBe('bad_request');
      expect(res.json.error?.details?.map((d) => d.path)).toEqual(['repo']);
    }
    const n = await db.pool.query('SELECT 1 FROM ticket WHERE account_id = $1', [a.accountId]);
    expect(n.rowCount).toBe(0);
  });

  it('no machine has the repo: 201 with the warning, stored canonical in the account', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const res = await api.send('POST', API_PATHS.tickets, {
      headers: { cookie: a.cookie },
      body: ticket('github.com/org/app'),
    });
    expect(res.status).toBe(201);
    const dto = TicketDtoSchema.parse(res.json);
    expect(dto.repo).toBe('github.com/org/app');
    expect(dto.warnings).toEqual(['no_machine_has_repo']);

    const url = await api.send('POST', API_PATHS.tickets, {
      headers: { cookie: a.cookie },
      body: ticket('https://GitHub.com/org/app.git'),
    });
    expect(url.status).toBe(201);
    expect(TicketDtoSchema.parse(url.json).repo).toBe('github.com/org/app');

    const row = await db.pool.query<{ account_id: string }>(
      'SELECT account_id FROM ticket WHERE id = $1',
      [dto.id],
    );
    expect(row.rows[0]?.account_id).toBe(a.accountId);
  });

  it("a machine of the account has it (case-insensitive): no warning; others' don't count", async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    await machineWithRepo(b.accountId, 'github.com/org/shared');
    await machineWithRepo(a.accountId, 'github.com/org/gone', true);
    await machineWithRepo(a.accountId, 'github.com/Org/App');

    const create = async (repo: string) => {
      const res = await api!.send('POST', API_PATHS.tickets, {
        headers: { cookie: a.cookie },
        body: ticket(repo),
      });
      expect(res.status).toBe(201);
      return TicketDtoSchema.parse(res.json);
    };
    expect((await create('github.com/org/app')).warnings).toBeUndefined();
    // only account B's machine has it
    expect((await create('github.com/org/shared')).warnings).toEqual(['no_machine_has_repo']);
    // a revoked machine doesn't count
    expect((await create('github.com/org/gone')).warnings).toEqual(['no_machine_has_repo']);
  });
});

describe('local mode', () => {
  it('a local path is still accepted, verbatim (the e2e fixture repos)', async () => {
    api = await startApi({ db: db.pool, auth: DEFAULT_AUTH });
    const res = await api.send('POST', API_PATHS.tickets, { body: ticket('/tmp/fixture-repo') });
    expect(res.status).toBe(201);
    const dto = TicketDtoSchema.parse(res.json);
    expect(dto.repo).toBe('/tmp/fixture-repo');
    expect(dto.warnings).toEqual(['no_machine_has_repo']);
  });
});
