import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONDUCTOR_V4_DEF } from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { advisorAccount, advisorMachine } from './advisor-fixtures.js';
import { useTestDatabase } from './db.js';

// scripts/analysis/notification-baseline.sql (the M3 notification baseline). What's under test is
// the SQL itself: the joins over outbox, input_request, permission_request and state.entered, and
// the window functions behind the flags and the v6 estimate. That needs a real migrated database.

const SQL = readFileSync(
  new URL('../../../scripts/analysis/notification-baseline.sql', import.meta.url),
  'utf8',
);

const db = useTestDatabase();
const NOW = new Date('2026-11-03T12:00:00.000Z');
// Two days back, on a 15-minute boundary, so the coalesce buckets are predictable.
const T0 = NOW.getTime() - 2 * 86_400_000;
const at = (min: number) => new Date(T0 + min * 60_000);

type Report = Record<string, Record<string, unknown>>;

/** Runs the script on one client with `settings` applied, the way psql would with PGOPTIONS. */
async function report(settings: Record<string, string> = {}): Promise<Report> {
  const client = await db.pool.connect();
  try {
    const sets = Object.entries({ until: NOW.toISOString(), ...settings })
      .map(([k, v]) => `SET notification_baseline.${k} = '${v}';`)
      .join('\n');
    const results = (await client.query(`${sets}\n${SQL}`)) as unknown as {
      rows: { report?: string }[];
    }[];
    const row = results.find((r) => r.rows[0]?.report !== undefined);
    return JSON.parse(row!.rows[0]!.report!) as Report;
  } finally {
    await client.query('RESET ALL');
    client.release();
  }
}

describe('notification baseline on a fresh database', () => {
  it('runs cleanly with no history', async () => {
    const r = await report();
    expect(r.legacy).toMatchObject({
      pushes: 0,
      tickets: 0,
      by_kind: {},
      by_cause: {},
      handoff_share: null,
      per_ticket: { median: null, p90: null, max: null },
      noisiest: [],
    });
    expect(r.outbox).toMatchObject({ pushes: 0, deliveries: 0, first_push_at: null });
    expect(r.v6_estimate).toMatchObject({ pushes: 0, reduction: null });
  });
});

describe('notification baseline over a seeded history', () => {
  let ticketA = '';
  let ticketB = '';

  beforeAll(async () => {
    const q = (sql: string, params: unknown[]) => db.pool.query(sql, params);
    await q(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 1, $1) " +
        'ON CONFLICT DO NOTHING',
      [JSON.stringify(CONDUCTOR_V4_DEF)],
    );
    const account = await advisorAccount(db.pool, 'Baseline');
    const machine = await advisorMachine(db.pool, account);
    const ticket = async (title: string) => {
      const t = await q(
        'INSERT INTO ticket (account_id, repo, title, workflow_id, status, kind) ' +
          "VALUES ($1, 'github.com/acme/app', $2, 'conductor', 'done', 'personal') RETURNING id",
        [account, title],
      );
      const id = (t.rows[0] as { id: string }).id;
      const s = await q(
        'INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, ' +
          "status, workflow_state) VALUES ($1, $2, $3, 'conductor', 1, 'running', 'implementing') " +
          'RETURNING id',
        [account, id, machine],
      );
      return { ticketId: id, sessionId: (s.rows[0] as { id: string }).id };
    };
    // Rows go in in time order: the opening-move join picks the newest event id up to the request.
    const move = async (
      sessionId: string,
      min: number,
      m: { from: string | null; to: string; transition?: string; actor?: string },
    ) => {
      const r = await q(
        "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3) " +
          'RETURNING id',
        [sessionId, JSON.stringify({ visit: 1, ...m }), at(min)],
      );
      return Number((r.rows[0] as { id: string }).id);
    };
    const push = (
      sessionId: string,
      ticketId: string,
      min: number,
      key: string,
      payload: Record<string, unknown>,
      kind = 'push_needs_input',
      user = 'user:00000000-0000-4000-8000-0000000000aa',
    ) =>
      q(
        'INSERT INTO outbox (account_id, command_id, target, kind, session_id, payload, ' +
          "idempotency_key, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'acked', $8)",
        [
          account,
          randomUUID(),
          user,
          kind,
          sessionId,
          JSON.stringify({ ticket_id: ticketId, notification: null, delivered: [], ...payload }),
          key,
          at(min),
        ],
      );
    const ask = async (
      s: { ticketId: string; sessionId: string },
      min: number,
      kind: string,
      answeredMin: number | null,
    ) => {
      const id = randomUUID();
      await q(
        'INSERT INTO input_request (account_id, id, session_id, kind, question, created_at, ' +
          "answered_at, answer) VALUES ($1, $2, $3, $4, 'Q', $5, $6, $7)",
        [
          account,
          id,
          s.sessionId,
          kind,
          at(min),
          answeredMin === null ? null : at(answeredMin),
          answeredMin === null ? null : 'ok',
        ],
      );
      await push(s.sessionId, s.ticketId, min, id, { input_request_id: id });
      return id;
    };

    // Ticket A: a hand-off, a second hand-off 7 min later (a human-started lap back into Needs
    // input, in the next 15-min bucket), an engine lap (the engine left the wait and
    // retries_exhausted landed back in it), an engine `notify` transition, and an ask_user.
    const a = await ticket('Alpha');
    ticketA = a.ticketId;
    const gate = 'implementing → needs_input (move: personal_pr_ready_for_review)';
    const handoff = { transition: 'personal_pr_ready_for_review', actor: 'agent' };
    await move(a.sessionId, 0, { from: null, to: 'implementing' });
    await move(a.sessionId, 9, { from: 'implementing', to: gate, ...handoff });
    await move(a.sessionId, 10, { from: gate, to: 'needs_input', ...handoff });
    await ask(a, 10, 'agent_question', 12);
    await move(a.sessionId, 12, { from: 'needs_input', to: 'implementing', actor: 'human' });
    await move(a.sessionId, 17, { from: gate, to: 'needs_input', ...handoff });
    await ask(a, 17, 'agent_question', 20);
    await move(a.sessionId, 20, {
      from: 'needs_input',
      to: 'implementing',
      transition: 'requirements_unmet',
      actor: 'engine',
    });
    await move(a.sessionId, 25, {
      from: 'implementing',
      to: 'needs_input',
      transition: 'retries_exhausted',
      actor: 'engine',
    });
    await ask(a, 25, 'retries_exhausted', 30);
    await move(a.sessionId, 30, { from: 'needs_input', to: 'implementing', actor: 'human' });
    const engineMove = await move(a.sessionId, 40, {
      from: 'implementing',
      to: 'implementing',
      transition: 'step_failed',
      actor: 'engine',
    });
    await push(
      a.sessionId,
      a.ticketId,
      40,
      `transition:${engineMove}`,
      { event_id: engineMove },
      'push_transition',
    );
    await move(a.sessionId, 70, {
      from: 'implementing',
      to: 'needs_input',
      transition: 'ask_user',
      actor: 'agent',
    });
    await ask(a, 70, 'agent_question', 75);

    // Ticket B: a timeout, a question in the same 15-min bucket fanned out to two users, a
    // permission prompt, a permission refused because no agent ran (never pushed), and a
    // request from before the window.
    const b = await ticket('Beta');
    ticketB = b.ticketId;
    const old = randomUUID();
    await q(
      'INSERT INTO input_request (account_id, id, session_id, kind, question, created_at) ' +
        "VALUES ($1, $2, $3, 'agent_question', 'Old', $4)",
      [account, old, b.sessionId, at(-70 * 24 * 60)],
    );
    await push(b.sessionId, b.ticketId, -70 * 24 * 60, old, { input_request_id: old });
    await move(b.sessionId, 0, { from: 'planning', to: 'needs_input' });
    await ask(b, 0, 'timeout', 3);
    await move(b.sessionId, 3, { from: 'needs_input', to: 'planning', actor: 'human' });
    await move(b.sessionId, 5, {
      from: 'planning',
      to: 'needs_input',
      transition: 'ask_user',
      actor: 'agent',
    });
    const fanned = await ask(b, 5, 'agent_question', 6);
    await push(
      b.sessionId,
      b.ticketId,
      5,
      fanned,
      { input_request_id: fanned },
      'push_needs_input',
      'user:00000000-0000-4000-8000-0000000000bb',
    );
    await move(b.sessionId, 6, { from: 'needs_input', to: 'planning', actor: 'human' });
    const perm = randomUUID();
    const permission = (id: string, min: number, status: string, extra: string) =>
      q(
        'INSERT INTO permission_request (id, account_id, session_id, machine_id, fencing_token, ' +
          'tool, input, status, behavior, scope, message, created_at, resolved_at, expires_at) ' +
          `VALUES ($1, $2, $3, $4, 1, 'Bash', '{}', $5, ${extra}, $6, $6, $6)`,
        [id, account, b.sessionId, machine, status, at(min)],
      );
    await permission(perm, 8, 'allowed', "'allow', 'once', NULL");
    await push(b.sessionId, b.ticketId, 8, `permission:${perm}`, { permission_request_id: perm });
    await permission(
      randomUUID(),
      9,
      'denied',
      "'deny', 'once', 'the session is not running an agent'",
    );
  });

  it('counts the legacy pushes by kind, cause, day and ticket', async () => {
    const r = await report();
    expect(r.legacy).toMatchObject({
      pushes: 8,
      tickets: 2,
      by_kind: { needs_input: 6, permission: 1, transition: 1 },
      by_cause: {
        handoff: { pushes: 2, same_state: 1, reentry: 1 },
        question: { pushes: 2, same_state: 1, reentry: 1 },
        retries_exhausted: { pushes: 1, same_state: 1, reentry: 1 },
        timeout: { pushes: 1, same_state: 0, reentry: 0 },
        permission: { pushes: 1, same_state: 0, reentry: 0 },
        transition_engine: { pushes: 1, same_state: 0, reentry: 0 },
      },
      by_day: { [at(0).toISOString().slice(0, 10)]: 8 },
      per_ticket: { median: 4, p90: 4.8, max: 5 },
      handoff_share: 0.25,
      same_state_share: 0.375,
      reentry_share: 0.375,
    });
    const noisiest = r.legacy!.noisiest as { ticket_id: string; pushes: number; why: string }[];
    expect(noisiest.map((n) => [n.ticket_id, n.pushes])).toEqual([
      [ticketA, 5],
      [ticketB, 3],
    ]);
    expect(noisiest[0]).toMatchObject({
      title: 'Alpha',
      v6_estimate: 2,
      why:
        'handoff ×2, question ×1, retries_exhausted ×1, transition_engine ×1; ' +
        'back into the same state 2, of them within the coalesce window 2',
    });
  });

  it('reports the outbox as enqueued: pushes vs per-user deliveries, inside the window', async () => {
    const r = await report();
    expect(r.outbox).toMatchObject({
      pushes: 8,
      deliveries: 9,
      failed_deliveries: 0,
      by_kind: { needs_input: 6, permission: 1, transition: 1 },
    });
    expect(new Date(r.outbox!.first_push_at as string)).toEqual(at(0));
    expect(r.coverage).toEqual({
      legacy_pushes_since_first_outbox_push: 8,
      of_them_in_outbox: 8,
      permissions_since_first_outbox_push: 1,
      permissions_in_outbox: 1,
    });
  });

  it('replays the v6 policy: once per transition, every question, engine moves silent', async () => {
    const r = await report();
    // A: the first hand-off (once) and the ask_user (every); its second hand-off is a once
    // repeat, the retries_exhausted stop and the engine transition are engine moves. B: the
    // ask_user and the permission prompt; the timeout is an engine stop.
    expect(r.v6_estimate).toMatchObject({
      pushes: 4,
      reduction: 0.5,
      by_cause: { handoff: 1, question: 2, permission: 1 },
      by_via: { personal_pr_ready_for_review: 1, ask_user: 2 },
      dropped: { engine_moves: 3, once_repeats: 1, coalesced: 0 },
      per_ticket: { median: 2, max: 2 },
      what_if: { without_handoffs: 3, without_same_state_returns: 3 },
    });
  });

  it('honours the window settings', async () => {
    expect((await report({ days: '1' })).legacy!.pushes).toBe(0);
    // From minute 30: ticket A's engine transition (40) and ask_user (70).
    expect((await report({ since: at(30).toISOString() })).legacy!.pushes).toBe(2);
  });
});
