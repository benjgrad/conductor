// M2-T16a: the routing rules the board and the machine drawer share with the claim's SQL
// (10-contracts §Machines protocol v2 "Matching"), and the Queued card's `routing`. Needs
// `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalRemote, type AccountScope, type BoardCard } from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../../src/api/queries.js';
import { ingestInventory } from '../../src/gateway/inventory.js';
import {
  cannotTake,
  CANONICAL_REMOTE_SQL,
  keySatisfies,
  machineFacts,
  missingKeys,
  routingFor,
} from '../../src/gateway/routing.js';
import { useTestDatabase } from '../db.js';
import { enrolled, newAccount } from './auth-harness.js';
import { DEFAULT_INVENTORY } from './fake-daemon.js';

const db = useTestDatabase();

describe('keySatisfies / missingKeys', () => {
  const m = machineFacts(
    'm',
    ['github.com/org/b'],
    ['claude', 'cli:gh', 'skill:review@github.com/Org/B', 'agent:x@github.com/o/other'],
  );

  it('exact keys; a bare skill / agent by the ticket repo’s scoped key, case-insensitively', () => {
    expect(keySatisfies(m, 'claude', 'github.com/org/b')).toBe(true);
    expect(keySatisfies(m, 'cli:gh:authed', 'github.com/org/b')).toBe(false);
    expect(keySatisfies(m, 'skill:review', 'github.com/org/b')).toBe(true);
    expect(keySatisfies(m, 'skill:review@github.com/org/b', 'github.com/x/y')).toBe(true);
    expect(keySatisfies(m, 'agent:x', 'github.com/org/b')).toBe(false);
    expect(keySatisfies(m, 'CLAUDE', 'github.com/org/b')).toBe(false);
  });

  it('missingKeys keeps order and drops duplicates', () => {
    expect(
      missingKeys(m, ['mcp:slack', 'claude', 'cli:az', 'mcp:slack'], 'github.com/org/b'),
    ).toEqual(['mcp:slack', 'cli:az']);
  });
});

describe('routingFor / cannotTake', () => {
  const withRepo = machineFacts('a', ['github.com/org/b'], ['claude']);
  const capable = machineFacts('b', ['github.com/Org/B'], ['claude', 'cli:az:authed']);
  const noRepo = machineFacts('c', [], ['claude', 'cli:az:authed']);
  const reqs = ['claude', 'cli:az:authed'];

  it('undefined when an online machine can take it', () => {
    expect(routingFor([withRepo, capable], 'github.com/org/b', reqs)).toBeUndefined();
  });

  it('the repo first; capabilities of the closest machine', () => {
    expect(routingFor([noRepo], 'github.com/org/b', reqs)).toEqual({
      missing_repo: 'github.com/org/b',
      missing_capabilities: [],
    });
    expect(routingFor([withRepo, noRepo], 'github.com/org/b', reqs)).toEqual({
      missing_capabilities: ['cli:az:authed'],
    });
    expect(routingFor([], 'github.com/org/b', reqs)).toEqual({
      missing_repo: 'github.com/org/b',
      missing_capabilities: reqs,
    });
    // A local path is never a missing repo.
    expect(routingFor([withRepo], '/tmp/app', reqs)).toEqual({
      missing_capabilities: ['cli:az:authed'],
    });
  });

  it('cannotTake: null when it can, else the repo and what it lacks', () => {
    expect(cannotTake(capable, 'github.com/org/b', reqs)).toBeNull();
    expect(cannotTake(noRepo, 'github.com/org/b', ['claude'])).toEqual({
      missing_repo: 'github.com/org/b',
      missing_capabilities: [],
    });
    expect(cannotTake(withRepo, 'github.com/org/b', reqs)).toEqual({
      missing_capabilities: ['cli:az:authed'],
    });
  });

  it('the claim’s SQL canonical test agrees with isCanonicalRemote', async () => {
    const samples = [
      'github.com/org/b',
      'gitlab.example.com/group/sub/repo',
      'github.com/Org/B.js',
      'GitHub.com/org/b',
      'github.com/org/b.git',
      'github.com/org',
      '/Users/me/app',
      'C:\\code\\app',
      'https://github.com/org/b',
      'github.com/org/.hidden',
    ];
    const r = await db.pool.query<{ s: string; ok: boolean }>(
      `SELECT s, (s ~ $2 AND s !~* '\\.git$') AS ok FROM unnest($1::text[]) AS s`,
      [samples, CANONICAL_REMOTE_SQL],
    );
    for (const { s, ok } of r.rows) expect([s, ok]).toEqual([s, isCanonicalRemote(s)]);
  });
});

describe('the Queued card’s routing (board view)', () => {
  beforeAll(async () => {
    await db.pool.query(
      `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)
       ON CONFLICT DO NOTHING`,
      [
        readFileSync(
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            '../../../../docs/design/workflows/m1_basic.v1.json',
          ),
          'utf8',
        ),
      ],
    );
  });

  async function machine(scope: AccountScope, status: 'online' | 'offline', remote: string) {
    const { machine_id } = await enrolled(db.pool, scope);
    await db.pool.query('UPDATE machine SET status = $2 WHERE id = $1', [machine_id, status]);
    await ingestInventory(
      db.pool,
      { machineId: machine_id, accountId: scope.account_id },
      {
        ...DEFAULT_INVENTORY,
        repos: [{ ...DEFAULT_INVENTORY.repos[0]!, remote }],
        capabilities: [{ kind: 'cli', name: 'gh', version: null, authed: false }],
        hash: randomUUID(),
      },
    );
    return machine_id;
  }

  async function card(scope: AccountScope, repo: string): Promise<BoardCard> {
    const t = await db.pool.query<{ id: string }>(
      `INSERT INTO ticket (account_id, repo, title, workflow_id) VALUES ($1, $2, 'q', 'm1_basic')
       RETURNING id`,
      [scope.account_id, repo],
    );
    const board = await loadBoard(db.pool);
    return board.columns.flatMap((c) => c.cards).find((c) => c.ticket_id === t.rows[0]!.id)!;
  }

  it('names the repo no online machine has (an offline one doesn’t count)', async () => {
    const scope = await newAccount(db.pool);
    await machine(scope, 'offline', 'github.com/org/b');
    const c = await card(scope, 'github.com/org/b');
    expect(c.column).toBe('queued');
    expect(c.routing).toEqual({
      missing_repo: 'github.com/org/b',
      missing_capabilities: ['claude'],
    });
  });

  it('names the capabilities the closest online machine with the repo lacks', async () => {
    const scope = await newAccount(db.pool);
    await machine(scope, 'online', 'github.com/org/b');
    expect((await card(scope, 'github.com/Org/B')).routing).toEqual({
      missing_capabilities: ['claude'],
    });
  });

  it('no routing when an online machine can take it', async () => {
    const scope = await newAccount(db.pool);
    const m = await machine(scope, 'online', 'github.com/org/b');
    await ingestInventory(
      db.pool,
      { machineId: m, accountId: scope.account_id },
      {
        ...DEFAULT_INVENTORY,
        repos: [{ ...DEFAULT_INVENTORY.repos[0]!, remote: 'github.com/org/b' }],
      },
    );
    expect((await card(scope, 'github.com/org/b')).routing).toBeUndefined();
  });
});
