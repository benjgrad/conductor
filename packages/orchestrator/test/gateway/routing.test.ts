// M2-T16a: the routing rules the board and the machine drawer share with the claim's SQL
// (10-contracts §Machines protocol v2 "Matching"), and the Queued card's `routing`. Needs
// `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCanonicalRemote,
  repoPatternMatches,
  type AccountScope,
  type BoardCard,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../../src/api/queries.js';
import { ingestInventory } from '../../src/gateway/inventory.js';
import {
  cannotTake,
  CANONICAL_REMOTE_SQL,
  keySatisfies,
  machineFacts,
  missingKeys,
  REPO_PATTERN_MATCH_SQL,
  routingFor,
  type ExclusiveRule,
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
    // (see also the repo-pattern agreement test below)
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

describe('repo rules (ADR-0013 amendment 2026-10-30)', () => {
  const reqs = ['claude'];
  const repo = 'github.com/work/app';
  const laptop = machineFacts('laptop', [repo], ['claude']);
  const mac = machineFacts('mac', [repo], ['claude']);
  const personalOnly = machineFacts('server', [repo], ['claude'], ['github.com/me/*']);
  const workExclusive: ExclusiveRule[] = [
    { machineId: 'laptop', name: 'Work laptop', patterns: ['github.com/work/*'] },
  ];

  it('cannotTake: its own repo_allow, and another machine’s repo_exclusive', () => {
    expect(cannotTake(personalOnly, repo, reqs)).toEqual({
      missing_capabilities: [],
      excluded_by_rule: true,
    });
    expect(cannotTake(personalOnly, 'github.com/me/site', reqs)).toEqual({
      missing_repo: 'github.com/me/site',
      missing_capabilities: [],
    });
    expect(cannotTake(mac, repo, reqs, workExclusive)).toEqual({
      missing_capabilities: [],
      exclusive_to: ['Work laptop'],
    });
    // The holder's own rule doesn't exclude it.
    expect(cannotTake(laptop, repo, reqs, workExclusive)).toBeNull();
    expect(cannotTake(mac, 'github.com/me/site', reqs, workExclusive)).toEqual({
      missing_repo: 'github.com/me/site',
      missing_capabilities: [],
    });
  });

  it('routingFor: undefined while the holder is online, exclusive_to while it is offline', () => {
    expect(routingFor([laptop, mac], repo, reqs, workExclusive)).toBeUndefined();
    expect(routingFor([mac], repo, reqs, workExclusive)).toEqual({
      missing_capabilities: [],
      exclusive_to: ['Work laptop'],
    });
    expect(routingFor([], repo, reqs, workExclusive)).toEqual({
      missing_capabilities: [],
      exclusive_to: ['Work laptop'],
    });
  });

  it('routingFor: excluded_by_rule when every online machine’s allow-list leaves it out', () => {
    expect(routingFor([personalOnly], repo, reqs)).toEqual({
      missing_capabilities: [],
      excluded_by_rule: true,
    });
    // Another machine can take it: no routing.
    expect(routingFor([personalOnly, mac], repo, reqs)).toBeUndefined();
  });

  it('two machines holding the same repo exclusively block each other', () => {
    const both: ExclusiveRule[] = [
      ...workExclusive,
      { machineId: 'mac', name: 'Mac', patterns: [repo] },
    ];
    expect(routingFor([laptop, mac], repo, reqs, both)).toEqual({
      missing_capabilities: [],
      exclusive_to: ['Work laptop', 'Mac'],
    });
  });

  it('the claim’s SQL pattern match agrees with repoPatternMatches', async () => {
    const cases: [string, string][] = [
      ['github.com/org/app', 'github.com/org/app'],
      ['github.com/Org/App', 'github.com/org/app'],
      ['github.com/org/app', 'github.com/org/app2'],
      ['github.com/org/*', 'github.com/ORG/app'],
      ['github.com/org/*', 'github.com/org2/app'],
      ['github.com/org/*', 'github.com/org'],
      ['gitlab.com/g/*', 'gitlab.com/g/sub/app'],
      ['github.com/my_org/*', 'github.com/myXorg/app'],
    ];
    const r = await db.pool.query<{ p: string; repo: string; ok: boolean }>(
      `SELECT c.p, t.repo, ${REPO_PATTERN_MATCH_SQL} AS ok
         FROM unnest($1::text[], $2::text[]) AS c(p, r) CROSS JOIN LATERAL (SELECT c.r AS repo) t`,
      [cases.map((c) => c[0]), cases.map((c) => c[1])],
    );
    expect(r.rows.map((x) => [x.p, x.repo, x.ok])).toEqual(
      cases.map(([p, repo]) => [p, repo, repoPatternMatches(p, repo)]),
    );
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

  it('names the exclusive holder while it is offline; nothing once it is online', async () => {
    const scope = await newAccount(db.pool);
    const capable = { ...DEFAULT_INVENTORY.repos[0]!, remote: 'github.com/work/app' };
    const other = await machine(scope, 'online', 'github.com/work/app');
    await ingestInventory(
      db.pool,
      { machineId: other, accountId: scope.account_id },
      { ...DEFAULT_INVENTORY, repos: [capable] },
    );
    const laptop = await machine(scope, 'offline', 'github.com/work/app');
    await db.pool.query(
      `UPDATE machine SET name = 'Work laptop', repo_exclusive = '{github.com/work/*}' WHERE id = $1`,
      [laptop],
    );
    expect((await card(scope, 'github.com/work/app')).routing).toEqual({
      missing_capabilities: [],
      exclusive_to: ['Work laptop'],
    });
    await db.pool.query(`UPDATE machine SET revoked_at = now() WHERE id = $1`, [laptop]);
    expect((await card(scope, 'github.com/work/app')).routing).toBeUndefined();
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
