import { randomUUID } from 'node:crypto';
import { CONDUCTOR_V4_DEF, processMetrics, rankFindings } from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAdvisorRows } from '../src/advisor/queries.js';
import { useTestDatabase } from './db.js';

// ADR-0033: the advisor's SQL is what's under test (the account scope through `session`, the
// window and the joins), so this runs against a real migrated database. The metrics themselves
// are covered by pure tests in shared (advisor/metrics.test.ts).

const db = useTestDatabase();
const NOW = new Date('2026-11-03T12:00:00.000Z');
const daysAgo = (d: number, plusMin = 0) =>
  new Date(NOW.getTime() - d * 86_400_000 + plusMin * 60_000);

async function account(name: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO account (name) VALUES ($1) RETURNING id',
    [name],
  );
  return r.rows[0]!.id;
}

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

/**
 * A finished ticket that went planning → implementing → done starting `ago` days back, with one
 * failing check, one question and one denied permission prompt. Event, input and outbox rows get
 * the default (TD-109) account like the engine writes them, so only the session scopes them.
 */
async function history(accountId: string, machineId: string, repo: string, ago: number) {
  const t = await db.pool.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, body, workflow_id, status, kind) ' +
      "VALUES ($1, $2, 'T', 'B', 'conductor', 'done', 'work') RETURNING id",
    [accountId, repo],
  );
  const ticketId = t.rows[0]!.id;
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, ' +
      "status, workflow_state) VALUES ($1, $2, $3, 'conductor', 1, 'done', 'done') RETURNING id",
    [accountId, ticketId, machineId],
  );
  const sessionId = s.rows[0]!.id;
  const move = (to: string, from: string | null, min: number, transition?: string) =>
    db.pool.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3)",
      [sessionId, JSON.stringify({ from, to, visit: 1, transition }), daysAgo(ago, min)],
    );
  await move('planning', null, 0);
  await move('implementing', 'planning', 30, 'plan_ready');
  await move('done', 'implementing', 90, 'pr_ready_for_review');

  const commandId = randomUUID();
  await db.pool.query(
    "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, $2, 'run_cmd', $3, $4, $5)",
    [
      commandId,
      `machine:${machineId}`,
      sessionId,
      JSON.stringify({ state: 'implementing', cmd: 'npm test', cwd: null, timeout_ms: null }),
      daysAgo(ago, 80),
    ],
  );
  await db.pool.query(
    "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
    [
      sessionId,
      JSON.stringify({ command_id: commandId, exit_code: 1, timed_out: false, output_tail: '' }),
      daysAgo(ago, 85),
    ],
  );
  await db.pool.query(
    'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at, ' +
      "answered_at, answer) VALUES ($1, $2, 'agent_question', 'Which DB?', 'planning', $3, $4, 'pg')",
    [randomUUID(), sessionId, daysAgo(ago, 10), daysAgo(ago, 20)],
  );
  await db.pool.query(
    'INSERT INTO permission_request (id, account_id, session_id, machine_id, fencing_token, tool, ' +
      'input, always_rule, status, behavior, scope, created_at, resolved_at, expires_at) VALUES ' +
      "($1, $2, $3, $4, 1, 'Bash', '{}', 'Bash(pnpm i)', 'denied', 'deny', 'once', $5, $6, $6)",
    [randomUUID(), accountId, sessionId, machineId, daysAgo(ago, 40), daysAgo(ago, 70)],
  );
  return ticketId;
}

describe('loadAdvisorRows (ADR-0033)', () => {
  let a = '';
  let b = '';
  let recent = '';
  let old = '';
  let otherRepo = '';

  beforeAll(async () => {
    await db.pool.query(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 1, $1) " +
        'ON CONFLICT DO NOTHING',
      [JSON.stringify(CONDUCTOR_V4_DEF)],
    );
    a = await account('A');
    b = await account('B');
    const ma = await machine(a);
    const mb = await machine(b);
    recent = await history(a, ma, 'github.com/acme/app', 5);
    old = await history(a, ma, 'github.com/acme/app', 45);
    otherRepo = await history(a, ma, 'github.com/acme/api', 2);
    await history(b, mb, 'github.com/acme/app', 1);
  });

  it('reads only the account’s rows, inside the window', async () => {
    const rows = await loadAdvisorRows(db.pool, { accountId: a, windowDays: 30, now: NOW });
    const tickets = (list: { ticket_id: string }[]) =>
      [...new Set(list.map((r) => r.ticket_id))].sort();
    const expected = [recent, otherRepo].sort();
    expect(tickets(rows.moves)).toEqual(expected);
    expect(tickets(rows.checks)).toEqual(expected);
    expect(tickets(rows.inputs)).toEqual(expected);
    expect(tickets(rows.permissions)).toEqual(expected);
    expect(rows.truncated).toEqual([]);
    expect(rows.checks[0]).toMatchObject({
      cmd: 'npm test',
      state: 'implementing',
      exit_code: 1,
      timed_out: false,
    });
    expect(rows.inputs[0]).toMatchObject({ state: 'planning', kind: 'agent_question' });
    expect(rows.permissions[0]).toMatchObject({ tool: 'Bash', status: 'denied' });
  });

  it('widens with the window, and filters by repo case-insensitively', async () => {
    const wide = await loadAdvisorRows(db.pool, { accountId: a, windowDays: 60, now: NOW });
    expect(new Set(wide.moves.map((m) => m.ticket_id))).toEqual(new Set([recent, old, otherRepo]));
    const one = await loadAdvisorRows(db.pool, {
      accountId: a,
      windowDays: 60,
      repo: 'GitHub.com/ACME/api',
      now: NOW,
    });
    expect(new Set(one.moves.map((m) => m.ticket_id))).toEqual(new Set([otherRepo]));
  });

  it('`until` ends the window in the past (the review’s before-window)', async () => {
    const rows = await loadAdvisorRows(db.pool, {
      accountId: a,
      windowDays: 40,
      until: daysAgo(3),
    });
    expect(new Set(rows.moves.map((m) => m.ticket_id))).toEqual(new Set([recent]));
    expect(new Set(rows.checks.map((m) => m.ticket_id))).toEqual(new Set([recent]));
    expect(new Set(rows.inputs.map((m) => m.ticket_id))).toEqual(new Set([recent]));
    expect(new Set(rows.permissions.map((m) => m.ticket_id))).toEqual(new Set([recent]));
    expect(rows.since).toBe(daysAgo(43).toISOString());
  });

  it('feeds the metrics end to end', async () => {
    const rows = await loadAdvisorRows(db.pool, { accountId: b, windowDays: 30, now: NOW });
    const m = processMetrics(rows, 'state');
    expect(m.groups.map((g) => [g.key, g.median_minutes])).toEqual([
      ['implementing', 60],
      ['planning', 30],
    ]);
    expect(m.groups[0]).toMatchObject({ check_runs: 1, check_failures: 1 });
    // One ticket per account is below every finding's minimum.
    expect(rankFindings(rows)).toEqual([]);
  });
});
