// ADR-0030: /api/repo-checks (password mode) and the engine's read of the override. The DB is the
// subject (account scoping, the upsert, the repo key), so this runs against a test database.
// Needs `pnpm db:up`.
import {
  API_PATHS,
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
