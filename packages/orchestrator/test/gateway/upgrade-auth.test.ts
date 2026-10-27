// M2-T09: daemon WS upgrade auth and register checks (10-contracts §Machines protocol v2,
// "Versioning and auth"). Fake daemons against the real gateway and Postgres (`pnpm db:up`).
import {
  CLOSE_PROTOCOL,
  CLOSE_REASONS,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  LOCAL_ACCOUNT_ID,
} from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineCredentialRow, MachineRow } from '../../src/db/types.js';
import { requireCredentialFromEnv } from '../../src/gateway/index.js';
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

afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const machineRow = async (id: string) =>
  (await db.pool.query<MachineRow>('SELECT * FROM machine WHERE id = $1', [id])).rows[0]!;

describe('requireCredentialFromEnv', () => {
  it('is on only for CONDUCTOR_AUTH=password', () => {
    expect(requireCredentialFromEnv({})).toBe(false);
    expect(requireCredentialFromEnv({ CONDUCTOR_AUTH: 'local' })).toBe(false);
    expect(requireCredentialFromEnv({ CONDUCTOR_AUTH: 'password' })).toBe(true);
    expect(() => requireCredentialFromEnv({ CONDUCTOR_AUTH: 'github' })).toThrow();
  });
});

describe('password mode', () => {
  it('no header or an unknown credential → 401 and no machine row touched', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id } = await enrolled(db.pool, scope);
    const before = await machineRow(machine_id);
    const count = await db.pool.query('SELECT count(*) AS n FROM machine');

    expect(await upgrade(h.port)).toBe(401);
    expect(await upgrade(h.port, 'not-a-credential')).toBe(401);

    expect(await machineRow(machine_id)).toEqual(before);
    expect((await db.pool.query('SELECT count(*) AS n FROM machine')).rows).toEqual(count.rows);
  });

  it('a revoked credential → 401; a revoked machine → 401', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const a = await enrolled(db.pool, scope);
    const b = await enrolled(db.pool, scope);
    expect(await upgrade(h.port, a.credential)).toBe('open');
    await db.pool.query('UPDATE machine_credential SET revoked_at = now() WHERE machine_id = $1', [
      a.machine_id,
    ]);
    expect(await upgrade(h.port, a.credential)).toBe(401);
    await db.pool.query('UPDATE machine SET revoked_at = now() WHERE id = $1', [b.machine_id]);
    expect(await upgrade(h.port, b.credential)).toBe(401);
  });

  it('a valid credential registers: scope, facts, versions, last_used_at', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope, 'enrolled-name');
    const d = await connectAndRegister(h, machine_id, credential, { hostname: 'renamed.local' });
    const reg = await d.next('registered');
    expect(reg.payload).toMatchObject({ machine_id, last_seq: null });
    expect(await machineRow(machine_id)).toMatchObject({
      account_id: scope.account_id,
      status: 'online',
      hostname: 'renamed.local',
      // The name is the user's: register never overwrites it.
      name: 'enrolled-name',
      protocol_version: 2,
      daemon_version: '0.2.0',
      max_sessions: 2,
    });
    const cred = (
      await db.pool.query<MachineCredentialRow>(
        'SELECT * FROM machine_credential WHERE machine_id = $1',
        [machine_id],
      )
    ).rows[0]!;
    expect(cred.last_used_at).toBeInstanceOf(Date);
    expect(h.gateway.transport.isConnected(machine_id)).toBe(true);
  });

  it("register with another machine's id → close 4003, the other machine untouched", async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const mine = await enrolled(db.pool, scope);
    const other = await enrolled(db.pool, await newAccount(db.pool));
    const before = await machineRow(other.machine_id);
    const d = await connectAndRegister(h, other.machine_id, mine.credential);
    expect(await d.closedWith).toEqual({
      code: CLOSE_UNAUTHORIZED,
      reason: CLOSE_REASONS[CLOSE_UNAUTHORIZED],
    });
    expect(await machineRow(other.machine_id)).toEqual(before);
    expect(h.gateway.transport.isConnected(other.machine_id)).toBe(false);
  });

  it('protocol_version 1 (or absent) → close 4005', async () => {
    h = await startGateway(db.pool, true);
    const { machine_id, credential } = await enrolled(db.pool, await newAccount(db.pool));
    for (const over of [{ protocol_version: 1 }, { protocol_version: undefined }]) {
      const d = await connectAndRegister(h, machine_id, credential, over);
      expect(await d.closedWith).toEqual({
        code: CLOSE_PROTOCOL,
        reason: CLOSE_REASONS[CLOSE_PROTOCOL],
      });
    }
    expect(await machineRow(machine_id)).toMatchObject({
      status: 'offline',
      protocol_version: null,
    });
  });

  it('a machine revoked between the upgrade and register → close 4003', async () => {
    h = await startGateway(db.pool, true);
    const { machine_id, credential } = await enrolled(db.pool, await newAccount(db.pool));
    const d = await FakeDaemon.connect(h.port, machine_id, credential);
    h.daemons.push(d);
    await db.pool.query('UPDATE machine SET revoked_at = now() WHERE id = $1', [machine_id]);
    d.register({ protocol_version: 2 });
    expect((await d.closedWith).code).toBe(CLOSE_UNAUTHORIZED);
    expect(await machineRow(machine_id)).toMatchObject({ status: 'offline' });
  });
});

describe('local mode', () => {
  it('an M1 register without a header still works, in the local account', async () => {
    h = await startGateway(db.pool, false);
    const id = `m-local-${Date.now()}`;
    const d = await FakeDaemon.connect(h.port, id);
    h.daemons.push(d);
    d.register(); // M1 shape: enrollment_token null, no protocol_version
    expect((await d.next('registered')).payload.machine_id).toBe(id);
    expect(await machineRow(id)).toMatchObject({
      account_id: LOCAL_ACCOUNT_ID,
      name: `${id}.local`,
      status: 'online',
      protocol_version: 1,
      daemon_version: '0.0.0',
    });
  });

  it('a second connection replaces the first with CLOSE_REPLACED', async () => {
    h = await startGateway(db.pool, false);
    const id = `m-repl-${Date.now()}`;
    const first = await FakeDaemon.connect(h.port, id);
    h.daemons.push(first);
    first.register();
    await first.next('registered');
    const second = await FakeDaemon.connect(h.port, id);
    h.daemons.push(second);
    second.register();
    await second.next('registered');
    expect(await first.closedWith).toEqual({
      code: CLOSE_REPLACED,
      reason: CLOSE_REASONS[CLOSE_REPLACED],
    });
    expect(h.gateway.transport.isConnected(id)).toBe(true);
  });

  it('a revoked machine is refused with 4003', async () => {
    h = await startGateway(db.pool, false);
    const id = `m-rev-${Date.now()}`;
    const d = await FakeDaemon.connect(h.port, id);
    h.daemons.push(d);
    d.register();
    await d.next('registered');
    await d.close();
    await db.pool.query('UPDATE machine SET revoked_at = now() WHERE id = $1', [id]);
    const again = await FakeDaemon.connect(h.port, id);
    h.daemons.push(again);
    again.register();
    expect((await again.closedWith).code).toBe(CLOSE_UNAUTHORIZED);
  });
});
