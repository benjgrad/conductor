// ADR-0033 P3: /api/change-proposals (password mode): the board's list, detail, Apply, Reject and
// Review of the advisor's proposals. Routing, the account scope and the HTTP mapping of the
// store's refusals are under test; the store itself is covered by advisor.proposals.test.ts.
// Needs `pnpm db:up`.
import { API_PATHS, CONDUCTOR_V4_DEF } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createProposal, type ProposalActor } from '../src/advisor/proposals.js';
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

async function signIn(t: TestApi, admin = false) {
  const u = await createUser(db.pool, { password: PASSWORD, ...(admin ? { admin: true } : {}) });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId, email: u.email };
}

const META = {
  title: 'Build in m-one',
  rationale: 'No root package.json.',
  evidence: [{ text: '3 of 3 failed' }],
  expected_effect: { metric: 'check_failure_rate', direction: 'down', text: 'Stops failing.' },
  rollback: 'Clear them.',
};

async function proposeRepo(accountId: string, repo: string) {
  const actor: ProposalActor = { accountId, by: 'mcp:x', mayEditWorkflows: false };
  const res = await createProposal(db.pool, actor, {
    ...META,
    change: { kind: 'repo_checks', repo, checks: { checks: [{ name: 'b', cmd: 'make' }] } },
  });
  if (!res.ok) throw new Error(res.message);
  return res.value.id;
}

describe('/api/change-proposals', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    expect((await api.send('GET', API_PATHS.changeProposals)).status).toBe(401);
  });

  it('lists, shows, applies and rejects inside the account', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const one = await proposeRepo(a.accountId, 'github.com/acme/rest-one');
    const two = await proposeRepo(a.accountId, 'github.com/acme/rest-two');
    const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
    const post = (who: { cookie: string }, path: string) =>
      api!.send('POST', path, { ...as(who), body: {} });

    const list = await api.send('GET', `${API_PATHS.changeProposals}?status=proposed`, as(a));
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ total: 2, next_cursor: null });
    expect((await api.send('GET', API_PATHS.changeProposals, as(b))).json).toMatchObject({
      total: 0,
    });
    expect((await api.send('GET', `${API_PATHS.changeProposals}?status=nope`, as(a))).status).toBe(
      400,
    );

    const detail = await api.send('GET', API_PATHS.changeProposal(one), as(a));
    expect(detail.json).toMatchObject({ id: one, status: 'proposed', diff: { more_changes: 0 } });
    expect((await api.send('GET', API_PATHS.changeProposal(one), as(b))).status).toBe(404);
    expect((await post(b, API_PATHS.changeProposalApply(one))).status).toBe(404);

    const applied = await post(a, API_PATHS.changeProposalApply(one));
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ status: 'applied', decided_by: a.email });
    const twice = await post(a, API_PATHS.changeProposalApply(one));
    expect([twice.status, (twice.json.error as { code: string }).code]).toEqual([
      409,
      'wrong_state',
    ]);
    const review = await post(a, API_PATHS.changeProposalReview(one));
    expect(review.json).toMatchObject({ review: { too_early: true } });

    const rejected = await post(a, API_PATHS.changeProposalReject(two));
    expect(rejected.json).toMatchObject({ status: 'rejected' });
    expect((await post(a, API_PATHS.changeProposalReview(two))).status).toBe(409);
  });

  it('a workflow change needs an instance admin', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const member = await signIn(api);
    const def = { ...structuredClone(CONDUCTOR_V4_DEF), id: 'rest_wf' } as unknown as {
      states: Record<string, { title?: string }>;
    };
    await db.pool.query(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('rest_wf', 1, $1)",
      [JSON.stringify({ ...def, version: 1 })],
    );
    const first = Object.keys(def.states)[0]!;
    def.states[first]!.title = 'Renamed';
    const res = await createProposal(
      db.pool,
      { accountId: member.accountId, by: 'mcp:x', mayEditWorkflows: false },
      {
        ...META,
        change: { kind: 'workflow', workflow_id: 'rest_wf', base_version: 1, definition: def },
      },
    );
    if (!res.ok) throw new Error(res.message);
    expect(res.value.warning).toMatch(/every account/);
    const denied = await api.send('POST', API_PATHS.changeProposalApply(res.value.id), {
      headers: { cookie: member.cookie },
      body: {},
    });
    expect([denied.status, (denied.json.error as { code: string }).code]).toEqual([
      403,
      'forbidden',
    ]);
  });
});
