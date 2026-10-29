// M2-T16a: `inventory` and `alert` ingest through the gateway (ADR-0013 §Inventory, U-060;
// 10-contracts §Machines protocol v2). Pays TD-112. Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertPayload, BoardCard } from '@conductor/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadBoard } from '../../src/api/queries.js';
import type { MachineAlertRow, MachineCapabilityRow, MachineRepoRow } from '../../src/db/types.js';
import { useTestDatabase } from '../db.js';
import { startGateway, type Harness } from './auth-harness.js';
import { DEFAULT_INVENTORY, FakeDaemon } from './fake-daemon.js';

const db = useTestDatabase();
let h: Harness | undefined;

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

afterEach(async () => {
  await h?.stop();
  h = undefined;
});

/** A local-mode gateway and a registered daemon (protocol v2 unless `v1`). */
async function daemon(opts: { v1?: boolean } = {}): Promise<{ d: FakeDaemon; tag: string }> {
  h = await startGateway(db.pool, false);
  const tag = `t-${randomUUID().slice(0, 8)}`;
  const d = await FakeDaemon.connect(h.port, `m-${tag}`);
  h.daemons.push(d);
  d.register({ tags: [tag], ...(opts.v1 ? {} : { protocol_version: 2 }) });
  await d.next('registered');
  return { d, tag };
}

const repos = async (machineId: string) =>
  (
    await db.pool.query<MachineRepoRow>(
      'SELECT * FROM machine_repo WHERE machine_id = $1 ORDER BY path',
      [machineId],
    )
  ).rows;
const keys = async (machineId: string) =>
  (
    await db.pool.query<MachineCapabilityRow>(
      'SELECT * FROM machine_capability WHERE machine_id = $1 ORDER BY key',
      [machineId],
    )
  ).rows.map((r) => r.key);
const alerts = async (machineId: string) =>
  (
    await db.pool.query<MachineAlertRow>(
      'SELECT * FROM machine_alert WHERE machine_id = $1 ORDER BY created_at',
      [machineId],
    )
  ).rows;

const ALERT: AlertPayload = {
  kind: 'git_tamper',
  repo: '/src/app',
  files: ['hooks/pre-commit'],
  at: '2026-10-29T12:00:00.000Z',
};

describe('inventory ingest', () => {
  it('a second inventory replaces the first, repos and capabilities', async () => {
    const { d } = await daemon();
    d.inventory({
      repos: [
        ...DEFAULT_INVENTORY.repos,
        {
          path: '/src/scratch',
          remote: null,
          default_branch: 'main',
          head_commit: 'b'.repeat(40),
          mode: 'checkout',
        },
      ],
      capabilities: [
        ...DEFAULT_INVENTORY.capabilities,
        { kind: 'skill', name: 'review', repo: 'github.com/x/app' },
      ],
    });
    await d.settle();
    expect(
      (await repos(d.machineId)).map((r) => [r.repo, r.path, r.remote, r.mode, r.default_branch]),
    ).toEqual([
      ['/src/app', '/src/app', 'github.com/x/app', 'reference', 'main'],
      ['/src/scratch', '/src/scratch', null, 'checkout', 'main'],
    ]);
    expect(await keys(d.machineId)).toEqual([
      'claude',
      'cli:gh',
      'cli:gh:authed',
      'skill:review@github.com/x/app',
    ]);
    const caps = await db.pool.query<MachineCapabilityRow>(
      `SELECT * FROM machine_capability WHERE machine_id = $1 AND key = 'cli:gh:authed'`,
      [d.machineId],
    );
    expect(caps.rows[0]).toMatchObject({ kind: 'cli', name: 'gh', detail: { authed: true } });

    d.inventory({
      repos: [{ ...DEFAULT_INVENTORY.repos[0]!, path: '/src/other' }],
      capabilities: [{ kind: 'cli', name: 'az', version: null, authed: false }],
    });
    await d.settle();
    expect((await repos(d.machineId)).map((r) => r.path)).toEqual(['/src/other']);
    expect(await keys(d.machineId)).toEqual(['cli:az']);
  });

  it('a v2 daemon’s legacy repo_inventory leaves the inventory rows alone', async () => {
    const { d } = await daemon();
    d.inventory();
    d.repoInventory([
      { repo: 'github.com/x/clone', path: '/clones/x', head_commit: 'c', tree_clean: true },
    ]);
    await d.settle();
    expect((await repos(d.machineId)).map((r) => r.path)).toEqual(['/src/app']);
  });

  it('a v1 daemon’s repo_inventory still writes machine_repo', async () => {
    const { d } = await daemon({ v1: true });
    d.repoInventory([
      { repo: 'github.com/x/clone', path: '/clones/x', head_commit: 'c', tree_clean: true },
    ]);
    await d.settle();
    expect((await repos(d.machineId)).map((r) => [r.repo, r.path])).toEqual([
      ['github.com/x/clone', '/clones/x'],
    ]);
  });
});

describe('alert ingest', () => {
  it('stores one row per seq; a replayed seq adds none; no session = no card event', async () => {
    const { d } = await daemon();
    d.alert(1, { ...ALERT, session_id: randomUUID() }); // not this machine's: kept without it
    d.alert(1, ALERT);
    await d.settle();
    const rows = await alerts(d.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'git_tamper',
      session_id: null,
      detail: { repo: '/src/app', files: ['hooks/pre-commit'], at: ALERT.at },
    });
    expect(h!.boardBus.published.filter((e) => e.type === 'card.upserted')).toEqual([]);
  });

  it('an alert for the machine’s session shows on its card (event and board)', async () => {
    const { d, tag } = await daemon();
    d.inventory();
    const t = await db.pool.query<{ id: string }>(
      `INSERT INTO ticket (repo, title, workflow_id, required_tags)
       VALUES ('github.com/x/app', 'tamper', 'm1_basic', $1) RETURNING id`,
      [[tag]],
    );
    d.requestWork();
    const wa = await d.next('work_assignment');
    const sessionId = wa.payload.session_id;
    const before = h!.boardBus.published.length;

    d.alert(7, { ...ALERT, session_id: sessionId });
    await d.settle();
    expect((await alerts(d.machineId)).map((a) => a.session_id)).toEqual([sessionId]);
    const expected = [{ kind: 'git_tamper', files: ['hooks/pre-commit'], at: ALERT.at }];
    const ev = h!.boardBus.published
      .slice(before)
      .find((e) => e.type === 'card.upserted' && e.session_id === sessionId);
    expect(ev?.type === 'card.upserted' && ev.card.alerts).toEqual(expected);

    const board = await loadBoard(db.pool);
    const card = board.columns
      .flatMap((c) => c.cards)
      .find((c: BoardCard) => c.ticket_id === t.rows[0]!.id);
    expect(card?.alerts).toEqual(expected);
  });
});
