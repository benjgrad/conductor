// UXR-87: GET/POST /api/workflows/:id/default (password mode): the editor's Compare and Adopt of
// the newer shipped `conductor` default. The admin gate, the base_version conflict and the HTTP
// mapping are under test; the save itself is MCP adopt_default_workflow's (oauth-mcp.test.ts).
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
  return { headers: { cookie: cookieOf(res) } };
}

/** `conductor` v1 and v2, both edits of the shipped v4: a newer default (v4) is available. */
async function editedConductor() {
  for (const version of [1, 2]) {
    const def = { ...structuredClone(CONDUCTOR_V4_DEF), version, budget: { usd: version } };
    await db.pool.query(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', $1, $2)",
      [version, JSON.stringify(def)],
    );
  }
}

const PATH = API_PATHS.workflowDefault('conductor');
const code = (r: { json: Record<string, unknown> }) => (r.json.error as { code: string }).code;

describe('/api/workflows/:id/default', () => {
  it('GET compares the latest version with the default; 404 when none is newer', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const who = await signIn(api);
    // Only the shipped v4, unedited: nothing to offer. Another id never has one.
    await db.pool.query(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 4, $1)",
      [JSON.stringify(CONDUCTOR_V4_DEF)],
    );
    expect((await api.send('GET', PATH, who)).status).toBe(404);
    expect((await api.send('GET', API_PATHS.workflowDefault('m1_basic'), who)).status).toBe(404);

    await db.pool.query("DELETE FROM workflow_definition WHERE id = 'conductor'");
    await editedConductor();
    const res = await api.send('GET', PATH, who);
    expect(res.status).toBe(200);
    const body = WorkflowDefaultResponseSchema.parse(res.json);
    expect(body).toMatchObject({ version: newestShippedConductor().version, base_version: 2 });
    expect(body.diff.changes.map((c) => c.path)).toContain('budget.usd');
  });

  it('POST needs an instance admin', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    await editedConductor();
    const member = await signIn(api);
    const denied = await api.send('POST', PATH, { ...member, body: { base_version: 2 } });
    expect([denied.status, code(denied)]).toEqual([403, 'forbidden']);
    const latest = await db.pool.query<{ v: number }>(
      "SELECT max(version) AS v FROM workflow_definition WHERE id = 'conductor'",
    );
    expect(latest.rows[0]!.v).toBe(2);
  });

  it('POST checks the body and base_version, then saves the default as the next version', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    await editedConductor();
    const admin = await signIn(api, true);

    const bad = await api.send('POST', PATH, { ...admin, body: {} });
    expect(bad.status).toBe(400);
    const other = await api.send('POST', API_PATHS.workflowDefault('m1_basic'), {
      ...admin,
      body: { base_version: 1 },
    });
    expect(other.status).toBe(404);

    const stale = await api.send('POST', PATH, { ...admin, body: { base_version: 1 } });
    expect([stale.status, code(stale)]).toEqual([409, 'conflict']);
    expect((stale.json.error as { message: string }).message).toMatch(/the latest is 2/);

    const adopted = await api.send('POST', PATH, { ...admin, body: { base_version: 2 } });
    expect([adopted.status, adopted.json]).toEqual([201, { id: 'conductor', version: 3 }]);
    const row = await db.pool.query<{ definition: unknown; created_by: string | null }>(
      "SELECT definition, created_by FROM workflow_definition WHERE id = 'conductor' AND version = 3",
    );
    expect(isShippedDefinition(row.rows[0]!.definition, newestShippedConductor())).toBe(true);
    expect(row.rows[0]!.created_by).toMatch(/^web:/);

    const detail = await api.send('GET', API_PATHS.workflow('conductor'), admin);
    expect(detail.json).toMatchObject({ version: 3, default_available: null });
    expect((await api.send('GET', PATH, admin)).status).toBe(404);
  });
});
