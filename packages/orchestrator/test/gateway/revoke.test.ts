// M2-T09: revokeMachine (10-contracts §Machines protocol v2, "Revoke and the outbox (R4)").
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { CLOSE_REASONS, CLOSE_REVOKED, type AccountScope } from '@conductor/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MachineCredentialRow, MachineRow, OutboxRow } from '../../src/db/types.js';
import { revokeMachine } from '../../src/gateway/revoke.js';
import { useTestDatabase } from '../db.js';
import {
  connectAndRegister,
  enrolled,
  newAccount,
  startGateway,
  upgrade,
  type Harness,
} from './auth-harness.js';
import { FakeDaemon } from './fake-daemon.js';

const db = useTestDatabase();
let h: Harness | undefined;

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_revoke', 1, '{}')
     ON CONFLICT DO NOTHING`,
  );
});

afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function session(scope: AccountScope, machineId: string, status: string): Promise<string> {
  const t = await db.pool.query<{ id: string }>(
    `INSERT INTO ticket (account_id, repo, title, workflow_id)
     VALUES ($1, 'github.com/o/app', 't', 'wf_revoke') RETURNING id`,
    [scope.account_id],
  );
  const s = await db.pool.query<{ id: string }>(
    `INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, status)
     VALUES ($1, $2, $3, 'wf_revoke', 1, $4) RETURNING id`,
    [scope.account_id, t.rows[0]!.id, machineId, status],
  );
  return s.rows[0]!.id;
}

async function outbox(
  scope: AccountScope,
  machineId: string,
  sessionId: string,
  kind: string,
  status: string,
  payload: object,
  token: string | null = null,
): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO outbox (account_id, command_id, target, kind, session_id, payload, status,
                         fencing_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      scope.account_id,
      randomUUID(),
      `machine:${machineId}`,
      kind,
      sessionId,
      payload,
      status,
      token,
    ],
  );
  return r.rows[0]!.id;
}

const outboxRows = async (machineId: string) =>
  (
    await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE target = $1 ORDER BY id', [
      `machine:${machineId}`,
    ])
  ).rows;

describe('revokeMachine', () => {
  it('closes the live socket with 4001 in < 1 s; the credential no longer upgrades', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const d = await connectAndRegister(h, machine_id, credential);
    await d.next('registered');

    const started = Date.now();
    const res = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect(res).toEqual({ machine_id, live_session_ids: [] });
    expect(await d.closedWith).toEqual({
      code: CLOSE_REVOKED,
      reason: CLOSE_REASONS[CLOSE_REVOKED],
    });
    expect(Date.now() - started).toBeLessThan(1000);

    expect(await upgrade(h.port, credential)).toBe(401);
    const m = (await db.pool.query<MachineRow>('SELECT * FROM machine WHERE id = $1', [machine_id]))
      .rows[0]!;
    expect(m.status).toBe('offline');
    expect(m.revoked_at).toBeInstanceOf(Date);
    const creds = (
      await db.pool.query<MachineCredentialRow>(
        'SELECT * FROM machine_credential WHERE machine_id = $1',
        [machine_id],
      )
    ).rows;
    expect(creds.every((c) => c.revoked_at instanceof Date)).toBe(true);
  });

  it("fails the machine's pending and sent outbox rows; another machine's are untouched", async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const a = await enrolled(db.pool, scope, 'a');
    const b = await enrolled(db.pool, scope, 'b');
    const sa = await session(scope, a.machine_id, 'running');
    const parked = await session(scope, a.machine_id, 'needs_input');
    await session(scope, a.machine_id, 'done');
    const sb = await session(scope, b.machine_id, 'running');

    await outbox(scope, a.machine_id, sa, 'start_session', 'pending', { prompt: 'secret' });
    await outbox(scope, a.machine_id, sa, 'send_input', 'sent', { text: 'x' });
    // A fenced kill left by an earlier lease_expired (a lower token than the session's).
    await outbox(scope, a.machine_id, sa, 'kill', 'pending', { reason: 'machine_lost' }, '1');
    const acked = await outbox(scope, a.machine_id, sa, 'kill', 'acked', {});
    await outbox(scope, b.machine_id, sb, 'start_session', 'pending', { prompt: 'keep' });
    await outbox(scope, b.machine_id, sb, 'send_input', 'sent', { text: 'y' });
    const otherBefore = await outboxRows(b.machine_id);

    const res = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, a.machine_id);
    expect(res?.live_session_ids.sort()).toEqual([sa, parked].sort());

    const rows = await outboxRows(a.machine_id);
    for (const r of rows.filter((r) => r.id !== acked)) {
      expect([r.kind, r.status, r.last_error]).toEqual([r.kind, 'failed', 'machine_revoked']);
    }
    expect(rows.find((r) => r.id === acked)).toMatchObject({ status: 'acked', last_error: null });
    // A terminal start_session row has its prompt scrubbed (10-contracts §Outbox state machine).
    expect(rows.find((r) => r.kind === 'start_session')?.payload).toEqual({ prompt: null });
    expect(await outboxRows(b.machine_id)).toEqual(otherBefore);
  });

  it("another account's scope → null and nothing changes; revoking twice is idempotent", async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const stranger = await newAccount(db.pool);
    expect(
      await revokeMachine({ db: db.pool, sockets: h.gateway }, stranger, machine_id),
    ).toBeNull();
    expect(await upgrade(h.port, credential)).toBe('open');

    const first = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    const at = (
      await db.pool.query<MachineRow>('SELECT revoked_at FROM machine WHERE id = $1', [machine_id])
    ).rows[0]!.revoked_at;
    const second = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect(second).toEqual(first);
    const again = (
      await db.pool.query<MachineRow>('SELECT revoked_at FROM machine WHERE id = $1', [machine_id])
    ).rows[0]!.revoked_at;
    expect(again).toEqual(at);
  });

  it('also closes a connection that authenticated but has not registered yet', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const d = await FakeDaemon.connect(h.port, machine_id, credential);
    h.daemons.push(d);
    await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect((await d.closedWith).code).toBe(CLOSE_REVOKED);
  });
});
