import { BUDGET_KEY } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { InputRequestRow, OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, seedSession } from './fixtures.js';

// 09 §Spend tracking: per-session usd / minutes budgets are no longer enforced (2026-11-11). Spend
// and wall time are tracked, nothing trips, and no start caps the CLI; a legacy `budget_exceeded`
// request can still be answered. m1_basic declares $2 / 60 min. Needs db:up.

const db = useTestDatabase();

let clock: Date;
const make = () =>
  createEngineService({ db: db.pool, boardBus: new InMemoryBoardBus(), now: () => clock });
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

beforeEach(() => {
  clock = new Date('2026-10-22T12:00:00.000Z');
});

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const openRequest = async (id: string) =>
  (
    await db.pool.query<InputRequestRow>(
      'SELECT * FROM input_request WHERE session_id = $1 AND answer IS NULL',
      [id],
    )
  ).rows[0];
const eventTypes = async (id: string) =>
  (
    await db.pool.query<{ type: string }>(
      'SELECT type FROM event WHERE session_id = $1 ORDER BY id',
      [id],
    )
  ).rows.map((r) => r.type);

/** m1_basic running in `implement` with Claude session `c1`. */
async function running() {
  const { sessionId } = await seedSession(db.pool);
  const handle = make();
  await handle.engine.applyEvent(sessionId, { type: 'session.assigned', machine_id: MACHINE });
  const s = await session(sessionId);
  await handle.engine.applyEvent(sessionId, {
    type: 'session.started',
    command_id: s.agent_command_id!,
    worktree_path: '/tmp/wt',
    branch: s.branch!,
    port_range: { base: 41000, count: 10 },
  });
  await handle.engine.applyEvent(sessionId, {
    type: 'agent.claude_session_id',
    claude_session_id: 'c1',
  });
  return { sessionId, handle };
}

const startPayloads = async (id: string) =>
  (
    await db.pool.query<OutboxRow>(
      "SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session' ORDER BY id",
      [id],
    )
  ).rows.map((r) => r.payload as { max_budget_usd?: number });

describe('budgets are not enforced', () => {
  it('a spend report over budget.usd is tracked and the session carries on', async () => {
    const { sessionId, handle } = await running();
    const r = await handle.engine.applyEvent(sessionId, {
      type: 'spend.reported',
      claude_session_id: 'c1',
      total_usd: 2.5,
    });
    expect(r.status).toBe('applied');
    const s = await session(sessionId);
    expect(s).toMatchObject({ workflow_state: 'implement', status: 'running' });
    expect(Number(s.spend_usd)).toBeCloseTo(2.5);
    expect(await eventTypes(sessionId)).not.toContain('budget.exceeded');
    expect(await openRequest(sessionId)).toBeUndefined();
  });

  it('a running clock past budget.minutes trips nothing: there is no budget sweep', async () => {
    const { sessionId, handle } = await running();
    expect('sweepBudgetsOnce' in handle).toBe(false);
    // Past both the 60 min budget and implement's 30 min timeout: only the timeout fires.
    advance(120 * 60);
    await handle.sweepOnce();
    expect(await eventTypes(sessionId)).not.toContain('budget.exceeded');
    expect((await openRequest(sessionId))?.kind).toBe('timeout');
  });

  it('no start_session carries --max-budget-usd', async () => {
    const { sessionId } = await running();
    const starts = await startPayloads(sessionId);
    expect(starts.length).toBeGreaterThan(0);
    for (const p of starts) expect(p.max_budget_usd).toBeUndefined();
  });

  it('a legacy budget_exceeded request still resolves: "Raise …" resumes uncapped', async () => {
    const { sessionId, handle } = await running();
    await handle.engine.applyEvent(sessionId, {
      type: 'spend.reported',
      claude_session_id: 'c1',
      total_usd: 2.5,
    });
    // What R9's trigger used to feed; a request opened before the removal looks like this.
    await handle.engine.applyEvent(sessionId, {
      type: 'budget.exceeded',
      dimension: 'usd',
      spent: 2.5,
      limit: 2,
    });
    const req = (await openRequest(sessionId))!;
    expect(req).toMatchObject({ kind: 'budget_exceeded', return_to: 'implement' });
    const r = await handle.engine.applyEvent(sessionId, {
      type: 'input.provided',
      input_request_id: req.id,
      answer: 'Raise budget by $2.00 and continue',
    });
    expect(r.status).toBe('applied');
    const s = await session(sessionId);
    expect(s).toMatchObject({ workflow_state: 'implement', status: 'running' });
    expect(s.context[BUDGET_KEY]).toMatchObject({ usd: 2, minutes: 0 });
    const starts = await startPayloads(sessionId);
    expect(starts[starts.length - 1]!.max_budget_usd).toBeUndefined();
  });
});
