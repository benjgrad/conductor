// MA-T08a E2E (ADR-0033 P3, the workflow advisor): the real orchestrator and daemon bins (the same
// stack as m1.e2e.test.ts), driven over MCP the way a coordinator (claude.ai, Claude Code) would:
// list_findings → propose_change (one repo's checks) → nothing changed yet → apply_change after
// the user's confirm → get_repo_checks shows it → list_change_proposals reviews it (too early).
//
// The history the finding comes from (three failed `npm run build` runs on one repo) is written
// straight into the stack's database, like the engine writes it (`event` + `outbox` rows on
// finished sessions): producing it through three real ticket runs would add a minute and test
// nothing more here (the engine's check runs have their own e2e in m1/m1b). The MCP token is
// minted in the database for the local user, as the OAuth flow would (oauth-mcp.test.ts covers
// that flow). The insight-job half (fake Claude returning a canned insight) is MA-T08b: the TS
// daemon refuses `assistant_job`, so it needs the Rust daemon on this stack (MR-T16).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_ACCOUNT_ID, LOCAL_USER_ID } from '../packages/shared/src/index.js';
import { Stack } from './harness/stack.js';

const REPO = 'github.com/acme/advisor-e2e';
const BUILD = 'npm run build';
const CHECKS = [{ name: 'Web build', cmd: 'cd m-one && npm ci && npm run build' }];

let stack: Stack;
let token = '';

/** One finished ticket on REPO whose `npm run build` check failed `daysAgo` days back. */
async function failedBuild(daysAgo: number) {
  const q = stack.db.pool;
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const wf = await q.query<{ version: number }>(
    "SELECT max(version) AS version FROM workflow_definition WHERE id = 'conductor'",
  );
  const t = await q.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, body, workflow_id, status, kind) ' +
      "VALUES ($1, $2, 'Old ticket', 'B', 'conductor', 'done', 'work') RETURNING id",
    [LOCAL_ACCOUNT_ID, REPO],
  );
  const s = await q.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status, ' +
      "workflow_state) VALUES ($1, $2, 'conductor', $3, 'done', 'done') RETURNING id",
    [LOCAL_ACCOUNT_ID, t.rows[0]!.id, wf.rows[0]!.version],
  );
  const commandId = randomUUID();
  await q.query(
    "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, 'machine:gone', 'run_cmd', $2, $3, $4)",
    [commandId, s.rows[0]!.id, JSON.stringify({ state: 'implementing', cmd: BUILD }), at],
  );
  await q.query(
    "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
    [s.rows[0]!.id, JSON.stringify({ command_id: commandId, exit_code: 1, timed_out: false }), at],
  );
}

/** An access token for the local user, stored like the OAuth token endpoint stores one. */
async function mintToken(): Promise<string> {
  const q = stack.db.pool;
  const clientId = randomUUID();
  await q.query('INSERT INTO oauth_client (id, name, redirect_uris) VALUES ($1, $2, $3)', [
    clientId,
    'e2e coordinator',
    ['http://127.0.0.1:9/callback'],
  ]);
  const access = `cnd_at_${randomBytes(32).toString('base64url')}`;
  await q.query(
    'INSERT INTO oauth_token (token_hash, kind, grant_id, client_id, account_id, user_id, ' +
      "created_at, expires_at) VALUES ($1, 'access', $2, $3, $4, $5, now(), now() + interval '1 hour')",
    [
      createHash('sha256').update(access).digest(),
      randomUUID(),
      clientId,
      LOCAL_ACCOUNT_ID,
      LOCAL_USER_ID,
    ],
  );
  return access;
}

let rpcId = 0;
/** tools/call over the real /mcp endpoint → the tool's JSON and whether it is an error. */
async function call(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${stack.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  const text = body.result.content[0]!.text;
  return {
    isError: body.result.isError === true,
    body: (text.startsWith('{') ? JSON.parse(text) : { text }) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  stack = new Stack();
  await stack.start();
  token = await mintToken();
  for (const d of [1, 2, 3]) await failedBuild(d);
});

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('workflow advisor over MCP (ADR-0033 P3)', () => {
  it('finding → proposal → confirm → apply → the repo’s checks → review', async () => {
    const found = await call('list_findings', { repo: REPO });
    expect(found.isError).toBe(false);
    const findings = found.body.findings as { id: string; category: string }[];
    const failing = findings.find((f) => f.category === 'failing_check');
    expect(failing?.id).toContain(BUILD);

    const proposed = await call('propose_change', {
      title: 'Build the web app inside m-one',
      change: { kind: 'repo_checks', repo: REPO, checks: { checks: CHECKS } },
      rationale: 'The repo has no root package.json, so the default build always fails.',
      evidence: [{ finding_id: failing!.id, text: '3 of 3 build runs failed' }],
      expected_effect: {
        metric: 'check_failure_rate',
        scope: { check: BUILD },
        direction: 'down',
        text: 'The build check stops failing.',
      },
      rollback: 'clear_repo_checks for the repo.',
    });
    expect(proposed.body).toMatchObject({ status: 'proposed', target: REPO });
    const id = proposed.body.id as string;
    expect((await call('get_repo_checks', { repo: REPO })).body.override).toBeNull();

    // The coordinator asked the user; they said yes.
    const applied = await call('apply_change', { id, confirm: true });
    expect(applied.body).toMatchObject({ status: 'applied' });
    expect(typeof applied.body.decided_by).toBe('string');
    const checks = await call('get_repo_checks', { repo: REPO });
    expect((checks.body.override as { checks: unknown }).checks).toEqual(CHECKS);
    const effective = checks.body.effective as { source: string }[];
    expect(effective.length).toBeGreaterThan(0);
    expect(effective.every((g) => g.source === 'override')).toBe(true);

    const again = await call('apply_change', { id, confirm: true });
    expect([again.isError, (again.body.error as { code: string }).code]).toEqual([
      true,
      'already_applied',
    ]);
    const reviewed = await call('list_change_proposals', { id });
    expect(reviewed.body).toMatchObject({ status: 'applied', review: { too_early: true } });
  });
});
