// UXR-84: /api/insights (password mode): the board's read-only view of the advisor's metrics,
// findings, report and session insights. Routing, the account scope, query validation and the
// finding → proposal link are under test; the reads themselves are the MCP tools' (advisor/read.ts,
// covered by advisor.queries.test.ts and mcp/tools.unit.test.ts). Needs `pnpm db:up`.
import {
  API_PATHS,
  CONDUCTOR_V4_DEF,
  FindingsResponseSchema,
  ProcessMetricsResponseSchema,
  ProcessReportResponseSchema,
  SessionInsightResponseSchema,
} from '@conductor/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProposal } from '../src/advisor/proposals.js';
import { advisorHistory, advisorMachine, insertInsight } from './advisor-fixtures.js';
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

beforeAll(async () => {
  await db.pool.query(
    "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 1, $1) " +
      'ON CONFLICT DO NOTHING',
    [JSON.stringify(CONDUCTOR_V4_DEF)],
  );
});

async function signIn(t: TestApi) {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });

/** `n` finished tickets for the account, each with a failing `npm test`, in the last week. */
async function seed(accountId: string, n: number, repo = 'github.com/acme/app') {
  const m = await advisorMachine(db.pool, accountId);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      await advisorHistory(db.pool, { accountId, machineId: m, repo, ago: i + 1, now: new Date() }),
    );
  }
  return out;
}

const FAILING = 'failing_check:npm test';

async function propose(accountId: string, findingId: string) {
  const res = await createProposal(
    db.pool,
    { accountId, by: 'mcp:x', mayEditWorkflows: false },
    {
      title: 'Fix the test check',
      change: {
        kind: 'repo_checks',
        repo: 'github.com/acme/app',
        checks: { checks: [{ name: 'b', cmd: 'make' }] },
      },
      rationale: 'It always fails.',
      evidence: [{ finding_id: findingId, text: '3 of 3 failed' }],
      expected_effect: { metric: 'check_failure_rate', direction: 'down', text: 'Stops.' },
      rollback: 'Clear them.',
    },
  );
  if (!res.ok) throw new Error(res.message);
  return res.value.id;
}

describe('/api/insights', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    for (const path of [
      API_PATHS.insightsMetrics,
      API_PATHS.insightsFindings,
      API_PATHS.insightsReport,
      API_PATHS.insightSession('00000000-0000-4000-8000-000000000001'),
    ]) {
      expect((await api.send('GET', path)).status, path).toBe(401);
    }
  });

  it('metrics: the account’s rows only, grouped, the window clamped; bad queries are 400', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    await seed(a.accountId, 2, 'github.com/acme/app');
    await seed(a.accountId, 1, 'github.com/acme/api');
    await seed(b.accountId, 1);

    const res = await api.send('GET', `${API_PATHS.insightsMetrics}?window_days=30`, as(a));
    expect(res.status).toBe(200);
    const body = ProcessMetricsResponseSchema.parse(res.json);
    expect(body).toMatchObject({ window_days: 30, group_by: 'state' });
    expect(body.totals.tickets).toBe(3);
    expect(body.groups.map((g) => g.key).sort()).toEqual(['implementing', 'planning']);

    const byRepo = ProcessMetricsResponseSchema.parse(
      (await api.send('GET', `${API_PATHS.insightsMetrics}?group_by=repo`, as(a))).json,
    );
    expect(byRepo.groups.map((g) => g.key).sort()).toEqual([
      'github.com/acme/api',
      'github.com/acme/app',
    ]);
    const oneRepo = ProcessMetricsResponseSchema.parse(
      (await api.send('GET', `${API_PATHS.insightsMetrics}?repo=github.com/acme/api`, as(a))).json,
    );
    expect(oneRepo.totals.tickets).toBe(1);

    const wide = (await api.send('GET', `${API_PATHS.insightsMetrics}?window_days=9999`, as(a)))
      .json as { window_days: number };
    expect(wide.window_days).toBe(180);

    const other = ProcessMetricsResponseSchema.parse(
      (await api.send('GET', API_PATHS.insightsMetrics, as(b))).json,
    );
    expect(other.totals.tickets).toBe(1);

    for (const bad of ['group_by=nope', 'window_days=abc', 'colour=red', 'cursor=-1']) {
      const r = await api.send('GET', `${API_PATHS.insightsMetrics}?${bad}`, as(a));
      expect(r.status, bad).toBe(400);
    }
  });

  it('findings: ranked, paged, and linked to the account’s proposal citing them', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    await seed(a.accountId, 3);
    await seed(b.accountId, 3);

    const read = async (who: { cookie: string }, qs = '') => {
      const res = await api!.send('GET', `${API_PATHS.insightsFindings}${qs}`, as(who));
      expect(res.status).toBe(200);
      return FindingsResponseSchema.parse(res.json);
    };
    const failing = (page: Awaited<ReturnType<typeof read>>) =>
      page.findings.find((f) => f.id === FAILING);

    const before = await read(a);
    expect(failing(before)).toMatchObject({ category: 'failing_check', proposal: null });
    expect(failing(before)!.example_ticket_ids).toHaveLength(3);

    // B's proposal for the same finding id is not A's.
    await propose(b.accountId, FAILING);
    expect(failing(await read(a))!.proposal).toBeNull();

    const id = await propose(a.accountId, FAILING);
    expect(failing(await read(a))!.proposal).toEqual({
      id,
      status: 'proposed',
      title: 'Fix the test check',
    });

    const page = await read(a);
    const past = await read(a, `?cursor=${page.total}`);
    expect(past).toMatchObject({ findings: [], next_cursor: null, total: page.total });
  });

  it('report: coverage, the insights-off note and the analysts’ frictions', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const [one] = await seed(a.accountId, 2);

    const off = ProcessReportResponseSchema.parse(
      (await api.send('GET', `${API_PATHS.insightsReport}?window_days=7`, as(a))).json,
    );
    expect(off).toMatchObject({
      window_days: 7,
      insights_enabled: false,
      finished_sessions: 2,
      analysed_sessions: 0,
      frictions: [],
    });
    expect(off.note).toContain('Rust daemon');

    await advisorMachine(db.pool, a.accountId, ['assistant_job']);
    await insertInsight(db.pool, {
      accountId: a.accountId,
      sessionId: one!.sessionId,
      ticketId: one!.ticketId,
    });
    const on = ProcessReportResponseSchema.parse(
      (await api.send('GET', API_PATHS.insightsReport, as(a))).json,
    );
    expect(on.insights_enabled).toBe(true);
    expect(on.note).toBeUndefined();
    expect(on.analysed_sessions).toBe(1);
    expect(on.frictions[0]).toMatchObject({
      category: 'failing_check',
      state: 'implementing',
      sessions: 1,
      session_ids: [one!.sessionId],
      ticket_ids: [one!.ticketId],
    });
  });

  it('sessions/:id: the account’s insight, else 404', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const [one, two] = await seed(a.accountId, 2);
    await insertInsight(db.pool, {
      accountId: a.accountId,
      sessionId: one!.sessionId,
      ticketId: one!.ticketId,
    });

    const res = await api.send('GET', API_PATHS.insightSession(one!.sessionId), as(a));
    expect(res.status).toBe(200);
    expect(SessionInsightResponseSchema.parse(res.json)).toMatchObject({
      session_id: one!.sessionId,
      ticket_id: one!.ticketId,
      model: 'haiku',
      model_written: true,
      outcome: 'completed',
    });

    for (const [who, id] of [
      [b, one!.sessionId],
      [a, two!.sessionId],
      [a, 'not-a-uuid'],
    ] as const) {
      expect((await api.send('GET', API_PATHS.insightSession(id), as(who))).status).toBe(404);
    }
  });
});
