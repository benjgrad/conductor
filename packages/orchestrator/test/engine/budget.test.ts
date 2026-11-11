import { BUDGET_KEY } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { InputRequestRow, OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, seedSession } from './fixtures.js';

// 09 §Budgets: the spend trigger (EngineService, same transaction), the wall-time sweep, and the
// human's raise. m1_basic's budget is $2 / 60 min. Needs db:up.

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

describe('budget enforcement', () => {
  it('a spend report over budget.usd hands the session to a human in the same apply', async () => {
    const { sessionId, handle } = await running();
    const under = await handle.engine.applyEvent(sessionId, {
      type: 'spend.reported',
      claude_session_id: 'c1',
      total_usd: 1.5,
    });
    expect(under.status === 'applied' && under.snapshot.workflow_state).toBe('implement');

    const r = await handle.engine.applyEvent(sessionId, {
      type: 'spend.reported',
      claude_session_id: 'c1',
      total_usd: 2.5,
    });
    expect(r.status).toBe('applied');
    const s = await session(sessionId);
    expect(s).toMatchObject({ workflow_state: 'needs_input', status: 'needs_input' });
    expect(Number(s.spend_usd)).toBeCloseTo(2.5);
    const types = await eventTypes(sessionId);
    expect(types.lastIndexOf('budget.exceeded')).toBeGreaterThan(
      types.lastIndexOf('spend.reported'),
    );
    const req = await openRequest(sessionId);
    expect(req).toMatchObject({ kind: 'budget_exceeded', return_to: 'implement' });
    expect(req!.options).toMatchObject({
      items: [{ label: 'Raise budget by $2.00 and continue' }, { label: 'Stop' }],
    });
  });

  it('the sweep trips a session whose running clock reaches budget.minutes', async () => {
    const { sessionId, handle } = await running();
    advance(59 * 60);
    expect((await handle.sweepBudgetsOnce()).exceeded).toBe(0);
    advance(60);
    const stats = await handle.sweepBudgetsOnce();
    expect(stats.exceeded).toBeGreaterThanOrEqual(1);
    expect(await session(sessionId)).toMatchObject({ status: 'needs_input' });
    expect((await openRequest(sessionId))?.question).toContain('ran 60 of 60 minutes');
  });

  it('"Raise budget …" records the raise and resumes with the raised --max-budget-usd', async () => {
    const { sessionId, handle } = await running();
    await handle.engine.applyEvent(sessionId, {
      type: 'spend.reported',
      claude_session_id: 'c1',
      total_usd: 2.5,
    });
    const req = (await openRequest(sessionId))!;
    const r = await handle.engine.applyEvent(sessionId, {
      type: 'input.provided',
      input_request_id: req.id,
      answer: 'Raise budget by $2.00 and continue',
    });
    expect(r.status).toBe('applied');
    const s = await session(sessionId);
    expect(s).toMatchObject({ workflow_state: 'implement', status: 'running' });
    expect(s.context[BUDGET_KEY]).toMatchObject({ usd: 2, minutes: 0 });
    const starts = (
      await db.pool.query<OutboxRow>(
        "SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session' ORDER BY id",
        [sessionId],
      )
    ).rows;
    const last = starts[starts.length - 1]!.payload as { max_budget_usd?: number };
    expect(last.max_budget_usd).toBeCloseTo(1.5);
  });
});
