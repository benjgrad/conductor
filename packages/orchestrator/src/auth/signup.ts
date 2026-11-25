import { API_PATHS, SignupRequestSchema, type MeResponse } from '@conductor/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody, sendError, type ErrorDetail } from '../api/errors.js';
import { withTransaction } from '../db/index.js';
import { seedAccount } from '../engine/seed.js';
import type { InviteRow } from '../db/types.js';
import { inviteIsOpen } from './invites.js';
import { sessionCookie } from './middleware.js';
import type { AuthRouteDeps } from './routes.js';
import { createSession, sessionIdHash } from './sessions.js';
import { rateLimitRouteConfig } from './throttle.js';

// M2-T15a / M2-T15b: POST /auth/signup (ADR-0017 §Invites; 10-contracts §Accounts and web auth).
// One transaction: lock the invite (FOR UPDATE, so two sign-ups with one invite make exactly one
// user), check it, then either
// - a general invite: create the user's own personal account and seed its workflows
//   (`seedAccount`, M2-T12), or
// - a bootstrap `claims_account` invite: lock the claimed account (FOR UPDATE, so two invites for
//   one account make exactly one owner) and claim it, renaming it to the user;
// then create the user, make them the owner, mark the invite used and open a session.

export const INVALID_INVITE_MESSAGE =
  'This invite link is not valid. Ask the person who sent it for a new one.';
export const WRONG_EMAIL_MESSAGE = 'This invite is for another email address.';

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
        // Lock order (every path that locks more than one of these takes them in this order):
        // invite table (ROW EXCLUSIVE) → invite row (FOR UPDATE) → account row (FOR UPDATE) →
        // app_user / account_member / web_session writes. Bootstrap takes the invite table in
        // SHARE ROW EXCLUSIVE, then invite rows, and never locks an account. Taking ROW EXCLUSIVE
        // up front (the lock `UPDATE invite` below takes anyway) makes a sign-up and a bootstrap
        // wait for each other as a whole; FOR UPDATE alone (ROW SHARE) doesn't conflict with
        // bootstrap's lock, and the late upgrade would deadlock against its revoking UPDATE.
        // Concurrent sign-ups don't conflict on it (ROW EXCLUSIVE is self-compatible).
        await tx.query('LOCK TABLE invite IN ROW EXCLUSIVE MODE');
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
        const claimed = invite.claims_account;
        if (claimed !== null) {
          // A claimed account is never claimed again (a second bootstrap invite, say). The row
          // lock serialises claims of one account through different invites: the owner check
          // below runs after the wait, so it sees the first claimer's committed owner.
          await tx.query('SELECT 1 FROM account WHERE id = $1 FOR UPDATE', [claimed]);
          const owned = await tx.query(
            "SELECT 1 FROM account_member WHERE account_id = $1 AND role = 'owner'",
            [claimed],
          );
          if ((owned.rowCount ?? 0) > 0) throw new SignupRefusal(INVALID_INVITE_MESSAGE);
        }
        const taken = await tx.query('SELECT 1 FROM app_user WHERE lower(email) = $1', [
          body.email,
        ]);
        if ((taken.rowCount ?? 0) > 0) throw new SignupRefusal(INVALID_INVITE_MESSAGE);

        let accountId: string;
        if (claimed !== null) {
          accountId = claimed;
          await tx.query('UPDATE account SET name = $2 WHERE id = $1', [
            accountId,
            body.display_name,
          ]);
        } else {
          // M2-T15b: a general invite makes a personal account, seeded with the shipped
          // workflows so the new user's board works at once (rolled back with the rest).
          const acct = await tx.query<{ id: string }>(
            'INSERT INTO account (name, created_at) VALUES ($1, $2) RETURNING id',
            [body.display_name, t],
          );
          accountId = acct.rows[0]!.id;
          await seedAccount(tx, accountId);
        }

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
