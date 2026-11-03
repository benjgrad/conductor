import { randomUUID } from 'node:crypto';
import {
  CONDUCTOR_V5_DEF,
  LOCAL_ACCOUNT_ID,
  PROPOSED_TICKETS_KEY,
  type AccountScope,
  type EngineEvent,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../src/contracts.js';
import type { SessionRow, TicketProposalRow, TicketRow } from '../src/db/types.js';
import { createEngineService } from '../src/engine/index.js';
import { seedConductorWorkflow } from '../src/engine/seed.js';
import { acceptProposal, dismissProposal, listProposals } from '../src/proposals/store.js';
import { useTestDatabase } from './db.js';
import { MACHINE, seedSession } from './engine/fixtures.js';

// ADR-0034 on real Postgres: the wrapper stores the `ticket_proposals` effect (idempotent per
// session and title), and the store accepts (a new, independent ticket) or dismisses each one,
// scoped to the account. Needs `pnpm db:up`.

const db = useTestDatabase();
const NOW = new Date('2026-11-03T12:00:00.000Z');
const scope: AccountScope = { account_id: LOCAL_ACCOUNT_ID } as AccountScope;

beforeAll(async () => {
  await seedConductorWorkflow(db.pool);
});

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const proposals = async (sessionId: string) =>
  (
    await db.pool.query<TicketProposalRow>(
      'SELECT * FROM ticket_proposal WHERE session_id = $1 ORDER BY title',
      [sessionId],
    )
  ).rows;

/** A conductor v5 ticket whose agent is running in Implementing. */
async function implementing() {
  const seeded = await seedSession(db.pool, {
    workflow_id: 'conductor',
    workflow_version: CONDUCTOR_V5_DEF.version,
  });
  await db.pool.query(
    "UPDATE ticket SET workflow_id = 'conductor', kind = 'personal', priority = 4, " +
      "required_tags = '{gpu}' WHERE id = $1",
    [seeded.ticketId],
  );
  const bus = new InMemoryBoardBus();
  const { engine } = createEngineService({ db: db.pool, boardBus: bus, now: () => NOW });
  const run = (event: EngineEvent) => engine.applyEvent(seeded.sessionId, event);
  const started = async () => {
    const s = await session(seeded.sessionId);
    await run({
      type: 'session.started',
      command_id: s.agent_command_id!,
      worktree_path: '/tmp/wt',
      branch: s.branch!,
      port_range: { base: 41000, count: 10 },
    });
  };
  await run({ type: 'session.assigned', machine_id: MACHINE });
  await started();
  await run({
    type: 'agent.complete_state',
    transition: 'plan_ready',
    result: { plan: 'p', summary: 's' },
  });
  await started();
  expect((await session(seeded.sessionId)).workflow_state).toBe('implementing');
  return { ...seeded, run, started, bus };
}

const ask = (titles: string[]): EngineEvent => ({
  type: 'agent.complete_state',
  transition: 'ask_user',
  reason: 'Which one?',
  result: { [PROPOSED_TICKETS_KEY]: titles.map((title) => ({ title, body: `do ${title}` })) },
});

describe('ticket_proposals effect (EngineService wrapper)', () => {
  it('stores the proposals in the apply transaction; a repeated title is not stored twice', async () => {
    const t = await implementing();
    await t.run(ask(['Add docs']));
    expect((await proposals(t.sessionId)).map((p) => [p.title, p.state, p.status])).toEqual([
      ['Add docs', 'implementing', 'pending'],
    ]);
    // Answer, resume, and propose again: only the new title is added.
    const ir = await db.pool.query<{ id: string }>(
      'SELECT id FROM input_request WHERE session_id = $1 AND answer IS NULL',
      [t.sessionId],
    );
    await t.run({ type: 'input.provided', input_request_id: ir.rows[0]!.id, answer: 'go on' });
    await t.started();
    await t.run(ask(['add DOCS', 'Fix lint']));
    expect((await proposals(t.sessionId)).map((p) => p.title)).toEqual(['Add docs', 'Fix lint']);
    // Never in the stored result.
    expect((await session(t.sessionId)).context.implementing).toBeUndefined();
  });
});

describe('proposals store', () => {
  async function pending() {
    const t = await implementing();
    await t.run(ask(['Add docs', 'Fix lint']));
    const rows = await proposals(t.sessionId);
    return { t, docs: rows[0]!, lint: rows[1]! };
  }

  it('accept queues an independent ticket like the source; a second accept is a conflict', async () => {
    const { t, docs } = await pending();
    const bus = new InMemoryBoardBus();
    const res = await acceptProposal(
      { db: db.pool, boardBus: bus },
      scope,
      docs.id,
      { title: 'Add API docs' },
      'ben@example.com',
      NOW,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposal).toMatchObject({
      status: 'accepted',
      created_ticket_id: res.ticket.id,
      decided_by: 'ben@example.com',
    });
    const created = (
      await db.pool.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [res.ticket.id])
    ).rows[0]!;
    expect(created).toMatchObject({
      title: 'Add API docs',
      body: 'do Add docs',
      repo: 'github.com/x/app',
      workflow_id: 'conductor',
      kind: 'personal',
      priority: 4,
      required_tags: ['gpu'],
      status: 'ready',
    });
    expect(created.id).not.toBe(t.ticketId);
    expect(bus.published.map((e) => e.type)).toContain('card.upserted');

    const again = await acceptProposal({ db: db.pool, boardBus: bus }, scope, docs.id, {}, 'x');
    expect(again).toMatchObject({ ok: false, status: 409, code: 'conflict' });
  });

  it('dismiss, then neither decision again; listProposals shows both', async () => {
    const { t, lint } = await pending();
    const res = await dismissProposal(db.pool, scope, lint.id, 'ui', NOW);
    expect(res).toMatchObject({ ok: true, proposal: { status: 'dismissed', decided_by: 'ui' } });
    expect(await dismissProposal(db.pool, scope, lint.id, 'ui')).toMatchObject({ status: 409 });
    const list = await listProposals(db.pool, LOCAL_ACCOUNT_ID, t.ticketId);
    expect(list.map((p) => [p.title, p.status]).sort()).toEqual([
      ['Add docs', 'pending'],
      ['Fix lint', 'dismissed'],
    ]);
  });

  it('another account, or an unknown id, is not_found', async () => {
    const { docs } = await pending();
    const other = await db.pool.query<{ id: string }>(
      "INSERT INTO account (name) VALUES ('other') RETURNING id",
    );
    const otherScope = { account_id: other.rows[0]!.id } as AccountScope;
    const bus = new InMemoryBoardBus();
    expect(
      await acceptProposal({ db: db.pool, boardBus: bus }, otherScope, docs.id, {}, 'x'),
    ).toMatchObject({ ok: false, status: 404 });
    expect(await dismissProposal(db.pool, otherScope, docs.id, 'x')).toMatchObject({
      status: 404,
    });
    expect(await dismissProposal(db.pool, scope, randomUUID(), 'x')).toMatchObject({
      status: 404,
    });
    expect(await dismissProposal(db.pool, scope, 'nope', 'x')).toMatchObject({ status: 404 });
  });
});
