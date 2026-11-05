import { CONDUCTOR_V4_DEF, processMetrics, rankFindings } from '@conductor/shared';
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
});
