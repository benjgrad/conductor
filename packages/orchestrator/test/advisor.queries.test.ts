import { randomUUID } from 'node:crypto';
import { CONDUCTOR_V4_DEF, moveStateLabel, processMetrics, rankFindings } from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAdvisorRows } from '../src/advisor/queries.js';
import { advisorAccount, advisorHistory, advisorMachine } from './advisor-fixtures.js';
import { useTestDatabase } from './db.js';

// ADR-0033: the advisor's SQL is what's under test (the account scope through `session`, the
// window and the joins), so this runs against a real migrated database. The metrics themselves
// are covered by pure tests in shared (advisor/metrics.test.ts).

const db = useTestDatabase();
const NOW = new Date('2026-11-03T12:00:00.000Z');
const daysAgo = (d: number, plusMin = 0) =>
  new Date(NOW.getTime() - d * 86_400_000 + plusMin * 60_000);

const account = (name: string) => advisorAccount(db.pool, name);
const machine = (accountId: string) => advisorMachine(db.pool, accountId);
const history = async (accountId: string, machineId: string, repo: string, ago: number) =>
  (await advisorHistory(db.pool, { accountId, machineId, repo, ago, now: NOW })).ticketId;

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

  it('attributes a gate step’s checks and input to the gate, by name and class', async () => {
    const c = await account('C');
    const mc = await machine(c);
    const { sessionId, ticketId } = await advisorHistory(db.pool, {
      accountId: c,
      machineId: mc,
      repo: 'github.com/acme/app',
      ago: 2,
      now: NOW,
    });
    await db.pool.query(
      "INSERT INTO repo_checks (account_id, repo, config) VALUES ($1, 'github.com/acme/app', $2)",
      [
        c,
        JSON.stringify({ setup: 'make deps', checks: [{ name: 'Unit tests', cmd: 'npm test' }] }),
      ],
    );
    const gate = moveStateLabel('implementing', 'needs_input', 'personal_pr_ready_for_review');
    const at = daysAgo(2, 60);
    await db.pool.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3)",
      [
        sessionId,
        JSON.stringify({
          from: 'implementing',
          to: gate,
          visit: 1,
          transition: 'personal_pr_ready_for_review',
          actor: 'agent',
          reason: 'Done: PR ready.',
        }),
        at,
      ],
    );
    const commandId = randomUUID();
    await db.pool.query(
      "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, $2, 'run_cmd', $3, $4, $5)",
      [
        commandId,
        `machine:${mc}`,
        sessionId,
        JSON.stringify({ command_id: commandId, workflow_state: gate, cmd: 'npm run build' }),
        daysAgo(2, 61),
      ],
    );
    await db.pool.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
      [
        sessionId,
        JSON.stringify({
          command_id: commandId,
          exit_code: 1,
          timed_out: false,
          setup_failed: true,
        }),
        daysAgo(2, 62),
      ],
    );
    await db.pool.query(
      'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at) ' +
        "VALUES ($1, $2, 'agent_question', 'Done: PR ready.', $3, $4)",
      [randomUUID(), sessionId, gate, new Date(at.getTime() + 1_000)],
    );

    const rows = await loadAdvisorRows(db.pool, { accountId: c, windowDays: 30, now: NOW });
    expect(rows.checks.map((r) => [r.state, r.name, r.role, r.source]).sort()).toEqual([
      ['implementing', 'Unit tests', 'check', 'repo'],
      ['implementing.personal_pr_ready_for_review', 'Repo setup', 'setup', 'repo'],
    ]);
    const handoff = rows.inputs.find((i) => i.state === gate)!;
    expect(handoff).toMatchObject({
      transition: 'personal_pr_ready_for_review',
      class: 'handoff',
    });
    expect(rows.inputs.find((i) => i.state === 'planning')).toMatchObject({ class: 'question' });
    expect(processMetrics(rows, 'state').totals).toMatchObject({
      tickets: 1,
      questions: 1,
      handoffs: 1,
    });
    expect(ticketId).toBeTruthy();
  });

  it('a handoff-kind input (ADR-0037 P8) is a hand-off, not a question', async () => {
    const d = await account('D');
    const md = await machine(d);
    const { sessionId } = await advisorHistory(db.pool, {
      accountId: d,
      machineId: md,
      repo: 'github.com/acme/app',
      ago: 3,
      now: NOW,
    });
    await db.pool.query(
      'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at) ' +
        "VALUES ($1, $2, 'handoff', 'Added /health.', 'implementing', $3)",
      [randomUUID(), sessionId, daysAgo(3, 90)],
    );
    const rows = await loadAdvisorRows(db.pool, { accountId: d, windowDays: 30, now: NOW });
    expect(rows.inputs.find((i) => i.kind === 'handoff')).toMatchObject({ class: 'handoff' });
    expect(processMetrics(rows, 'state').totals).toMatchObject({ questions: 1, handoffs: 1 });
  });
});
