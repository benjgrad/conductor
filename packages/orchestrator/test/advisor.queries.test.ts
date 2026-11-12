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

  it('R3: reads a skipped check as skipped, counted apart from runs', async () => {
    const r3 = await account('R3');
    const m3 = await machine(r3);
    const { sessionId } = await advisorHistory(db.pool, {
      accountId: r3,
      machineId: m3,
      repo: 'github.com/acme/app',
      ago: 2,
      now: NOW,
    });
    const commandId = randomUUID();
    await db.pool.query(
      "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, $2, 'run_cmd', $3, $4, $5)",
      [
        commandId,
        `machine:${m3}`,
        sessionId,
        JSON.stringify({ command_id: commandId, workflow_state: 'x', cmd: 'cargo nextest run' }),
        daysAgo(2, 61),
      ],
    );
    await db.pool.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
      [
        sessionId,
        JSON.stringify({
          command_id: commandId,
          exit_code: 0,
          timed_out: false,
          skipped: 'no changes match paths: crates/**',
        }),
        daysAgo(2, 62),
      ],
    );
    const rows = await loadAdvisorRows(db.pool, { accountId: r3, windowDays: 30, now: NOW });
    const cargo = rows.checks.filter((r) => r.cmd === 'cargo nextest run');
    expect(cargo.map((r) => r.skipped)).toEqual([true]);
    expect(rows.checks.filter((r) => r.cmd !== 'cargo nextest run').every((r) => !r.skipped)).toBe(
      true,
    );
    const totals = processMetrics(rows, 'state').totals;
    expect(totals.check_skips).toBe(1);
    expect(totals.check_runs).toBe(rows.checks.length - 1);
  });

  it('counts review answers that equal a saved reply of the pinned definition (ADR-0037 P5)', async () => {
    const d = await account('D');
    const md = await machine(d);
    const v2 = structuredClone(CONDUCTOR_V4_DEF) as typeof CONDUCTOR_V4_DEF & {
      instructions?: Record<string, string>;
    };
    v2.version = 2;
    v2.instructions = { resync_main: 'Merge main, then finish again.' };
    const answer = v2.states.needs_input!;
    if (answer.type !== 'human') throw new Error('needs_input is a human state');
    answer.on = {
      ...answer.on,
      answer: { goto: '$return_to', actor: 'human', text: 'required', presets: ['resync_main'] },
    };
    await db.pool.query(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 2, $1) " +
        'ON CONFLICT DO NOTHING',
      [JSON.stringify(v2)],
    );
    const gate = moveStateLabel('implementing', 'needs_input', 'personal_pr_ready_for_review');
    const handoff = async (text: string, ago: number) => {
      const { sessionId } = await advisorHistory(db.pool, {
        accountId: d,
        machineId: md,
        repo: 'github.com/acme/app',
        ago,
        now: NOW,
      });
      await db.pool.query('UPDATE session SET workflow_version = 2 WHERE id = $1', [sessionId]);
      const at = daysAgo(ago, 60);
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
          }),
          at,
        ],
      );
      await db.pool.query(
        'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at, ' +
          "answer, answered_by, answered_at) VALUES ($1, $2, 'agent_question', 'PR ready.', $3, $4, $5, 'ben', $4)",
        [randomUUID(), sessionId, gate, new Date(at.getTime() + 1_000), text],
      );
    };
    await handoff('  Merge main, then finish again.\n', 2);
    await handoff('Please rebase', 3);

    const rows = await loadAdvisorRows(db.pool, { accountId: d, windowDays: 30, now: NOW });
    expect(processMetrics(rows, 'state').presets).toEqual({
      uses: [
        { workflow_id: 'conductor', slug: 'resync_main', used: 1, examples: [expect.any(String)] },
      ],
      typed: 1,
    });
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

  it('ADR-0037 P7: reads each move’s cause and actor (null on rows before it)', async () => {
    const d = await account('D');
    const md = await machine(d);
    const { sessionId } = await advisorHistory(db.pool, {
      accountId: d,
      machineId: md,
      repo: 'github.com/acme/app',
      ago: 2,
      now: NOW,
    });
    const gate = moveStateLabel('implementing', 'in_review', 'personal_pr_ready_for_review');
    await db.pool.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3)",
      [
        sessionId,
        JSON.stringify({
          from: gate,
          to: 'implementing',
          visit: 2,
          transition: 'personal_pr_ready_for_review',
          actor: 'system',
          reason: 'Build passes',
          cause: 'check_failed',
        }),
        daysAgo(2, 70),
      ],
    );
    const rows = await loadAdvisorRows(db.pool, { accountId: d, windowDays: 30, now: NOW });
    const back = rows.moves.find((m) => m.cause === 'check_failed');
    expect(back).toMatchObject({ actor: 'system', transition: 'personal_pr_ready_for_review' });
    // advisorHistory writes rows without a cause, as before P7.
    expect(rows.moves.filter((m) => m.cause === null).length).toBeGreaterThan(0);
    expect(processMetrics(rows, 'state').loops).toContainEqual(
      expect.objectContaining({
        from: 'implementing.personal_pr_ready_for_review',
        cause: 'check_failed',
      }),
    );
  });

  it('ADR-0043 FR-5: reads a triage verdict’s judged failure and breaks the verdicts down', async () => {
    const e = await account('E');
    const me = await machine(e);
    const { sessionId } = await advisorHistory(db.pool, {
      accountId: e,
      machineId: me,
      repo: 'github.com/acme/app',
      ago: 2,
      now: NOW,
    });
    const move = (to: string, transition: string, triage: unknown, min: number) =>
      db.pool.query(
        "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3)",
        [
          sessionId,
          JSON.stringify({
            from: 'triage',
            to,
            visit: 1,
            transition,
            actor: 'agent',
            cause: 'transition',
            triage,
          }),
          daysAgo(2, min),
        ],
      );
    await move(
      'implementing',
      'send_back',
      { failure_cause: 'check_failed', gate_transition: 'pr_ready' },
      80,
    );
    await move(
      'needs_input',
      'escalate',
      { failure_cause: 'timeout', gate_transition: 'pr_ready' },
      90,
    );
    await move('needs_input', 'escalate', { failure_cause: 'bogus' }, 95);
    const rows = await loadAdvisorRows(db.pool, { accountId: e, windowDays: 30, now: NOW });
    expect(rows.moves.filter((m) => m.triage != null)).toHaveLength(2);
    expect(processMetrics(rows, 'state').triage).toEqual({
      verdicts: 2,
      tickets: 1,
      by_cause: [
        { failure_cause: 'check_failed', verdict: 'send_back', count: 1, capped: 0 },
        { failure_cause: 'timeout', verdict: 'escalate', count: 1, capped: 0 },
      ],
    });
  });
});
