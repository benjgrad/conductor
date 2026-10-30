// GET /api/repos (10-contracts §Repo suggestions), password mode. The ranking itself is
// rankRepos' (shared, pure); this checks the queries: account scoping and revoked machines.
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { API_PATHS, RepoListResponseSchema } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  passwordAuth,
  startApi,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';
import { enrolled } from './gateway/auth-harness.js';
import { seedInventory } from './gateway/inventory-seed.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

async function signIn(t: TestApi): Promise<{ cookie: string; accountId: string }> {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

async function ticket(t: TestApi, cookie: string, repo: string, daysAgo: number): Promise<void> {
  const res = await t.send('POST', API_PATHS.tickets, {
    headers: { cookie },
    body: { title: 'T', body: '', repo, kind: 'work' },
  });
  expect(res.status).toBe(201);
  await db.pool.query(
    `UPDATE ticket SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
    [(res.json as { id: string }).id, daysAgo],
  );
}

async function machineWith(accountId: string, remote: string): Promise<string> {
  const scope = { account_id: accountId, actor: { kind: 'user' as const, user_id: randomUUID() } };
  const { machine_id } = await enrolled(db.pool, scope);
  await seedInventory(db.pool, machine_id, { remote });
  return machine_id;
}

describe('GET /api/repos', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('GET', API_PATHS.repos);
    expect([res.status, res.json.error?.code]).toEqual([401, 'unauthorized']);
  });

  it('ranks the account’s own ticket repos, then its unrevoked machines’ repos', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    await ticket(api, a.cookie, 'github.com/o/old', 90);
    await ticket(api, a.cookie, 'github.com/o/old', 90);
    await ticket(api, a.cookie, 'https://github.com/o/new.git', 1);
    await ticket(api, b.cookie, 'github.com/o/theirs', 0);
    await machineWith(a.accountId, 'github.com/o/machine');
    const revoked = await machineWith(a.accountId, 'github.com/o/revoked');
    await db.pool.query('UPDATE machine SET revoked_at = now() WHERE id = $1', [revoked]);
    await machineWith(b.accountId, 'github.com/o/their-machine');

    const res = await api.send('GET', API_PATHS.repos, { headers: { cookie: a.cookie } });
    expect(res.status).toBe(200);
    expect(RepoListResponseSchema.parse(res.json).map((r) => [r.repo, r.ticket_count])).toEqual([
      ['github.com/o/new', 1],
      ['github.com/o/old', 2],
      ['github.com/o/machine', 0],
    ]);
  });
});
