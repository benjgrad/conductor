import { randomUUID } from 'node:crypto';
import type { SessionInsight } from '@conductor/shared';
import type { Pool } from 'pg';

// ADR-0033 / UXR-84: the advisor's DB fixtures, shared by advisor.queries.test.ts (the SQL) and
// api.insights.test.ts (the REST routes over the same reads).

export const INSIGHT: SessionInsight = {
  schema_version: 1,
  summary: 'Built it; the build check failed once.',
  outcome: 'completed',
  frictions: [
    {
      category: 'failing_check',
      state: 'implementing',
      evidence: 'npm test failed',
      severity: 2,
      suggestion: 'Add the env var to the repo checks.',
    },
  ],
  wasted_minutes: 4,
};

export async function advisorAccount(db: Pool, name: string): Promise<string> {
  const r = await db.query<{ id: string }>('INSERT INTO account (name) VALUES ($1) RETURNING id', [
    name,
  ]);
  return r.rows[0]!.id;
}

export async function advisorMachine(
  db: Pool,
  accountId: string,
  features: string[] = [],
): Promise<string> {
  const id = randomUUID();
  await db.query(
    'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
      'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds, features) ' +
      "VALUES ($1, $2, 'Laptop', 'h', 'linux', 'x64', 8, 16000, 100000, 4, 8000, 2, 1, $3)",
    [id, accountId, features],
  );
  return id;
}

/**
 * A finished ticket that went planning → implementing → done starting `ago` days before `now`,
 * with one failing check (`npm test`), one question and one denied permission prompt. Event, input
 * and outbox rows get the default (TD-109) account like the engine writes them, so only the
 * session scopes them.
 */
export async function advisorHistory(
  db: Pool,
  o: { accountId: string; machineId: string; repo: string; ago: number; now: Date },
): Promise<{ ticketId: string; sessionId: string }> {
  const { accountId, machineId, repo, ago, now } = o;
  const daysAgo = (d: number, plusMin = 0) =>
    new Date(now.getTime() - d * 86_400_000 + plusMin * 60_000);
  const t = await db.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, body, workflow_id, status, kind) ' +
      "VALUES ($1, $2, 'T', 'B', 'conductor', 'done', 'work') RETURNING id",
    [accountId, repo],
  );
  const ticketId = t.rows[0]!.id;
  const s = await db.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, ' +
      "status, workflow_state, updated_at) VALUES ($1, $2, $3, 'conductor', 1, 'done', 'done', $4) " +
      'RETURNING id',
    [accountId, ticketId, machineId, daysAgo(ago, 90)],
  );
  const sessionId = s.rows[0]!.id;
  const move = (to: string, from: string | null, min: number, transition?: string) =>
    db.query(
      "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3)",
      [sessionId, JSON.stringify({ from, to, visit: 1, transition }), daysAgo(ago, min)],
    );
  await move('planning', null, 0);
  await move('implementing', 'planning', 30, 'plan_ready');
  await move('done', 'implementing', 90, 'pr_ready_for_review');

  const commandId = randomUUID();
  await db.query(
    "INSERT INTO outbox (command_id, target, kind, session_id, payload, created_at) VALUES ($1, $2, 'run_cmd', $3, $4, $5)",
    [
      commandId,
      `machine:${machineId}`,
      sessionId,
      // The protocol payload, as the engine service writes it (`workflow_state`).
      JSON.stringify({
        command_id: commandId,
        workflow_state: 'implementing',
        cmd: 'npm test',
        cwd: null,
        timeout_ms: null,
      }),
      daysAgo(ago, 80),
    ],
  );
  await db.query(
    "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'command.exited', $2, $3)",
    [
      sessionId,
      JSON.stringify({ command_id: commandId, exit_code: 1, timed_out: false, output_tail: '' }),
      daysAgo(ago, 85),
    ],
  );
  await db.query(
    'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at, ' +
      "answered_at, answer) VALUES ($1, $2, 'agent_question', 'Which DB?', 'planning', $3, $4, 'pg')",
    [randomUUID(), sessionId, daysAgo(ago, 10), daysAgo(ago, 20)],
  );
  await db.query(
    'INSERT INTO permission_request (id, account_id, session_id, machine_id, fencing_token, tool, ' +
      'input, always_rule, status, behavior, scope, created_at, resolved_at, expires_at) VALUES ' +
      "($1, $2, $3, $4, 1, 'Bash', '{}', 'Bash(pnpm i)', 'denied', 'deny', 'once', $5, $6, $6)",
    [randomUUID(), accountId, sessionId, machineId, daysAgo(ago, 40), daysAgo(ago, 70)],
  );
  return { ticketId, sessionId };
}

/** A stored analyst insight for one session (as handleAssistantResult writes it). */
export async function insertInsight(
  db: Pool,
  o: { accountId: string; sessionId: string; ticketId: string; insight?: SessionInsight },
): Promise<void> {
  await db.query(
    `INSERT INTO session_insight (account_id, session_id, ticket_id, schema_version, model, insight)
     VALUES ($1, $2, $3, 1, 'haiku', $4)`,
    [o.accountId, o.sessionId, o.ticketId, JSON.stringify(o.insight ?? INSIGHT)],
  );
}
