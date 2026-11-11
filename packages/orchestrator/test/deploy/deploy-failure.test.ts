// R14: `conductor-admin deploy-failed`, run in-process against a test database: one ticket per
// failed sha, updated on a repeat, and one push per failed attempt. Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAdminCli } from '../../src/auth/admin-commands.js';
import { useTestDatabase } from '../db.js';

const db = useTestDatabase();
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const OTHER = '1111111111111111111111111111111111111111';

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    sha: SHA,
    subject: 'feat: something',
    step: 'building the orchestrator image',
    outcome: 'rolled_back',
    running: '0123456789abcdef0123456789abcdef01234567',
    run_url: 'https://github.com/benjgrad/conductor/actions/runs/1',
    repo: 'github.com/benjgrad/conductor',
    log_tail: 'boom',
    attempted_at: '2026-11-11T10:00:00Z',
    ...over,
  });

const run = async (stdin: string, argv = ['deploy-failed']) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCli(argv, {
    db: db.pool,
    publicUrl: null,
    now: () => new Date(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: () => Promise.resolve(stdin),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const tickets = (sha: string) =>
  db.pool.query<{ id: string; title: string; body: string; status: string; kind: string }>(
    'SELECT id, title, body, status, kind FROM ticket WHERE external_ref = $1',
    [`deploy:${sha}`],
  );
const pushKeys = async () =>
  (
    await db.pool.query<{ idempotency_key: string; session_id: string | null }>(
      "SELECT idempotency_key, session_id FROM outbox WHERE idempotency_key LIKE 'deploy:%' ORDER BY id",
    )
  ).rows;

beforeEach(async () => {
  await db.pool.query("DELETE FROM outbox WHERE idempotency_key LIKE 'deploy:%'");
  await db.pool.query("DELETE FROM ticket WHERE external_ref LIKE 'deploy:%'");
  await db.pool.query('DELETE FROM push_subscription');
  await db.pool.query(
    `INSERT INTO push_subscription (account_id, user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, 'https://push.test/a', 'BKey', 'auth')`,
    [LOCAL_ACCOUNT_ID, randomUUID()],
  );
});

describe('deploy-failed', () => {
  it('opens one ready ticket for a sha and updates it on a repeat', async () => {
    const first = await run(report());
    expect(first).toMatchObject({ code: 0 });
    expect(first.out).toMatch(/^created ticket \S+ \(attempt 1, 1 push\(es\)\)$/);

    const second = await run(
      report({ step: 'smoke test', attempted_at: '2026-11-11T11:00:00Z', log_tail: 'again' }),
    );
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/^updated ticket \S+ \(attempt 2, 1 push\(es\)\)$/);

    const rows = (await tickets(SHA)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Deploy of abcdef1 failed: smoke test',
      status: 'ready',
      kind: 'work',
    });
    expect(rows[0]!.body).toContain('## Attempt 2 (2026-11-11T11:00:00Z)');
    expect(rows[0]!.body).toContain('again');

    expect(await pushKeys()).toEqual([
      { idempotency_key: `deploy:${SHA}:1`, session_id: null },
      { idempotency_key: `deploy:${SHA}:2`, session_id: null },
    ]);
  });

  it('records the same report once', async () => {
    await run(report());
    await run(report({ step: 'smoke test', attempted_at: '2026-11-11T11:00:00Z' }));
    const again = await run(report({ step: 'smoke test', attempted_at: '2026-11-11T11:00:00Z' }));
    expect(again.out).toMatch(/\(attempt 2, 0 push\(es\)\)$/);
    expect((await tickets(SHA)).rows[0]!.body.match(/## Attempt/g)).toHaveLength(1);
    expect(await pushKeys()).toHaveLength(2);
  });

  it('opens a second ticket for a different sha', async () => {
    await run(report());
    await run(report({ sha: OTHER }));
    expect((await tickets(SHA)).rows).toHaveLength(1);
    expect((await tickets(OTHER)).rows).toHaveLength(1);
  });

  it('refuses a bad report, and arguments', async () => {
    expect(await run('not json')).toMatchObject({ code: 2 });
    const bad = await run(report({ sha: 'abc' }));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('sha');
    expect(await run(report(), ['deploy-failed', 'x'])).toMatchObject({ code: 2 });
    expect((await tickets(SHA)).rows).toHaveLength(0);
  });
});
