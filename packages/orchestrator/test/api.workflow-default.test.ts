// UXR-87: GET/POST /api/workflows/:id/default (password mode): the editor's Compare and Adopt of
// the newer shipped `conductor` default, in the caller's own account (M2-T12: any member may adopt
// it). The base_version conflict and the HTTP mapping are under test; the save itself is MCP adopt_default_workflow's (oauth-mcp.test.ts).
// Needs `pnpm db:up`.
import { API_PATHS, CONDUCTOR_V4_DEF, WorkflowDefaultResponseSchema } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isShippedDefinition, newestShippedConductor } from '../src/engine/seed.js';
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

beforeEach(async () => {
  await db.pool.query("DELETE FROM workflow_definition WHERE id = 'conductor'");
});
afterEach(async () => {
  await api?.close();
  api = null;
});

async function signIn(t: TestApi, admin = false) {
  const u = await createUser(db.pool, { password: PASSWORD, ...(admin ? { admin: true } : {}) });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { headers: { cookie: cookieOf(res) }, accountId: u.accountId };
}

/** `conductor` v1 and v2 of the account, both edits of the shipped v4: a newer default is available. */
async function editedConductor(accountId: string) {
  for (const version of [1, 2]) {
    const def = { ...structuredClone(CONDUCTOR_V4_DEF), version, budget: { usd: version } };
    await db.pool.query(
      'INSERT INTO workflow_definition (account_id, id, version, definition) ' +
        "VALUES ($3, 'conductor', $1, $2)",
      [version, JSON.stringify(def), accountId],
    );
  }
}
const send = (who: { headers: { cookie: string } }, body?: unknown) => ({
  headers: who.headers,
  ...(body !== undefined ? { body } : {}),
});

const PATH = API_PATHS.workflowDefault('conductor');
const code = (r: { json: Record<string, unknown> }) => (r.json.error as { code: string }).code;

describe('/api/workflows/:id/default', () => {
  it('GET compares the latest version with the default; 404 when none is newer', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const who = await signIn(api);
    // Only the shipped v4, unedited: nothing to offer. Another id never has one.
    await db.pool.query(
      'INSERT INTO workflow_definition (account_id, id, version, definition) ' +
        "VALUES ($2, 'conductor', 4, $1)",
      [JSON.stringify(CONDUCTOR_V4_DEF), who.accountId],
    );
    expect((await api.send('GET', PATH, send(who))).status).toBe(404);
    expect((await api.send('GET', API_PATHS.workflowDefault('m1_basic'), send(who))).status).toBe(
      404,
    );

    await db.pool.query("DELETE FROM workflow_definition WHERE id = 'conductor'");
    await editedConductor(who.accountId);
    // Another account's edits don't make a default available here.
    const other = await signIn(api);
    expect((await api.send('GET', PATH, send(other))).status).toBe(404);
    const res = await api.send('GET', PATH, send(who));
    expect(res.status).toBe(200);
    const body = WorkflowDefaultResponseSchema.parse(res.json);
    expect(body).toMatchObject({ version: newestShippedConductor().version, base_version: 2 });
    expect(body.diff.changes.map((c) => c.path)).toContain('budget.usd');
  });

  it('POST adopts into the caller’s own account: a member needs no admin (M2-T12)', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const member = await signIn(api);
    const other = await signIn(api);
    await editedConductor(member.accountId);
    await editedConductor(other.accountId);
    const adopted = await api.send('POST', PATH, send(member, { base_version: 2 }));
    expect([adopted.status, adopted.json]).toEqual([201, { id: 'conductor', version: 3 }]);
    const latest = async (accountId: string) =>
      (
        await db.pool.query<{ v: number }>(
          "SELECT max(version) AS v FROM workflow_definition WHERE id = 'conductor' " +
            'AND account_id = $1',
          [accountId],
        )
      ).rows[0]!.v;
    expect(await latest(member.accountId)).toBe(3);
    expect(await latest(other.accountId)).toBe(2);
  });

  it('POST checks the body and base_version, then saves the default as the next version', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const admin = await signIn(api, true);
    await editedConductor(admin.accountId);

    const bad = await api.send('POST', PATH, send(admin, {}));
    expect(bad.status).toBe(400);
    const other = await api.send(
      'POST',
      API_PATHS.workflowDefault('m1_basic'),
      send(admin, { base_version: 1 }),
    );
    expect(other.status).toBe(404);

    const stale = await api.send('POST', PATH, send(admin, { base_version: 1 }));
    expect([stale.status, code(stale)]).toEqual([409, 'conflict']);
    expect((stale.json.error as { message: string }).message).toMatch(/the latest is 2/);

    const adopted = await api.send('POST', PATH, send(admin, { base_version: 2 }));
    expect([adopted.status, adopted.json]).toEqual([201, { id: 'conductor', version: 3 }]);
    const row = await db.pool.query<{ definition: unknown; created_by: string | null }>(
      'SELECT definition, created_by FROM workflow_definition ' +
        "WHERE id = 'conductor' AND version = 3 AND account_id = $1",
      [admin.accountId],
    );
    expect(isShippedDefinition(row.rows[0]!.definition, newestShippedConductor())).toBe(true);
    expect(row.rows[0]!.created_by).toMatch(/^web:/);

    const detail = await api.send('GET', API_PATHS.workflow('conductor'), send(admin));
    expect(detail.json).toMatchObject({ version: 3, default_available: null });
    expect((await api.send('GET', PATH, send(admin))).status).toBe(404);
  });
});
