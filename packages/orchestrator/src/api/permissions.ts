import { randomUUID } from 'node:crypto';
import {
  API_PATHS,
  PermissionDecisionRequestSchema,
  UuidSchema,
  type BoardSseEvent,
  type OrchestratorToDaemon,
  type PermissionRequestListResponse,
} from '@conductor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { BoardBus, OutboxTransport } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { PermissionRequestRow } from '../db/types.js';
import type { Db } from '../main.js';
import {
  cardUpserted,
  decisionFrame,
  listSessionPermissionRequests,
  sendDecision,
  toPermissionRequestDto,
} from '../permissions/store.js';
import { parseBody, sendError } from './errors.js';

// M2-T29c: the permission-prompt routes (ADR-0023; 10-contracts §Permission prompts). Both are
// the ticket owner's (the signed-in account's): another account's or an unknown id is 404.

export interface PermissionRoutesOptions {
  db: Db;
  boardBus: BoardBus;
  /** The machines' live sockets (the gateway's transport); absent = nothing is connected. */
  transport?: OutboxTransport;
  now: () => Date;
  log: (msg: string) => void;
}

type IdParams = { Params: { id: string } };

type DecisionOutcome =
  | { kind: 'not_found' }
  | { kind: 'no_rule' }
  | { kind: 'not_pending'; row: PermissionRequestRow }
  | { kind: 'same'; row: PermissionRequestRow }
  | {
      kind: 'decided';
      row: PermissionRequestRow;
      frame: OrchestratorToDaemon;
      events: BoardSseEvent[];
    };

export const registerPermissionRoutes: FastifyPluginAsync<PermissionRoutesOptions> = (
  app,
  { db, boardBus, transport, now, log },
) => {
  app.get<IdParams>(API_PATHS.sessionPermissionRequests(':id'), async (req, reply) => {
    const id = req.params.id;
    const notFound = () => sendError(reply, 404, 'not_found', `session ${id} not found`);
    if (!UuidSchema.safeParse(id).success) return notFound();
    const own = await db.query(
      'SELECT 1 FROM session s JOIN ticket t ON t.id = s.ticket_id ' +
        'WHERE s.id = $1 AND t.account_id = $2',
      [id, req.auth!.scope.account_id],
    );
    if (own.rowCount === 0) return notFound();
    const body: PermissionRequestListResponse = {
      requests: await listSessionPermissionRequests(db, id),
    };
    return body;
  });

  /**
   * One transaction: lock the session, then the request; record the decision (and, for
   * `always`, the exact rule on the ticket's `session_allow`); re-derive the card. After COMMIT
   * the decision goes out on the machine's live socket (U-099: no outbox row; TD-179).
   * Idempotent on the request id: the same `{behavior, scope}` again is 200 with the stored
   * decision and sends nothing.
   */
  app.post<IdParams>(API_PATHS.permissionDecision(':id'), async (req, reply) => {
    const id = req.params.id;
    const notFound = () => sendError(reply, 404, 'not_found', `permission request ${id} not found`);
    if (!UuidSchema.safeParse(id).success) return notFound();
    const body = parseBody(PermissionDecisionRequestSchema, req.body, reply);
    if (!body) return reply;
    const auth = req.auth!;

    const out = await withTransaction(db, async (tx): Promise<DecisionOutcome> => {
      const own = await tx.query<{ session_id: string; ticket_id: string }>(
        'SELECT pr.session_id, s.ticket_id FROM permission_request pr ' +
          'JOIN session s ON s.id = pr.session_id JOIN ticket t ON t.id = s.ticket_id ' +
          'WHERE pr.id = $1 AND t.account_id = $2',
        [id, auth.scope.account_id],
      );
      const o = own.rows[0];
      if (!o) return { kind: 'not_found' };
      const s = await tx.query<{ fencing_token: string }>(
        'SELECT fencing_token FROM session WHERE id = $1 FOR UPDATE',
        [o.session_id],
      );
      const token = Number(s.rows[0]!.fencing_token);
      const r = await tx.query<PermissionRequestRow>(
        'SELECT * FROM permission_request WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = r.rows[0]!;
      if (row.status !== 'pending') {
        const same =
          (row.status === 'allowed' || row.status === 'denied') &&
          row.behavior === body.behavior &&
          row.scope === body.scope;
        return same ? { kind: 'same', row } : { kind: 'not_pending', row };
      }
      if (body.scope === 'always' && row.always_rule === null) return { kind: 'no_rule' };
      const rule = body.scope === 'always' ? row.always_rule : null;
      const commandId = randomUUID();
      const u = await tx.query<PermissionRequestRow>(
        `UPDATE permission_request
            SET status = $2, behavior = $3, scope = $4, message = $5, rule = $6,
                decided_by = $7, resolved_at = $8, decision_command_id = $9
          WHERE id = $1 RETURNING *`,
        [
          id,
          body.behavior === 'allow' ? 'allowed' : 'denied',
          body.behavior,
          body.scope,
          body.message ?? null,
          rule,
          auth.user.id,
          now(),
          commandId,
        ],
      );
      if (rule !== null) {
        // ADR-0023 §2: on the ticket until M2-T28c's machine override exists.
        await tx.query(
          'UPDATE ticket SET session_allow = array_append(session_allow, $2::text) ' +
            'WHERE id = $1 AND NOT ($2::text = ANY (session_allow))',
          [o.ticket_id, rule],
        );
      }
      const decided = u.rows[0]!;
      return {
        kind: 'decided',
        row: decided,
        frame: decisionFrame(decided, commandId, token),
        events: await cardUpserted(tx, o.session_id),
      };
    });

    switch (out.kind) {
      case 'not_found':
        return notFound();
      case 'no_rule':
        return sendError(
          reply,
          400,
          'bad_request',
          'this request has no exact rule to allow always; allow it once or deny it',
          [{ path: 'scope', message: 'always_rule is null' }],
        );
      case 'not_pending':
        return sendError(
          reply,
          409,
          'permission_not_pending',
          out.row.status === 'expired'
            ? `permission request ${id} expired (${out.row.expired_reason ?? 'unknown'})`
            : `permission request ${id} was already decided (${out.row.behavior ?? ''} ${out.row.scope ?? ''})`,
        );
      case 'same':
        return toPermissionRequestDto(out.row);
      case 'decided':
        for (const e of out.events) boardBus.publish(e);
        await sendDecision(transport, out.row.machine_id, out.frame, log);
        return toPermissionRequestDto(out.row);
    }
  });
  return Promise.resolve();
};
