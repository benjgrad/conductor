import { randomUUID } from 'node:crypto';
import {
  OrchestratorToDaemonSchema,
  permissionDecisionCommand,
  permissionSummary,
  SESSION_PERMISSION_REQUESTS_LIMIT,
  toBoardCard,
  type BoardCard,
  type BoardCardPermission,
  type BoardSseEvent,
  type OrchestratorToDaemon,
  type PermissionExpiryReason,
  type PermissionRequestDto,
  type SessionSnapshot,
} from '@conductor/shared';
import {
  insertBoardEvents,
  type BoardBus,
  type OutboxTransport,
  type Queryable,
} from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { PermissionRequestRow } from '../db/types.js';
import type { Db } from '../main.js';
import { cardView, withMachineFields } from '../engine/board-view.js';
import { lockSession, readOpenInput } from '../engine/rows.js';

// M2-T29c: permission requests as stored (ADR-0023; 10-contracts §Permission prompts). The
// sub-status `needs_permission` is derived from a session's pending rows, never stored: every
// write that changes them (request, decision, expiry) re-derives the card in the same transaction
// and emits `card.upserted`.

/** The deny message when a request arrives for a session that isn't running an agent. */
export const NOT_RUNNING_MESSAGE = 'the session is not running an agent';

/** The card's "Needs permission" fields; null = no pending request. */
export interface CardPermission {
  sub_status: 'needs_permission';
  permission: BoardCardPermission;
}

/** The oldest pending request of the session, and how many are pending. */
export async function readCardPermission(
  q: Queryable,
  sessionId: string,
): Promise<CardPermission | null> {
  const r = await q.query<
    Pick<PermissionRequestRow, 'id' | 'tool' | 'input' | 'expires_at'> & { pending_count: number }
  >(
    `SELECT id, tool, input, expires_at, count(*) OVER ()::int AS pending_count
       FROM permission_request
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY created_at, id LIMIT 1`,
    [sessionId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    sub_status: 'needs_permission',
    permission: {
      request_id: row.id,
      tool: row.tool,
      summary: permissionSummary(row.input),
      expires_at: row.expires_at.toISOString(),
      pending_count: row.pending_count,
    },
  };
}

/** Every session's card permission at once (the board load). */
export async function readCardPermissions(q: Queryable): Promise<Map<string, CardPermission>> {
  const r = await q.query<
    Pick<PermissionRequestRow, 'id' | 'session_id' | 'tool' | 'input' | 'expires_at'> & {
      pending_count: number;
    }
  >(
    `SELECT DISTINCT ON (session_id) id, session_id, tool, input, expires_at,
            count(*) OVER (PARTITION BY session_id)::int AS pending_count
       FROM permission_request
      WHERE status = 'pending'
      ORDER BY session_id, created_at, id`,
  );
  return new Map(
    r.rows.map((row) => [
      row.session_id,
      {
        sub_status: 'needs_permission',
        permission: {
          request_id: row.id,
          tool: row.tool,
          summary: permissionSummary(row.input),
          expires_at: row.expires_at.toISOString(),
          pending_count: row.pending_count,
        },
      },
    ]),
  );
}

/** The card with `sub_status` / `permission` set from `p` (both absent when null). */
export function withPermission(card: BoardCard, p: CardPermission | null): BoardCard {
  const { sub_status: _s, permission: _p, ...rest } = card;
  void _s;
  void _p;
  return p === null ? rest : { ...rest, sub_status: p.sub_status, permission: p.permission };
}

/**
 * The session's card as it is now (ticket, session, open input, permission), for a write that
 * only changes permission rows. The session must exist.
 */
export async function currentCard(tx: Queryable, sessionId: string): Promise<BoardCard> {
  const locked = await lockSession(tx, sessionId);
  if (!locked) throw new Error(`session ${sessionId} not found`);
  const { session, ticket } = locked;
  const view = await cardView(tx, session.workflow_id, session.workflow_version);
  return withMachineFields(
    tx,
    withPermission(
      toBoardCard(ticket, session, await readOpenInput(tx, sessionId), view),
      await readCardPermission(tx, sessionId),
    ),
    ticket,
  );
}

/** One `card.upserted` for the session's card (last write of the transaction). */
export async function cardUpserted(tx: Queryable, sessionId: string): Promise<BoardSseEvent[]> {
  const card = await currentCard(tx, sessionId);
  return insertBoardEvents(tx, [
    { type: 'card.upserted', session_id: sessionId, ticket_id: card.ticket_id, card },
  ]);
}

export function toPermissionRequestDto(row: PermissionRequestRow): PermissionRequestDto {
  const decided = row.status === 'allowed' || row.status === 'denied';
  return {
    id: row.id,
    session_id: row.session_id,
    tool: row.tool,
    input: row.input,
    suggestions: row.suggestions,
    summary: permissionSummary(row.input),
    always_rule: row.always_rule,
    status: row.status,
    decision:
      decided && row.behavior !== null && row.scope !== null
        ? {
            behavior: row.behavior,
            scope: row.scope,
            message: row.message,
            rule: row.rule,
            decided_by: row.decided_by,
          }
        : null,
    expired_reason: row.status === 'expired' ? row.expired_reason : null,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

/**
 * The session's last SESSION_PERMISSION_REQUESTS_LIMIT requests, oldest first, every pending one
 * included.
 */
export async function listSessionPermissionRequests(
  q: Queryable,
  sessionId: string,
): Promise<PermissionRequestDto[]> {
  const r = await q.query<PermissionRequestRow>(
    `SELECT * FROM permission_request
      WHERE session_id = $1
        AND (status = 'pending' OR id IN (
              SELECT id FROM permission_request WHERE session_id = $1
               ORDER BY created_at DESC, id DESC LIMIT $2))
      ORDER BY created_at, id`,
    [sessionId, SESSION_PERMISSION_REQUESTS_LIMIT],
  );
  return r.rows.map(toPermissionRequestDto);
}

/**
 * Expire every pending request of the session (`reason`), in the caller's transaction (which
 * holds the session row lock). Returns how many it expired; the caller re-derives the card.
 */
export async function expirePending(
  tx: Queryable,
  sessionId: string,
  reason: PermissionExpiryReason,
  now: Date,
): Promise<number> {
  const r = await tx.query(
    `UPDATE permission_request SET status = 'expired', expired_reason = $2, resolved_at = $3
      WHERE session_id = $1 AND status = 'pending'`,
    [sessionId, reason, now],
  );
  return r.rowCount ?? 0;
}

/**
 * Whether the session still holds the agent process a pending request was asked from:
 * `running`, process live, outside a gate step, in the same state with the same start command.
 */
function stillHolds(before: SessionSnapshot, after: SessionSnapshot): boolean {
  return (
    after.status === 'running' &&
    after.agent_process_live &&
    after.step === null &&
    after.workflow_state === before.workflow_state &&
    after.agent_command_id === before.agent_command_id
  );
}

/**
 * The EngineService wrapper's hook (10-contracts §Permission prompts, Expiry): after an applied
 * event, a session that no longer holds its agent process expires its pending requests in the
 * apply's transaction. `agent_gone` when the process exited (an `agent.exited`, or the process
 * went away while the session stayed put); `session_moved` otherwise (left the state, parked,
 * failed, finished, cancelled, a gate step began).
 */
export async function expireOnApply(
  tx: Queryable,
  sessionId: string,
  eventType: string,
  before: SessionSnapshot,
  after: SessionSnapshot,
  now: Date,
): Promise<number> {
  if (stillHolds(before, after)) return 0;
  const processGone =
    eventType === 'agent.exited' ||
    (!after.agent_process_live &&
      after.status === before.status &&
      after.workflow_state === before.workflow_state);
  return expirePending(tx, sessionId, processGone ? 'agent_gone' : 'session_moved', now);
}

/** The `permission_decision` frame for a decided row, on the session's current token. */
export function decisionFrame(
  row: Pick<
    PermissionRequestRow,
    'id' | 'session_id' | 'machine_id' | 'behavior' | 'scope' | 'message' | 'rule'
  >,
  commandId: string,
  fencingToken: number,
): OrchestratorToDaemon {
  if (row.behavior === null || row.scope === null) throw new Error(`request ${row.id} undecided`);
  const cmd = permissionDecisionCommand({
    command_id: commandId,
    machine_id: row.machine_id,
    request_id: row.id,
    behavior: row.behavior,
    scope: row.scope,
    message: row.message,
    rule: row.rule,
  });
  return OrchestratorToDaemonSchema.parse({
    type: cmd.kind,
    msg_id: randomUUID(),
    seq: null,
    session_id: row.session_id,
    fencing_token: fencingToken,
    payload: cmd.payload,
  });
}

// TD-179: best effort on the live socket (U-099); a decision that doesn't arrive ends in the
// daemon's own timeout deny.
/** Send a decision frame on the machine's live socket; never throws. */
export async function sendDecision(
  transport: OutboxTransport | undefined,
  machineId: string,
  frame: OrchestratorToDaemon,
  log: (msg: string) => void,
): Promise<void> {
  if (!transport) {
    log(`permission_decision for ${machineId} not sent: no live transport`);
    return;
  }
  try {
    const res = await transport.send(machineId, frame);
    if (res !== 'sent') log(`permission_decision not sent: machine ${machineId} not connected`);
  } catch (err) {
    log(`permission_decision to ${machineId} failed: ${String(err)}`);
  }
}

export interface PermissionSweepDeps {
  db: Db;
  boardBus: BoardBus;
  now: () => Date;
}

export const PERMISSION_SWEEP_BATCH = 100;

/**
 * `timeout` expiry: pending requests whose `expires_at` passed (the daemon already denied them at
 * its own clock), one transaction per session with the card update. Returns how many expired.
 */
export async function sweepPermissionTimeouts(deps: PermissionSweepDeps): Promise<number> {
  const now = deps.now();
  const due = await deps.db.query<{ session_id: string }>(
    `SELECT DISTINCT session_id FROM permission_request
      WHERE status = 'pending' AND expires_at <= $1 LIMIT $2`,
    [now, PERMISSION_SWEEP_BATCH],
  );
  let expired = 0;
  for (const { session_id: sessionId } of due.rows) {
    try {
      const { n, events } = await withTransaction(deps.db, async (tx) => {
        // Session row first (the lock order of every permission write), then the requests.
        await tx.query('SELECT 1 FROM session WHERE id = $1 FOR UPDATE', [sessionId]);
        const r = await tx.query(
          `UPDATE permission_request SET status = 'expired', expired_reason = 'timeout',
                  resolved_at = $2
            WHERE session_id = $1 AND status = 'pending' AND expires_at <= $2`,
          [sessionId, now],
        );
        const count = r.rowCount ?? 0;
        return { n: count, events: count > 0 ? await cardUpserted(tx, sessionId) : [] };
      });
      expired += n;
      for (const e of events) deps.boardBus.publish(e);
    } catch (err) {
      console.error(
        `[sweep] permission requests of ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return expired;
}
