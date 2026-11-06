// ADR-0039: `start_session.permission_mode` from the ticket's setting and the machine's default.
// Real Postgres: the helper reads both columns and the machine's features in one query.
import { randomUUID } from 'node:crypto';
import { DAEMON_FEATURE_PERMISSION_MODE, type JsonObject } from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { skipPermissionsOn, withSkipPermissions } from '../../src/engine/skip-permissions.js';
import { useTestDatabase } from '../db.js';
import { seedBase } from './fixtures.js';

const db = useTestDatabase();

beforeAll(async () => {
  await seedBase(db.pool);
});

async function machine(def: boolean, features: string[]): Promise<string> {
  const id = `m-${randomUUID().slice(0, 8)}`;
  await db.pool.query(
    'INSERT INTO machine (id, hostname, os, arch, cpu_total, mem_total_mb, disk_free_mb, ' +
      'budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds, ' +
      'skip_permissions_default, features) ' +
      "VALUES ($1, 'h', 'linux', 'x64', 8, 16000, 100000, 4, 8000, 2, 1, $2, $3)",
    [id, def, features],
  );
  return id;
}

async function ticket(skip: boolean | null): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    "INSERT INTO ticket (repo, title, workflow_id, skip_permissions) VALUES ('github.com/x/a', 't', " +
      "'m1_basic', $1) RETURNING id",
    [skip],
  );
  return r.rows[0]!.id;
}

const START: JsonObject = { prompt: 'p', tools: ['read'] };
const FEATURES = [DAEMON_FEATURE_PERMISSION_MODE];

describe('withSkipPermissions (ADR-0039)', () => {
  it.each([
    [true, false, true],
    [null, true, true],
    [false, true, false],
    [null, false, false],
  ] as const)('ticket %s, machine default %s → bypass %s', async (t, def, want) => {
    const out = await withSkipPermissions(
      db.pool,
      START,
      await ticket(t),
      `machine:${await machine(def, FEATURES)}`,
    );
    expect(out.permission_mode).toBe(want ? 'bypassPermissions' : undefined);
    if (!want) expect(out).toEqual(START);
  });

  it('never for a reviewer or QA start, a daemon without the feature, or a non-machine target', async () => {
    const t = await ticket(true);
    const m = await machine(true, FEATURES);
    const review = { ...START, review: true };
    expect(await withSkipPermissions(db.pool, review, t, `machine:${m}`)).toEqual(review);
    const old = await machine(true, ['assistant_job']);
    expect(await withSkipPermissions(db.pool, START, t, `machine:${old}`)).toEqual(START);
    expect(await withSkipPermissions(db.pool, START, t, 'connector:x')).toEqual(START);
  });

  it('skipPermissionsOn: the ticket wins; with no machine only the ticket counts', async () => {
    const on = await machine(true, []);
    expect(await skipPermissionsOn(db.pool, await ticket(null), on)).toBe(true);
    expect(await skipPermissionsOn(db.pool, await ticket(false), on)).toBe(false);
    expect(await skipPermissionsOn(db.pool, await ticket(true), null)).toBe(true);
    expect(await skipPermissionsOn(db.pool, await ticket(null), null)).toBe(false);
    expect(await skipPermissionsOn(db.pool, randomUUID(), on)).toBe(false);
  });
});
