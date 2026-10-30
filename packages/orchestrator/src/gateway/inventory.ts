import {
  capabilityKeys,
  type AlertPayload,
  type BoardSseEvent,
  type Capability,
  type InventoryPayload,
} from '@conductor/shared';
import { withTransaction } from '../db/index.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';

// M2-T16a: the v2 `inventory` and `alert` ingest (ADR-0013 §Inventory, U-060; 10-contracts
// §Machines protocol v2). Pays TD-112 (the gateway dropped both until now).

export interface MachineScope {
  machineId: string;
  /** The connection's account; every write is scoped to it. */
  accountId: string;
}

interface CapabilityRow {
  key: string;
  kind: Capability['kind'];
  name: string;
  version: string | null;
  detail: Record<string, unknown>;
}

/** One row per `capabilityKeys(c)` element; display columns for the Machines drawer. */
function capabilityRows(caps: readonly Capability[]): CapabilityRow[] {
  const byKey = new Map<string, CapabilityRow>();
  for (const c of caps) {
    const detail: Record<string, unknown> =
      c.kind === 'cli'
        ? { authed: c.authed }
        : (c.kind === 'skill' || c.kind === 'agent') && c.repo !== undefined
          ? { repo: c.repo }
          : {};
    for (const key of capabilityKeys(c)) {
      byKey.set(key, {
        key,
        kind: c.kind,
        name: 'name' in c ? c.name : 'claude',
        version: 'version' in c ? c.version : null,
        detail,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * `inventory`: replaces the machine's machine_repo and machine_capability rows wholesale, in one
 * transaction. A repo is keyed by its path (`machine_repo.repo = path`: unique per machine, while
 * two checkouts may share a remote); one with `remote: null` is kept for display and never
 * routed to. Nothing is written for a revoked machine or another account's.
 */
export async function ingestInventory(
  db: Db,
  scope: MachineScope,
  payload: InventoryPayload,
): Promise<void> {
  const repos = [...new Map(payload.repos.map((r) => [r.path, r])).values()];
  const caps = capabilityRows(payload.capabilities);
  await withTransaction(db, async (tx) => {
    const m = await tx.query(
      `SELECT 1 FROM machine WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
          FOR SHARE`,
      [scope.machineId, scope.accountId],
    );
    if (m.rowCount === 0) return;
    await tx.query('DELETE FROM machine_repo WHERE machine_id = $1', [scope.machineId]);
    if (repos.length > 0) {
      await tx.query(
        `INSERT INTO machine_repo (machine_id, account_id, repo, path, head_commit, remote,
                                   default_branch, mode)
         SELECT $1, $2, p, p, h, r, b, md
           FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                AS x(p, h, r, b, md)`,
        [
          scope.machineId,
          scope.accountId,
          repos.map((r) => r.path),
          repos.map((r) => r.head_commit),
          repos.map((r) => r.remote),
          repos.map((r) => r.default_branch),
          repos.map((r) => r.mode),
        ],
      );
    }
    await tx.query('DELETE FROM machine_capability WHERE machine_id = $1', [scope.machineId]);
    if (caps.length > 0) {
      await tx.query(
        `INSERT INTO machine_capability (machine_id, account_id, key, kind, name, version, detail)
         SELECT $1, $2, k, kd, n, v, d
           FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::jsonb[])
                AS x(k, kd, n, v, d)`,
        [
          scope.machineId,
          scope.accountId,
          caps.map((c) => c.key),
          caps.map((c) => c.kind),
          caps.map((c) => c.name),
          caps.map((c) => c.version),
          caps.map((c) => JSON.stringify(c.detail)),
        ],
      );
    }
  });
}

/**
 * `alert` (durable): deduped on `(machine_id, seq)` with the session_event `last_seq` guard, then
 * one machine_alert row. Its `session_id` is kept only for a session of this machine and account.
 * Returns the session card's `card.upserted` (the card shows its open alerts), if any.
 */
export async function ingestAlert(
  db: Db,
  scope: MachineScope,
  seq: number,
  payload: AlertPayload,
): Promise<BoardSseEvent[]> {
  return withTransaction(db, async (tx) => {
    const fresh = await tx.query(
      `UPDATE machine SET last_seq = $2
        WHERE id = $1 AND account_id = $3 AND revoked_at IS NULL
          AND (last_seq IS NULL OR last_seq < $2)`,
      [scope.machineId, seq, scope.accountId],
    );
    if (fresh.rowCount === 0) return [];
    let sessionId: string | null = null;
    if (payload.session_id !== undefined) {
      const s = await tx.query(
        'SELECT 1 FROM session WHERE id = $1 AND machine_id = $2 AND account_id = $3',
        [payload.session_id, scope.machineId, scope.accountId],
      );
      if ((s.rowCount ?? 0) > 0) sessionId = payload.session_id;
    }
    await tx.query(
      `INSERT INTO machine_alert (machine_id, account_id, session_id, kind, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        scope.machineId,
        scope.accountId,
        sessionId,
        payload.kind,
        JSON.stringify({ repo: payload.repo, files: payload.files, at: payload.at }),
      ],
    );
    return sessionId === null ? [] : cardUpserted(tx, sessionId);
  });
}
