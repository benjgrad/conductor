/** M2-T16a: give a machine an inventory the way the gateway stores one (tests that claim). */
import type { InventoryPayload } from '@conductor/shared';
import type { Pool } from 'pg';
import { ingestInventory } from '../../src/gateway/inventory.js';
import { DEFAULT_INVENTORY } from './fake-daemon.js';

/**
 * DEFAULT_INVENTORY (`claude`, an authed `gh`) with the repo at `remote` (default
 * `github.com/x/app`), stored for `machineId` in its own account.
 */
export async function seedInventory(
  pool: Pool,
  machineId: string,
  opts: { remote?: string; over?: Partial<InventoryPayload> } = {},
): Promise<void> {
  const m = await pool.query<{ account_id: string }>(
    'SELECT account_id FROM machine WHERE id = $1',
    [machineId],
  );
  const accountId = m.rows[0]!.account_id;
  const repos = DEFAULT_INVENTORY.repos.map((r) => ({
    ...r,
    remote: opts.remote ?? r.remote,
  }));
  await ingestInventory(
    pool,
    { machineId, accountId },
    { ...DEFAULT_INVENTORY, repos, ...opts.over },
  );
}
