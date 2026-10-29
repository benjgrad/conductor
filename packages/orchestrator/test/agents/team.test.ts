// UX-13a: the agent team, assigned by the claim (10-contracts §Claim, "Agent assignment").
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES, hireName, type AccountScope } from '@conductor/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listTeam } from '../../src/agents/team.js';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { AgentRow } from '../../src/db/types.js';
import { reopenSession } from '../../src/engine/reopen.js';
import { claimWork } from '../../src/gateway/claim.js';
import { useTestDatabase } from '../db.js';
import { enrolled, newAccount } from '../gateway/auth-harness.js';
import { RecordingEngine } from '../gateway/recording-engine.js';

const db = useTestDatabase();
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)
     ON CONFLICT DO NOTHING`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const engine = () => new RecordingEngine(db.pool, new InMemoryBoardBus());

/** An online machine that takes only tickets tagged `tag`. */
async function onlineMachine(tag: string): Promise<string> {
  const { machine_id } = await enrolled(db.pool, await newAccount(db.pool));
  await db.pool.query(
    `UPDATE machine SET status = 'online', tags = $2, max_sessions = 1000 WHERE id = $1`,
    [machine_id, [tag]],
  );
  return machine_id;
}

async function claimable(accountId: string, tag: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO ticket (account_id, repo, title, workflow_id, required_tags)
     VALUES ($1, 'github.com/o/app', 't', 'm1_basic', $2) RETURNING id`,
    [accountId, [tag]],
  );
  return r.rows[0]!.id;
}

async function claim(machineId: string) {
  const res = await claimWork(db.pool, engine(), machineId, 1);
  if (res.status !== 'claimed') throw new Error(`no claim: ${res.reason}`);
  return res;
}

const agentOf = async (ticketId: string): Promise<AgentRow | null> =>
  (
    await db.pool.query<AgentRow>(
      'SELECT a.* FROM ticket t JOIN agent a ON a.id = t.agent_id WHERE t.id = $1',
      [ticketId],
    )
  ).rows[0] ?? null;

const teamOf = async (accountId: string): Promise<AgentRow[]> =>
  (
    await db.pool.query<AgentRow>('SELECT * FROM agent WHERE account_id = $1 ORDER BY hired_at', [
      accountId,
    ])
  ).rows;

/** The ticket's work ends: its sessions are done, so its agent is free. */
async function finish(ticketId: string): Promise<void> {
  await db.pool.query(`UPDATE session SET status = 'done' WHERE ticket_id = $1`, [ticketId]);
  await db.pool.query(`UPDATE ticket SET status = 'done' WHERE id = $1`, [ticketId]);
}

async function hire(
  accountId: string,
  name: string,
  hiredAt: string,
  lastAssignedAt: string | null,
): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO agent (account_id, name, hired_at, last_assigned_at) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [accountId, name, hiredAt, lastAssignedAt],
  );
  return r.rows[0]!.id;
}

/** A ticket (not claimable) that keeps `agentId` busy with a running session. */
async function busyWith(accountId: string, agentId: string): Promise<string> {
  const t = await db.pool.query<{ id: string }>(
    `INSERT INTO ticket (account_id, repo, title, workflow_id, status, agent_id)
     VALUES ($1, 'github.com/o/app', 'busy', 'm1_basic', 'claimed', $2) RETURNING id`,
    [accountId, agentId],
  );
  await db.pool.query(
    `INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status)
     VALUES ($1, $2, 'm1_basic', 1, 'running')`,
    [accountId, t.rows[0]!.id],
  );
  return t.rows[0]!.id;
}

interface Setup {
  scope: AccountScope;
  tag: string;
  machine: string;
}

async function setup(): Promise<Setup> {
  const tag = `t-${randomUUID().slice(0, 8)}`;
  return { scope: await newAccount(db.pool), tag, machine: await onlineMachine(tag) };
}

describe('agent assignment in the claim (UX-13a)', () => {
  it('a queued ticket holds no one; the claim hires the first agent from the pool', async () => {
    const { scope, tag, machine } = await setup();
    const ticket = await claimable(scope.account_id, tag);
    expect(await agentOf(ticket)).toBeNull();

    const res = await claim(machine);
    expect(res.ticketId).toBe(ticket);
    const agent = await agentOf(ticket);
    expect(agent).toMatchObject({
      account_id: scope.account_id,
      name: hireName(ticket, new Set()),
    });
    expect(agent!.last_assigned_at).not.toBeNull();
  });

  it('the claim’s card event carries the agent name', async () => {
    const { scope, tag, machine } = await setup();
    const ticket = await claimable(scope.account_id, tag);
    const res = await claim(machine);
    const upserts = res.boardEvents.filter((e) => e.type === 'card.upserted');
    expect(upserts.length).toBeGreaterThan(0);
    for (const e of upserts) {
      if (e.type === 'card.upserted') expect(e.card.agent_name).toBe(hireName(ticket, new Set()));
    }
  });

  it('a ticket reuses a free teammate', async () => {
    const { scope, tag, machine } = await setup();
    const first = await claimable(scope.account_id, tag);
    await claim(machine);
    const agent = (await agentOf(first))!;
    await finish(first);

    const second = await claimable(scope.account_id, tag);
    await claim(machine);
    const again = (await agentOf(second))!;
    expect(again.id).toBe(agent.id);
    expect(again.last_assigned_at!.getTime()).toBeGreaterThanOrEqual(
      agent.last_assigned_at!.getTime(),
    );
    expect(await teamOf(scope.account_id)).toHaveLength(1);
  });

  it('picks the free teammate assigned longest ago, ties broken by hire date', async () => {
    const { scope, tag, machine } = await setup();
    const a = scope.account_id;
    await hire(a, 'Ada', '2024-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    await hire(a, 'Omar', '2024-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await hire(a, 'Mei', '2024-01-02T00:00:00Z', '2025-01-01T00:00:00Z');
    await hire(a, 'Kofi', '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z');

    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      // Each claimed ticket stays active, so its agent is busy for the next claim.
      const ticket = await claimable(a, tag);
      await claim(machine);
      picked.push((await agentOf(ticket))!.name);
    }
    expect(picked).toEqual(['Kofi', 'Mei', 'Omar', 'Ada']);
  });

  it('a busy team hires a new name from the pool', async () => {
    const { scope, tag, machine } = await setup();
    const first = await claimable(scope.account_id, tag);
    await claim(machine);
    const busy = (await agentOf(first))!;

    const second = await claimable(scope.account_id, tag);
    await claim(machine);
    const hired = (await agentOf(second))!;
    expect(hired.id).not.toBe(busy.id);
    expect(hired.name).toBe(hireName(second, new Set([busy.name])));
    expect(await teamOf(scope.account_id)).toHaveLength(2);
  });

  it('a reopened ticket keeps its agent, busy elsewhere or not', async () => {
    const { scope, tag, machine } = await setup();
    const a = scope.account_id;
    const ticket = await claimable(a, tag);
    const first = await claim(machine);
    const agent = (await agentOf(ticket))!;

    await finish(ticket);
    // Meanwhile its agent is busy on another ticket, and a free teammate is waiting.
    await busyWith(a, agent.id);
    await hire(a, 'Zuri', '2020-01-01T00:00:00Z', null);

    const reopened = await reopenSession(db.pool, first.sessionId, 'one more thing');
    expect(reopened.status).toBe('reopened');
    const res = await claim(machine);
    expect(res.ticketId).toBe(ticket);
    expect((await agentOf(ticket))!.id).toBe(agent.id);
  });

  it('two concurrent claims get two different agents (20 rounds, empty team)', async () => {
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const [m1, m2] = [await onlineMachine(tag), await onlineMachine(tag)];
    for (let round = 0; round < 20; round++) {
      const scope = await newAccount(db.pool);
      const tickets = [
        await claimable(scope.account_id, tag),
        await claimable(scope.account_id, tag),
      ];
      const [r1, r2] = await Promise.all([claim(m1), claim(m2)]);
      expect(new Set([r1.ticketId, r2.ticketId])).toEqual(new Set(tickets));
      const agents = await Promise.all(tickets.map(agentOf));
      expect(agents[0]!.id).not.toBe(agents[1]!.id);
      expect(await teamOf(scope.account_id)).toHaveLength(2);
    }
  }, 60_000);

  it('two concurrent claims never share one free teammate (20 rounds)', async () => {
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const [m1, m2] = [await onlineMachine(tag), await onlineMachine(tag)];
    for (let round = 0; round < 20; round++) {
      const scope = await newAccount(db.pool);
      const free = await hire(scope.account_id, 'Ada', '2024-01-01T00:00:00Z', null);
      const tickets = [
        await claimable(scope.account_id, tag),
        await claimable(scope.account_id, tag),
      ];
      await Promise.all([claim(m1), claim(m2)]);
      const agents = await Promise.all(tickets.map(agentOf));
      expect(agents[0]!.id).not.toBe(agents[1]!.id);
      expect(agents.map((x) => x!.id)).toContain(free);
      expect(await teamOf(scope.account_id)).toHaveLength(2);
    }
  }, 60_000);

  it('with the whole pool hired and busy, reuses the teammate assigned longest ago and logs it', async () => {
    const { scope, tag, machine } = await setup();
    const a = scope.account_id;
    // Name i was last assigned i minutes ago: the last name is the longest ago.
    await db.pool.query(
      `INSERT INTO agent (account_id, name, last_assigned_at)
       SELECT $1, n, now() - make_interval(mins => ord::int)
         FROM unnest($2::text[]) WITH ORDINALITY u(n, ord)`,
      [a, AGENT_NAMES],
    );
    await db.pool.query(
      `WITH t AS (
         INSERT INTO ticket (account_id, repo, title, workflow_id, status, agent_id)
         SELECT $1, 'github.com/o/app', 'busy', 'm1_basic', 'claimed', id
           FROM agent WHERE account_id = $1 RETURNING id)
       INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status)
       SELECT $1, id, 'm1_basic', 1, 'running' FROM t`,
      [a],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ticket = await claimable(a, tag);
    await claim(machine);
    const oldest = AGENT_NAMES[AGENT_NAMES.length - 1]!;
    expect((await agentOf(ticket))!.name).toBe(oldest);
    expect(await teamOf(a)).toHaveLength(AGENT_NAMES.length);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`reusing ${oldest} `)));
  });

  it('two accounts get independent teams', async () => {
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const machine = await onlineMachine(tag);
    const [scopeA, scopeB] = [await newAccount(db.pool), await newAccount(db.pool)];

    const ticketA = await claimable(scopeA.account_id, tag);
    await claim(machine);
    const agentA = (await agentOf(ticketA))!;
    await finish(ticketA);

    // A's teammate is free, but B's ticket never gets it: B hires its own.
    const ticketB = await claimable(scopeB.account_id, tag);
    await claim(machine);
    const agentB = (await agentOf(ticketB))!;
    expect(agentB.id).not.toBe(agentA.id);
    expect(agentB.account_id).toBe(scopeB.account_id);
    expect(agentB.name).toBe(hireName(ticketB, new Set()));

    expect((await listTeam(db.pool, scopeA.account_id)).map((m) => m.name)).toEqual([agentA.name]);
    expect((await listTeam(db.pool, scopeB.account_id)).map((m) => m.name)).toEqual([agentB.name]);
  });

  it('listTeam reports each agent’s active ticket', async () => {
    const { scope, tag, machine } = await setup();
    const ticket = await claimable(scope.account_id, tag);
    await claim(machine);
    const agent = (await agentOf(ticket))!;
    expect(await listTeam(db.pool, scope.account_id)).toEqual([
      {
        name: agent.name,
        hired_at: agent.hired_at.toISOString(),
        last_assigned_at: agent.last_assigned_at!.toISOString(),
        active_ticket_id: ticket,
      },
    ]);
    await finish(ticket);
    expect((await listTeam(db.pool, scope.account_id))[0]!.active_ticket_id).toBeNull();
  });
});
