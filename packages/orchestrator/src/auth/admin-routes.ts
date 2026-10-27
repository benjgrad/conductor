import {
  API_PATHS,
  CreateInviteRequestSchema,
  UuidSchema,
  type InviteCreated,
  type InviteRow,
  type OkResponse,
  type ResetLinkCreated,
} from '@conductor/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody, sendError } from '../api/errors.js';
import type { MachineSockets } from '../gateway/revoke.js';
import { disableUser, findVisibleUser, listUsers, unlockUser } from './admin-commands.js';
import { createInvite } from './invites.js';
import { requireAdmin } from './middleware.js';
import { createResetLink } from './reset.js';
import type { AuthRouteDeps } from './routes.js';
import { rateLimitRouteConfig } from './throttle.js';

// M2-T15b1: the /api/admin/* routes (ADR-0017 §Invites, sign-up, resets, the admin; 10-contracts
// §Accounts and web auth), password mode only. Every route is `requireAdmin` (403 otherwise);
// the auth hook has answered 401 without a session and the security hook 403 for a bad Origin.
// Scoping: the admin sees and acts on the members of their own accounts and the invites they
// created; any other id (unknown, malformed, another account's) is 404. The logic is shared
// with `conductor-admin` (admin-commands.ts). Responses never carry a hash; an invite or reset
// token appears once, inside the `url` of the create response.

const OK: OkResponse = { ok: true };
const NO_SOCKETS: MachineSockets = { disconnectMachine: () => undefined };

interface InviteDbRow {
  id: string;
  email: string | null;
  is_admin: boolean;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function registerAdminRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, auth, now } = deps;
  if (auth.mode !== 'password') return;
  const sockets = deps.sockets ?? NO_SOCKETS;
  const noUser = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 404, 'not_found', 'no such user');

  app.get(API_PATHS.adminUsers, async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return listUsers(db, now(), { visibleTo: req.auth!.user.id });
  });

  app.post<{ Params: { id: string } }>(
    API_PATHS.adminUserResetLink(':id'),
    { config: rateLimitRouteConfig('adminResetLink') },
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      const admin = req.auth!.user.id;
      const user = await findVisibleUser(db, admin, req.params.id);
      if (user === null) return noUser(reply);
      const link = await createResetLink(db, {
        userId: user.id,
        publicUrl: auth.publicUrl,
        now: now(),
        createdBy: admin,
      });
      const created: ResetLinkCreated = {
        url: link.url,
        expires_at: link.expires_at.toISOString(),
      };
      return reply.code(201).send(created);
    },
  );

  app.post<{ Params: { id: string } }>(API_PATHS.adminUserDisable(':id'), async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const admin = req.auth!.user.id;
    const user = await findVisibleUser(db, admin, req.params.id);
    if (user === null) return noUser(reply);
    // Not in the contract table: disabling yourself would lock the admin out of the instance.
    if (user.id === admin) {
      return sendError(reply, 400, 'bad_request', "you can't disable yourself");
    }
    await disableUser({ db, sockets }, user.id, now());
    return OK;
  });

  app.post<{ Params: { id: string } }>(API_PATHS.adminUserUnlock(':id'), async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const user = await findVisibleUser(db, req.auth!.user.id, req.params.id);
    if (user === null) return noUser(reply);
    await unlockUser(db, user.email);
    return OK;
  });

  app.get(API_PATHS.adminInvites, async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const res = await db.query<InviteDbRow>(
      'SELECT id, email, is_admin, created_at, expires_at, used_at, revoked_at FROM invite ' +
        'WHERE created_by = $1 ORDER BY created_at DESC, id',
      [req.auth!.user.id],
    );
    return res.rows.map((r): InviteRow => ({
      id: r.id,
      email: r.email,
      is_admin: r.is_admin,
      created_at: r.created_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
      used_at: iso(r.used_at),
      revoked_at: iso(r.revoked_at),
    }));
  });

  app.post(API_PATHS.adminInvites, async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const body = parseBody(CreateInviteRequestSchema, req.body, reply);
    if (!body) return reply;
    // A general invite: `claims_account` is never settable from the API (the schema strips it).
    // TD-173: sign-up with it is `not_supported_yet` until M2-T15b.
    const invite = await createInvite(db, {
      publicUrl: auth.publicUrl,
      now: now(),
      ...(body.days !== undefined ? { days: body.days } : {}),
      email: body.email ?? null,
      isAdmin: body.admin ?? false,
      claimsAccount: null,
      createdBy: req.auth!.user.id,
    });
    const created: InviteCreated = {
      id: invite.id,
      url: invite.url,
      expires_at: invite.expires_at.toISOString(),
    };
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { id: string } }>(API_PATHS.adminInvite(':id'), async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!UuidSchema.safeParse(req.params.id).success) {
      return sendError(reply, 404, 'not_found', 'no such invite');
    }
    const res = await db.query(
      'UPDATE invite SET revoked_at = COALESCE(revoked_at, $3) WHERE id = $1 AND created_by = $2 ' +
        'RETURNING id',
      [req.params.id, req.auth!.user.id, now()],
    );
    if ((res.rowCount ?? 0) === 0) return sendError(reply, 404, 'not_found', 'no such invite');
    return OK;
  });
}
