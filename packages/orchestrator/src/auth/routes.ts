import {
  API_PATHS,
  LoginRequestSchema,
  PasswordChangeRequestSchema,
  localMeResponse,
  passwordProblems,
  type MeResponse,
  type OkResponse,
} from '@conductor/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody, sendError } from '../api/errors.js';
import { withTransaction } from '../db/index.js';
import type { MachineSockets } from '../gateway/revoke.js';
import type { Db } from '../main.js';
import { registerAdminRoutes } from './admin-routes.js';
import type { AuthConfig } from './config.js';
import { clearedSessionCookie, parseCookie, sessionCookie } from './middleware.js';
import { registerInviteRoutes } from './invites.js';
import { DUMMY_HASH, type PasswordHasher } from './password.js';
import { registerResetRoutes } from './reset.js';
import { createSession, revokeSession, revokeUserSessions, sessionIdHash } from './sessions.js';
import { registerSignupRoutes } from './signup.js';
import {
  isLocked,
  rateLimitRouteConfig,
  recordFailure,
  recordSuccess,
  throttleKey,
} from './throttle.js';

// M2-T08: sign-in routes (ADR-0017 §Auth: behaviour; 10-contracts §Accounts and web auth).
// GET /api/me in both modes; POST /auth/login, /auth/logout and /auth/password in password mode
// only (local mode has no sign-in: they are 404 there).
// M2-T15a: the invite preview, sign-up and reset routes (invites.ts, signup.ts, reset.ts) are
// registered here too, password mode only, so the per-IP limits apply to them.
// M2-T15b1: the /api/admin/* routes (admin-routes.ts), password mode only, likewise.

export interface AuthRouteDeps {
  db: Db;
  auth: AuthConfig;
  hasher: PasswordHasher;
  now: () => Date;
  /** Closes a disabled user's machines' daemon sockets (the gateway). Default: none open. */
  sockets?: MachineSockets;
}

/** One body for every failed login: unknown email, wrong password, disabled user, locked email. */
export const LOGIN_FAILED_MESSAGE = 'Email or password is wrong';
export const WRONG_CURRENT_PASSWORD = 'Your current password is wrong.';

const USER_AGENT_MAX = 512;
const OK: OkResponse = { ok: true };

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_admin: boolean;
  disabled_at: Date | null;
}

/** A Fastify plugin; register it after `registerRateLimit` so its route limits apply. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { db, auth, hasher, now } = deps;

  app.get(API_PATHS.authMe, (req, reply) => {
    if (auth.mode === 'local') return localMeResponse();
    // The auth hook has already answered 401 without a session.
    if (req.auth === null) return sendError(reply, 401, 'unauthorized', 'sign in required');
    const me: MeResponse = {
      user: req.auth.user,
      account: req.auth.account,
      auth_mode: 'password',
    };
    return me;
  });

  if (auth.mode === 'local') return Promise.resolve();

  registerInviteRoutes(app, deps);
  registerSignupRoutes(app, deps);
  registerResetRoutes(app, deps);
  registerAdminRoutes(app, deps);

  const failed = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 401, 'unauthorized', LOGIN_FAILED_MESSAGE);

  app.post(API_PATHS.authLogin, { config: rateLimitRouteConfig('login') }, async (req, reply) => {
    const body = parseBody(LoginRequestSchema, req.body, reply);
    if (!body) return reply;
    const email = body.email;
    const t = now();
    const locked = await isLocked(db, email, t);
    const res = await db.query<UserRow>(
      'SELECT id, email, display_name, password_hash, is_admin, disabled_at ' +
        'FROM app_user WHERE lower(email) = $1',
      [email],
    );
    const user = res.rows[0];
    // Exactly one argon2 verify on every path, so timing doesn't tell which one it was.
    const ok = await hasher.verify(user?.password_hash ?? DUMMY_HASH, body.password);
    if (locked) return failed(reply);
    if (!user || !ok || user.disabled_at !== null) {
      await recordFailure(db, email, t);
      return failed(reply);
    }
    const acct = await db.query<{ id: string; name: string }>(
      'SELECT a.id, a.name FROM account_member m JOIN account a ON a.id = m.account_id ' +
        "WHERE m.user_id = $1 AND m.role = 'owner' ORDER BY m.created_at LIMIT 1",
      [user.id],
    );
    const account = acct.rows[0];
    if (!account) return failed(reply);
    await recordSuccess(db, email);
    if (hasher.needsRehash(user.password_hash)) {
      await db.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [
        user.id,
        await hasher.hash(body.password),
      ]);
    }
    const session = await createSession(db, {
      userId: user.id,
      accountId: account.id,
      userAgent: req.headers['user-agent']?.slice(0, USER_AGENT_MAX) ?? null,
      ip: req.ip,
      now: t,
    });
    void reply.header('set-cookie', sessionCookie(auth, session.token));
    const me: MeResponse = {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_admin: user.is_admin,
      },
      account: { id: account.id, name: account.name },
      auth_mode: 'password',
    };
    return me;
  });

  app.post(API_PATHS.authLogout, async (req, reply) => {
    const token = parseCookie(req.headers.cookie, auth.cookie.name);
    const idHash = token === null ? null : sessionIdHash(token);
    if (idHash !== null) await revokeSession(db, idHash);
    void reply.header('set-cookie', clearedSessionCookie(auth));
    return OK;
  });

  // ADR-0017 §Session cookie: a change revokes every other session of the user. No session →
  // 401 (the web signs the user out); a wrong `current` → 400 at path `current` (TD-123/125).
  // M2-T08b: a wrong `current` counts against the user's email in `login_throttle` (ADR-0017
  // layer 3, shared with login), so a stolen cookie can't brute-force it; while the email is
  // locked the same 400 is returned without effect, and a successful change resets the count.
  const wrongCurrent = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 400, 'bad_request', WRONG_CURRENT_PASSWORD, [
      { path: 'current', message: WRONG_CURRENT_PASSWORD },
    ]);

  app.post(
    API_PATHS.authPassword,
    { config: rateLimitRouteConfig('login') },
    async (req, reply) => {
      const who = req.auth;
      if (who === null) return sendError(reply, 401, 'unauthorized', 'sign in required');
      const body = parseBody(PasswordChangeRequestSchema, req.body, reply);
      if (!body) return reply;
      const t = now();
      const email = throttleKey(who.user.email);
      const locked = await isLocked(db, email, t);
      const res = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM app_user WHERE id = $1',
        [who.user.id],
      );
      const current = res.rows[0]?.password_hash ?? DUMMY_HASH;
      // Exactly one argon2 verify on every path, locked or not (as login).
      const ok = await hasher.verify(current, body.current);
      if (locked) return wrongCurrent(reply);
      if (!ok) {
        await recordFailure(db, email, t);
        return wrongCurrent(reply);
      }
      const problems = passwordProblems(body.new, who.user.email);
      if (problems.length > 0) {
        return sendError(
          reply,
          400,
          'bad_request',
          'the new password is not acceptable',
          problems.map((message) => ({ path: 'password', message })),
        );
      }
      const hashed = await hasher.hash(body.new);
      await withTransaction(db, async (tx) => {
        await tx.query(
          'UPDATE app_user SET password_hash = $2, password_changed_at = $3 WHERE id = $1',
          [who.user.id, hashed, t],
        );
        await revokeUserSessions(tx, who.user.id, { except: who.sessionIdHash });
        await recordSuccess(tx, email);
      });
      return OK;
    },
  );

  return Promise.resolve();
}
