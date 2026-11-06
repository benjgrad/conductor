import {
  DAEMON_FEATURE_PERMISSION_MODE,
  effectiveSkipPermissions,
  type JsonObject,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0039: "skip permissions". A working agent's `start_session` carries
// `permission_mode: 'bypassPermissions'` when the ticket's setting (or, when that is null, the
// machine's default) is on and the machine's daemon advertises DAEMON_FEATURE_PERMISSION_MODE.
// Every start re-reads both, so a toggle applies from the next process start.

/** The machine id of an outbox `target` (`machine:<id>`), else null. */
function machineOf(target: string): string | null {
  return target.startsWith('machine:') ? target.slice('machine:'.length) : null;
}

/**
 * Whether skip permissions is effectively on for `ticketId`'s sessions on `machineId` (null = no
 * machine: only the ticket's own setting counts).
 */
export async function skipPermissionsOn(
  q: Queryable,
  ticketId: string,
  machineId: string | null,
): Promise<boolean> {
  const r = await q.query<{ ticket: boolean | null; machine: boolean | null }>(
    `SELECT t.skip_permissions AS ticket, m.skip_permissions_default AS machine
       FROM ticket t LEFT JOIN machine m ON m.id = $2
      WHERE t.id = $1`,
    [ticketId, machineId],
  );
  const row = r.rows[0];
  return row !== undefined && effectiveSkipPermissions(row.ticket, row.machine);
}

/**
 * The `start_session` payload for `target` with `permission_mode` set when skip permissions is on.
 * Unchanged for a requirements reviewer or QA session (`review`), for a machine whose daemon can't
 * honour it, and when it is off.
 */
export async function withSkipPermissions(
  q: Queryable,
  payload: JsonObject,
  ticketId: string,
  target: string,
): Promise<JsonObject> {
  if (payload.review === true) return payload;
  const machineId = machineOf(target);
  if (machineId === null) return payload;
  const r = await q.query<{ ticket: boolean | null; machine: boolean; features: string[] }>(
    `SELECT t.skip_permissions AS ticket, m.skip_permissions_default AS machine, m.features
       FROM ticket t, machine m
      WHERE t.id = $1 AND m.id = $2`,
    [ticketId, machineId],
  );
  const row = r.rows[0];
  if (row === undefined || !effectiveSkipPermissions(row.ticket, row.machine)) return payload;
  if (!row.features.includes(DAEMON_FEATURE_PERMISSION_MODE)) return payload;
  return { ...payload, permission_mode: 'bypassPermissions' };
}
