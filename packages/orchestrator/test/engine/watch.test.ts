// ADR-0037 P1 (T6): a watch on a human state through the real EngineService and sweep. Merging one
// ticket's PR ("Merged, done" from a state with conductor's PR) nudges the other watched tickets on
// the same repo, and the next sweep checks them; a broken watch moves the ticket and closes the
// question it waited on; the escalate form writes one `watch.escalated` row and one push per stay.
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import {
  LOCAL_ACCOUNT_ID,
  PR_CONTEXT_KEY,
  SNAPSHOT_FIXTURE,
  WATCH_CONTEXT_KEY,
  type EngineEvent,
} from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { InputRequestRow, OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { nudgesWatches } from '../../src/engine/watch-nudge.js';
import type { PushSender } from '../../src/push/sender.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, seedBase } from './fixtures.js';

const db = useTestDatabase();
let t = new Date('2026-11-06T12:00:00.000Z').getTime();
const now = () => new Date(t);
const MIN = 60_000;
const sender: PushSender = { send: () => Promise.resolve({ ok: true }) };

const WATCH_FLOW = {
  id: 'watch_flow',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  instructions: { resync_main: 'Merge origin/main, resolve the conflicts, finish again.' },
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash'],
      on: {
        pr_ready: { goto: 'in_review', title: 'PR ready', when: 'Done.', handoff: true },
        ask_user: 'needs_input',
      },
    },
    in_review: {
      type: 'human',
      title: 'In review',
      on: { done: { goto: 'done', title: 'Merged, done', actor: 'human' } },
      watch: {
        conditions: [{ type: 'pr_mergeable' }],
        on_broken: {
          goto: 'implementing',
          instruction: '$instructions.resync_main',
          return_to: '$self',
          retries: 3,
          else: 'needs_input',
        },
      },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: { answer: { goto: '$return_to', title: 'Answer', actor: 'human' } },
      watch: {
        conditions: [{ type: 'age_below', max: '2h' }],
        on_broken: { notify: 'escalate' },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

const make = () =>
  createEngineService({
    db: db.pool,
    boardBus: new InMemoryBoardBus(),
    now,
    push: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:o@example.test' },
    pushSender: sender,
  });

beforeEach(async () => {
  t += 60 * 60 * 1000; // every test runs later than the last one's deadlines
  await seedBase(db.pool);
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2) ' +
      'ON CONFLICT DO NOTHING',
    ['watch_flow', JSON.stringify(WATCH_FLOW)],
  );
  // Only this test's sessions are due.
  await db.pool.query('UPDATE session SET watch_deadline = NULL, state_deadline = NULL');
  await db.pool.query('DELETE FROM push_subscription');
  await db.pool.query(
    `INSERT INTO push_subscription (account_id, user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, 'https://push.test/a', 'BKey', 'auth', $3)`,
    [LOCAL_ACCOUNT_ID, randomUUID(), now()],
  );
});

/** A session parked in `state` of watch_flow with an armed watch and an open question. */
async function parked(
  repo: string,
  state: 'in_review' | 'needs_input',
  opts: { pr?: boolean; enteredAt?: Date; watchIn?: number } = {},
): Promise<{ sessionId: string; ticketId: string }> {
  const ticketId = randomUUID();
  const sessionId = randomUUID();
  await db.pool.query(
    'INSERT INTO ticket (id, repo, title, body, workflow_id, workflow_version, status) ' +
      "VALUES ($1, $2, 'Watched', 'b', 'watch_flow', 1, 'in_progress')",
    [ticketId, repo],
  );
  const type = state === 'in_review' ? 'pr_mergeable' : 'age_below';
  const context = {
    ...(opts.pr ? { [PR_CONTEXT_KEY]: { pr_url: 'https://github.com/x/app/pull/1' } } : {}),
    [WATCH_CONTEXT_KEY]: {
      state,
      visit: 1,
      conditions: [
        { type, label: type, status: 'todo', value: null, detail: null, checked_at: null },
      ],
      poll_ms: 2 * MIN,
      note: null,
      last_checked_at: null,
      escalated: false,
    },
  };
  await db.pool.query(
    `INSERT INTO session (id, ticket_id, workflow_id, workflow_version, status, workflow_state,
                          machine_id, branch, context, state_visits, state_entered_at,
                          watch_deadline, return_to)
     VALUES ($1, $2, 'watch_flow', 1, 'needs_input', $3, $4, 'conductor/x', $5, $6, $7, $8,
             'implementing')`,
    [
      sessionId,
      ticketId,
      state,
      MACHINE,
      JSON.stringify(context),
      JSON.stringify({ implementing: 1, [state]: 1 }),
      opts.enteredAt ?? now(),
      new Date(t + (opts.watchIn ?? 2 * MIN)),
    ],
  );
  await db.pool.query(
    "INSERT INTO input_request (id, session_id, kind, question, return_to, created_at) VALUES ($1, $2, 'handoff', 'Review it', 'implementing', $3)",
    [randomUUID(), sessionId, now()],
  );
  return { sessionId, ticketId };
}

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const outbox = async (id: string) =>
  (await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE session_id = $1 ORDER BY id', [id]))
    .rows;

describe('watch: same-repo merge trigger (FR-5)', () => {
  it('"Merged, done" on one ticket nudges the other watched ticket on its repo; one sweep checks it', async () => {
    const repo = `github.com/x/app-${randomUUID().slice(0, 8)}`;
    const merged = await parked(repo, 'in_review', { pr: true });
    const watched = await parked(repo, 'in_review', { pr: true });
    const elsewhere = await parked(`${repo}-other`, 'in_review', { pr: true });
    const handle = make();
    const res = await handle.engine.applyEvent(merged.sessionId, {
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: 'ui',
    });
    expect(res.status).toBe('applied');
    expect((await session(merged.sessionId)).status).toBe('done');
    expect((await session(watched.sessionId)).watch_deadline!.getTime()).toBe(t);
    expect((await session(elsewhere.sessionId)).watch_deadline!.getTime()).toBe(t + 2 * MIN);

    await handle.sweepOnce();
    const sent = (await outbox(watched.sessionId)).filter((r) => r.kind === 'run_action');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      action: 'evaluate_conditions',
      args: { short_circuit: true },
    });
    expect((await outbox(elsewhere.sessionId)).filter((r) => r.kind === 'run_action')).toEqual([]);
  });

  it('a broken watch moves the ticket back and closes the question it waited on', async () => {
    const repo = `github.com/x/app-${randomUUID().slice(0, 8)}`;
    const { sessionId } = await parked(repo, 'in_review', { pr: true, watchIn: 0 });
    const handle = make();
    await handle.sweepOnce();
    const res = await handle.engine.applyEvent(sessionId, {
      type: 'action.completed',
      command_id: randomUUID(),
      action: 'evaluate_conditions',
      result: {
        results: [{ type: 'pr_mergeable', status: 'failed', value: 'CONFLICTING', detail: null }],
      },
      error: null,
    });
    expect(res.status).toBe('applied');
    const s = await session(sessionId);
    expect(s).toMatchObject({ workflow_state: 'implementing', return_to: 'in_review' });
    expect(s.watch_deadline).toBeNull();
    const reqs = await db.pool.query<InputRequestRow>(
      'SELECT * FROM input_request WHERE session_id = $1',
      [sessionId],
    );
    expect(reqs.rows.map((r) => [r.answer, r.answered_by])).toEqual([
      ['[the watch moved the ticket]', 'system'],
    ]);
    const ev = await db.pool.query<{ payload: { cause: string } }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'state.entered'",
      [sessionId],
    );
    expect(ev.rows.map((r) => r.payload.cause)).toEqual(['watch_broken']);
    const start = (await outbox(sessionId)).find((r) => r.kind === 'start_session')!;
    expect(start.payload.prompt as string).toContain('Merge origin/main');
  });
});

describe('watch: the escalate form', () => {
  it('a question older than 2h writes one watch.escalated row and one push per stay', async () => {
    const { sessionId } = await parked('github.com/x/app', 'needs_input', {
      enteredAt: new Date(t - 3 * 60 * MIN),
      watchIn: 0,
    });
    const handle = make();
    await handle.sweepOnce();
    const s = await session(sessionId);
    expect(s.workflow_state).toBe('needs_input');
    const rows = await db.pool.query<{ payload: { state: string; notify: { via: string } } }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'watch.escalated'",
      [sessionId],
    );
    expect(rows.rows.map((r) => [r.payload.state, r.payload.notify.via])).toEqual([
      ['needs_input', 'watch_escalate'],
    ]);
    const pushes = (await outbox(sessionId)).filter((r) => r.kind === 'push_transition');
    expect(pushes.map((r) => r.idempotency_key)).toEqual([
      `watch_escalate:${sessionId}:needs_input:1`,
    ]);
    // The next check escalates no more this stay.
    t = s.watch_deadline!.getTime();
    await handle.sweepOnce();
    expect((await outbox(sessionId)).filter((r) => r.kind === 'push_transition')).toHaveLength(1);
  });
});

describe('nudgesWatches', () => {
  const snap = SNAPSHOT_FIXTURE;
  const ok = (action: string, error: string | null = null): EngineEvent => ({
    type: 'action.completed',
    command_id: randomUUID(),
    action,
    result: null,
    error,
  });
  it('a successful merge_pr or open_pr nudges; a failed one, or another action, does not', () => {
    expect(nudgesWatches(ok('merge_pr'), snap, snap)).toBe(true);
    expect(nudgesWatches(ok('open_pr'), snap, snap)).toBe(true);
    expect(nudgesWatches(ok('merge_pr', 'conflict'), snap, snap)).toBe(false);
    expect(nudgesWatches(ok('evaluate_conditions'), snap, snap)).toBe(false);
  });
  it('a human move into a terminal state nudges only from a state with conductor PR', () => {
    const move: EngineEvent = { type: 'human.transition', name: 'done', text: null, actor: 'ui' };
    const parkedSnap = { ...snap, status: 'needs_input' as const, step: null };
    const done = { ...parkedSnap, status: 'done' as const };
    const withPr = {
      ...parkedSnap,
      context: { [PR_CONTEXT_KEY]: { pr_url: 'https://github.com/x/app/pull/1' } },
    };
    expect(nudgesWatches(move, withPr, done)).toBe(true);
    expect(nudgesWatches(move, parkedSnap, done)).toBe(false);
    expect(nudgesWatches(move, withPr, { ...withPr, status: 'running' })).toBe(false);
  });
});
