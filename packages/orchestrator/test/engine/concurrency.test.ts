// ADR-0037 P4 (T7): `requires.concurrency` through the real EngineService and sweep. A move held
// behind a ticket in review is released at the next sweep tick after that ticket leaves review
// ("Merged, done" nudges the repo's held moves); two held moves go oldest first; a ticket whose plan
// gave no `files` is never held. Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { PR_CONTEXT_KEY, STEP_CONTEXT_KEY } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, seedBase } from './fixtures.js';

const db = useTestDatabase();
let t = new Date('2026-11-06T12:00:00.000Z').getTime();
const now = () => new Date(t);
const MIN = 60_000;

const CONC_FLOW = {
  id: 'conc_flow',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash'],
      on: {
        pr_ready: {
          goto: 'in_review',
          title: 'PR ready',
          when: 'Done.',
          handoff: true,
          requires: {
            checks: [{ name: 'Build', cmd: 'make build' }],
            concurrency: {
              key: '$repo',
              max_in_flight: 1,
              scope: ['in_review'],
              overlap: 'planned_files',
              hold_timeout: '1d',
            },
          },
          on_unmet: { goto: 'implementing', retries: 2, else: 'needs_input' },
        },
        ask_user: 'needs_input',
      },
    },
    in_review: {
      type: 'human',
      title: 'In review',
      on: { done: { goto: 'done', title: 'Merged, done', actor: 'human' } },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: { answer: { goto: '$return_to', title: 'Answer', actor: 'human' } },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

const make = () => createEngineService({ db: db.pool, boardBus: new InMemoryBoardBus(), now });

beforeEach(async () => {
  t += 60 * 60 * 1000; // every test runs later than the last one's deadlines
  await seedBase(db.pool);
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2) ' +
      'ON CONFLICT DO NOTHING',
    ['conc_flow', JSON.stringify(CONC_FLOW)],
  );
  // Only this test's sessions are due.
  await db.pool.query('UPDATE session SET watch_deadline = NULL, state_deadline = NULL');
});

/** A plan's result with `files` (null: a plan that gave none). */
const planned = (files: string[] | null) => ({
  planning: { plan: '# Plan', ...(files !== null ? { files } : {}) },
});

/** A session of conc_flow in `state` on `repo`. `in_review` is parked with conductor's PR. */
async function seed(
  repo: string,
  state: 'implementing' | 'in_review',
  files: string[] | null,
): Promise<{ sessionId: string; ticketId: string }> {
  const ticketId = randomUUID();
  const sessionId = randomUUID();
  await db.pool.query(
    'INSERT INTO ticket (id, repo, title, body, workflow_id, workflow_version, status) ' +
      "VALUES ($1, $2, 'Held', 'b', 'conc_flow', 1, 'in_progress')",
    [ticketId, repo],
  );
  const context = {
    ...planned(files),
    ...(state === 'in_review'
      ? { [PR_CONTEXT_KEY]: { pr_url: 'https://github.com/x/app/pull/1' } }
      : {}),
  };
  await db.pool.query(
    `INSERT INTO session (id, ticket_id, workflow_id, workflow_version, status, workflow_state,
                          machine_id, branch, context, state_visits, state_entered_at, return_to)
     VALUES ($1, $2, 'conc_flow', 1, $3, $4, $5, 'conductor/x', $6, $7, $8, $9)`,
    [
      sessionId,
      ticketId,
      state === 'in_review' ? 'needs_input' : 'running',
      state,
      MACHINE,
      JSON.stringify(context),
      JSON.stringify({ implementing: 1, ...(state === 'in_review' ? { in_review: 1 } : {}) }),
      now(),
      state === 'in_review' ? 'implementing' : null,
    ],
  );
  return { sessionId, ticketId };
}

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const phaseOf = async (id: string) =>
  ((await session(id)).context[STEP_CONTEXT_KEY] as { phase?: string } | undefined)?.phase ?? null;
const runs = async (id: string) =>
  (
    await db.pool.query<OutboxRow>(
      "SELECT * FROM outbox WHERE session_id = $1 AND kind = 'run_cmd' ORDER BY id",
      [id],
    )
  ).rows;

describe('requires.concurrency (ADR-0037 P4, T7)', () => {
  it('held behind the ticket in review; "Merged, done" releases it within one sweep tick', async () => {
    const repo = `github.com/x/app-${randomUUID().slice(0, 8)}`;
    const handle = make();
    const holder = await seed(repo, 'in_review', ['src/**']);
    const mover = await seed(repo, 'implementing', ['src/app.ts']);
    await handle.engine.applyEvent(mover.sessionId, {
      type: 'agent.complete_state',
      result: {},
      transition: 'pr_ready',
      reason: 'Ready.',
    });
    expect(await phaseOf(mover.sessionId)).toBe('held');

    // The first check (the step's timer, due now) finds the holder.
    await handle.sweepOnce();
    const held = await session(mover.sessionId);
    expect(held.status).toBe('waiting_external');
    expect(await phaseOf(mover.sessionId)).toBe('held');
    expect(held.context[STEP_CONTEXT_KEY]).toMatchObject({
      held: true,
      hold: { behind: [holder.ticketId] },
    });
    expect(await runs(mover.sessionId)).toEqual([]);
    const checkedRows = await db.pool.query<{ payload: { holders: { ticket_id: string }[] } }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'concurrency.checked'",
      [mover.sessionId],
    );
    expect(checkedRows.rows.at(-1)!.payload.holders.map((h) => h.ticket_id)).toEqual([
      holder.ticketId,
    ]);
    const heldRows = await db.pool.query(
      "SELECT 1 FROM event WHERE session_id = $1 AND type = 'concurrency.held'",
      [mover.sessionId],
    );
    expect(heldRows.rowCount).toBe(1);
    // Its next poll is minutes away.
    expect(held.state_deadline!.getTime()).toBeGreaterThan(t + MIN);

    t += 10_000;
    await handle.engine.applyEvent(holder.sessionId, {
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: 'ui',
    });
    // The merge brought the held move's check forward to now: the next tick releases it.
    expect((await session(mover.sessionId)).state_deadline!.getTime()).toBe(t);
    await handle.sweepOnce();
    expect(await phaseOf(mover.sessionId)).toBe('checks');
    expect(await runs(mover.sessionId)).toHaveLength(1);
    const released = await db.pool.query<{ payload: { cause: string; held_ms: number } }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'concurrency.released'",
      [mover.sessionId],
    );
    expect(released.rows.map((r) => r.payload.cause)).toEqual(['concurrency_released']);
    expect(released.rows[0]!.payload.held_ms).toBe(10_000);
  });

  it('two held moves go oldest first', async () => {
    const repo = `github.com/x/app-${randomUUID().slice(0, 8)}`;
    const handle = make();
    const holder = await seed(repo, 'in_review', ['src/**']);
    const older = await seed(repo, 'implementing', ['src/a.ts']);
    // Both touch src/a.ts, so the younger waits behind the older too.
    const younger = await seed(repo, 'implementing', ['src/a.ts', 'src/b.ts']);
    const finish = (id: string) =>
      handle.engine.applyEvent(id, {
        type: 'agent.complete_state',
        result: {},
        transition: 'pr_ready',
        reason: 'Ready.',
      });
    await finish(older.sessionId);
    t += 1000;
    await finish(younger.sessionId);
    await handle.sweepOnce();
    expect(await phaseOf(older.sessionId)).toBe('held');
    expect(await phaseOf(younger.sessionId)).toBe('held');
    expect((await session(younger.sessionId)).context[STEP_CONTEXT_KEY]).toMatchObject({
      hold: { behind: [holder.ticketId, older.ticketId] },
    });

    t += 1000;
    await handle.engine.applyEvent(holder.sessionId, {
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: 'ui',
    });
    await handle.sweepOnce();
    expect(await phaseOf(older.sessionId)).toBe('checks');
    expect(await phaseOf(younger.sessionId)).toBe('held');
    expect((await session(younger.sessionId)).context[STEP_CONTEXT_KEY]).toMatchObject({
      hold: { behind: [older.ticketId] },
    });
  });

  it('a ticket whose plan gave no files is never held', async () => {
    const repo = `github.com/x/app-${randomUUID().slice(0, 8)}`;
    const handle = make();
    await seed(repo, 'in_review', ['src/**']);
    const mover = await seed(repo, 'implementing', null);
    await handle.engine.applyEvent(mover.sessionId, {
      type: 'agent.complete_state',
      result: {},
      transition: 'pr_ready',
      reason: 'Ready.',
    });
    await handle.sweepOnce();
    expect(await phaseOf(mover.sessionId)).toBe('checks');
    expect(await runs(mover.sessionId)).toHaveLength(1);
  });
});
