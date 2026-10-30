// M2-T16a: the claim's routing filters (ADR-0013 §Routing; 10-contracts §Machines protocol v2
// "Matching", §Working copy). Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MACHINE_LOST_CONTEXT_KEY,
  requiredCapabilities,
  WORKING_COPY_CONTEXT_KEY,
  type AccountScope,
  type Capability,
  type InventoryRepo,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { OutboxRow, SessionRow } from '../../src/db/types.js';
import { claimWork } from '../../src/gateway/claim.js';
import { ingestInventory } from '../../src/gateway/inventory.js';
import { RequiredCaps } from '../../src/gateway/routing.js';
import { useTestDatabase } from '../db.js';
import { enrolled, newAccount } from './auth-harness.js';
import { RecordingEngine } from './recording-engine.js';

const db = useTestDatabase();
const workflow = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../docs/design/workflows/m1_basic.v1.json',
  ),
  'utf8',
);

/** m1_basic needs `claude`; the copies below need more (requirements injected by id). */
const EXTRA: Record<string, string[]> = {
  needs_az: ['cli:az:authed'],
  needs_skill: ['skill:review'],
};
const required = new RequiredCaps((def, kind) => [
  ...requiredCapabilities(def, kind),
  ...(EXTRA[def.id] ?? []),
]);

beforeAll(async () => {
  for (const id of ['m1_basic', ...Object.keys(EXTRA)]) {
    await db.pool.query(
      `INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2)
       ON CONFLICT DO NOTHING`,
      [id, JSON.stringify({ ...JSON.parse(workflow), id })],
    );
  }
});

const engine = () => new RecordingEngine(db.pool, new InMemoryBoardBus());
const CLAUDE: Capability = { kind: 'claude', version: '2.1.0' };

function repo(path: string, remote: string | null, mode: InventoryRepo['mode'] = 'reference') {
  return { path, remote, default_branch: 'main', head_commit: 'a'.repeat(40), mode };
}

/** An online machine of `scope` reporting `repos` and `capabilities`. */
async function machine(
  scope: AccountScope,
  repos: InventoryRepo[],
  capabilities: Capability[] = [CLAUDE],
): Promise<string> {
  const { machine_id } = await enrolled(db.pool, scope);
  await db.pool.query(`UPDATE machine SET status = 'online', max_sessions = 10 WHERE id = $1`, [
    machine_id,
  ]);
  await inventory(scope, machine_id, repos, capabilities);
  return machine_id;
}

function inventory(
  scope: AccountScope,
  machineId: string,
  repos: InventoryRepo[],
  capabilities: Capability[],
) {
  return ingestInventory(
    db.pool,
    { machineId, accountId: scope.account_id },
    { repos, capabilities, hash: randomUUID() },
  );
}

async function ticket(scope: AccountScope, repoName: string, workflowId = 'm1_basic') {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO ticket (account_id, repo, title, workflow_id) VALUES ($1, $2, 't', $3)
     RETURNING id`,
    [scope.account_id, repoName, workflowId],
  );
  return r.rows[0]!.id;
}

const claim = (machineId: string) =>
  claimWork(db.pool, engine(), machineId, 1, { required, log: () => {} });

async function claimed(machineId: string): Promise<string | null> {
  const res = await claim(machineId);
  return res.status === 'claimed' ? res.ticketId : null;
}

describe('claimWork routing (M2-T16a)', () => {
  it('a ticket for org/b goes to machine B (which has it), never to A', async () => {
    const scope = await newAccount(db.pool);
    const a = await machine(scope, [repo('/src/a', 'github.com/org/a')]);
    const b = await machine(scope, [repo('/src/b', 'github.com/org/b')]);
    const t = await ticket(scope, 'github.com/org/b');
    expect(await claimed(a)).toBeNull();
    expect(await claimed(b)).toBe(t);
  });

  it('github.com/Org/B matches a machine reporting github.com/org/b', async () => {
    const scope = await newAccount(db.pool);
    const b = await machine(scope, [repo('/src/b', 'github.com/org/b')]);
    const t = await ticket(scope, 'github.com/Org/B');
    expect(await claimed(b)).toBe(t);
  });

  it('a repo with no remote is never routed to', async () => {
    const scope = await newAccount(db.pool);
    const m = await machine(scope, [repo('/src/b', null)]);
    await ticket(scope, 'github.com/org/b');
    expect(await claimed(m)).toBeNull();
  });

  it('cli:az:authed: not with az unauthed; claimed once an inventory says authed', async () => {
    const scope = await newAccount(db.pool);
    const repos = [repo('/src/b', 'github.com/org/b')];
    const az = (authed: boolean): Capability => ({
      kind: 'cli',
      name: 'az',
      version: '2.67.0',
      authed,
    });
    const m = await machine(scope, repos, [CLAUDE, az(false)]);
    const t = await ticket(scope, 'github.com/org/b', 'needs_az');
    expect(await claimed(m)).toBeNull();
    await inventory(scope, m, repos, [CLAUDE, az(true)]);
    expect(await claimed(m)).toBe(t);
  });

  it('every requirement counts: a machine without claude takes nothing', async () => {
    const scope = await newAccount(db.pool);
    const m = await machine(scope, [repo('/src/b', 'github.com/org/b')], []);
    await ticket(scope, 'github.com/org/b');
    expect(await claimed(m)).toBeNull();
  });

  it('a bare skill:review is met by skill:review@github.com/Org/B, not by another repo’s', async () => {
    const scope = await newAccount(db.pool);
    const repos = [repo('/src/b', 'github.com/org/b')];
    const skill = (r: string): Capability => ({ kind: 'skill', name: 'review', repo: r });
    const other = await machine(scope, repos, [CLAUDE, skill('github.com/org/other')]);
    const b = await machine(scope, repos, [CLAUDE, skill('github.com/Org/B')]);
    const t = await ticket(scope, 'github.com/org/b', 'needs_skill');
    expect(await claimed(other)).toBeNull();
    expect(await claimed(b)).toBe(t);
  });

  it('writes the matched repo into session.context.__working_copy and the start_session', async () => {
    const scope = await newAccount(db.pool);
    const b = await machine(scope, [
      repo('/src/other', 'github.com/org/other'),
      repo('/Users/me/b', 'github.com/org/b', 'checkout'),
    ]);
    await ticket(scope, 'github.com/org/b');
    const res = await claim(b);
    expect(res.status).toBe('claimed');
    if (res.status !== 'claimed') return;
    const wc = { repo_path: '/Users/me/b', mode: 'checkout' };
    const s = await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [
      res.sessionId,
    ]);
    expect(s.rows[0]!.context[WORKING_COPY_CONTEXT_KEY]).toEqual(wc);
    const o = await db.pool.query<OutboxRow>(
      `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session'`,
      [res.sessionId],
    );
    expect(o.rows).toHaveLength(1);
    expect((o.rows[0]!.payload as { working_copy?: unknown }).working_copy).toEqual(wc);
  });

  it('a non-canonical repo (local mode) skips the repo filter only, with no working copy', async () => {
    const scope = await newAccount(db.pool);
    const bare = await machine(scope, [], []);
    const m = await machine(scope, []);
    const t = await ticket(scope, '/tmp/fixture-repo');
    expect(await claimed(bare)).toBeNull(); // capabilities still apply
    const res = await claim(m);
    expect(res.status === 'claimed' && res.ticketId).toBe(t);
    if (res.status !== 'claimed') return;
    const s = await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [
      res.sessionId,
    ]);
    expect(s.rows[0]!.context).not.toHaveProperty(WORKING_COPY_CONTEXT_KEY);
  });

  it('never claims another account’s ticket', async () => {
    const [mine, theirs] = [await newAccount(db.pool), await newAccount(db.pool)];
    const m = await machine(mine, [repo('/src/b', 'github.com/org/b')]);
    await ticket(theirs, 'github.com/org/b');
    expect(await claimed(m)).toBeNull();
  });

  it('a queued session marked lost on B is never claimed by A; B takes it', async () => {
    const scope = await newAccount(db.pool);
    const repos = [repo('/src/b', 'github.com/org/b')];
    const a = await machine(scope, repos);
    const b = await machine(scope, repos);
    const t = await ticket(scope, 'github.com/org/b');
    await db.pool.query(
      `INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status, context)
       VALUES ($1, $2, 'm1_basic', 1, 'queued', $3)`,
      [
        scope.account_id,
        t,
        JSON.stringify({
          [MACHINE_LOST_CONTEXT_KEY]: {
            machine_id: b,
            machine_name: 'b',
            reason: 'lease_expired',
            state: 'implement',
            at: new Date().toISOString(),
          },
        }),
      ],
    );
    expect(await claimed(a)).toBeNull();
    expect(await claimed(b)).toBe(t);
  });
});
