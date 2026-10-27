import { API_PATHS, SignupRequestSchema, type MeResponse } from '@conductor/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody, sendError, type ErrorDetail } from '../api/errors.js';
import { withTransaction } from '../db/index.js';
import type { InviteRow } from '../db/types.js';
import { inviteIsOpen } from './invites.js';
import { sessionCookie } from './middleware.js';
import type { AuthRouteDeps } from './routes.js';
import { createSession, sessionIdHash } from './sessions.js';
import { rateLimitRouteConfig } from './throttle.js';

// M2-T15a: POST /auth/signup (ADR-0017 §Invites; 10-contracts §Accounts and web auth). One
// transaction: lock the invite (FOR UPDATE, so two sign-ups with one invite make exactly one
// user), check it, create the user, claim the invite's account, mark it used, open a session.
// Only `claims_account` invites (bootstrap) are accepted until M2-T15b brings general sign-up
// into a new personal account (it needs M2-T12's seedAccount).

export const INVALID_INVITE_MESSAGE =
  'This invite link is not valid. Ask the person who sent it for a new one.';
export const WRONG_EMAIL_MESSAGE = 'This invite is for another email address.';
export const NOT_SUPPORTED_YET_MESSAGE = 'general sign-up arrives with M2-T15b';

const USER_AGENT_MAX = 512;
const PG_UNIQUE_VIOLATION = '23505';

/** Thrown inside the transaction (so it rolls back) and answered as a 400. */
class SignupRefusal extends Error {
  constructor(
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
  }
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION;

export function registerSignupRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, auth, hasher, now } = deps;
  if (auth.mode !== 'password') return;

  app.post(API_PATHS.authSignup, { config: rateLimitRouteConfig('signup') }, async (req, reply) => {
    const body = parseBody(SignupRequestSchema, req.body, reply);
    if (!body) return reply;
    const t = now();
    // Hashed before the invite row is locked, and on every path (the timing doesn't say why).
    const passwordHash = await hasher.hash(body.password);
    const inviteHash = sessionIdHash(body.invite);
    let result: { me: MeResponse; token: string };
    try {
      result = await withTransaction(db, async (tx) => {
        if (inviteHash === null) throw new SignupRefusal(INVALID_INVITE_MESSAGE);
        const inv = await tx.query<InviteRow>(
          'SELECT * FROM invite WHERE token_hash = $1 FOR UPDATE',
          [inviteHash],
        );
        const invite = inv.rows[0];
        if (!invite || !inviteIsOpen(invite, t)) throw new SignupRefusal(INVALID_INVITE_MESSAGE);
        if (invite.email !== null && invite.email !== body.email) {
          throw new SignupRefusal(WRONG_EMAIL_MESSAGE, [
            { path: 'email', message: WRONG_EMAIL_MESSAGE },
          ]);
        }
        const accountId = invite.claims_account;
        if (accountId === null) {
          // TD: M2-T15b replaces this with sign-up into a new personal account. The code is
          // `bad_request` because ApiErrorCode (shared) has no `not_supported_yet`.
          throw new SignupRefusal(NOT_SUPPORTED_YET_MESSAGE, [
            { path: 'invite', message: 'not_supported_yet' },
          ]);
        }
        // A claimed account is never claimed again (a second bootstrap invite, say).
        const owned = await tx.query(
          "SELECT 1 FROM account_member WHERE account_id = $1 AND role = 'owner'",
          [accountId],
        );
        if ((owned.rowCount ?? 0) > 0) throw new SignupRefusal(INVALID_INVITE_MESSAGE);
        const taken = await tx.query('SELECT 1 FROM app_user WHERE lower(email) = $1', [
          body.email,
        ]);
        if ((taken.rowCount ?? 0) > 0) throw new SignupRefusal(INVALID_INVITE_MESSAGE);

        const user = await tx.query<{ id: string }>(
          'INSERT INTO app_user (email, display_name, password_hash, is_admin, ' +
            'password_changed_at, created_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id',
          [body.email, body.display_name, passwordHash, invite.is_admin, t],
        );
        const userId = user.rows[0]!.id;
        await tx.query(
          "INSERT INTO account_member (account_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)",
          [accountId, userId, t],
        );
        await tx.query('UPDATE account SET name = $2 WHERE id = $1', [
          accountId,
          body.display_name,
        ]);
        await tx.query('UPDATE invite SET used_at = $2, used_by = $3 WHERE id = $1', [
          invite.id,
          t,
          userId,
        ]);
        const session = await createSession(tx, {
          userId,
          accountId,
          userAgent: req.headers['user-agent']?.slice(0, USER_AGENT_MAX) ?? null,
          ip: req.ip,
          now: t,
        });
        const me: MeResponse = {
          user: {
            id: userId,
            email: body.email,
            display_name: body.display_name,
            is_admin: invite.is_admin,
          },
          account: { id: accountId, name: body.display_name },
          auth_mode: 'password',
        };
        return { me, token: session.token };
      });
    } catch (err) {
      if (err instanceof SignupRefusal) {
        return sendError(reply, 400, 'bad_request', err.message, err.details);
      }
      // Two sign-ups racing on one email through two invites: the unique index decides.
      if (isUniqueViolation(err))
        return sendError(reply, 400, 'bad_request', INVALID_INVITE_MESSAGE);
      throw err;
    }
    void reply.header('set-cookie', sessionCookie(auth, result.token));
    return reply.code(201).send(result.me);
  });
}
