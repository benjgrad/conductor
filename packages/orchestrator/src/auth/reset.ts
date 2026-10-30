import {
  API_PATHS,
  RESET_LINK_TTL_MS,
  ResetRequestSchema,
  passwordProblems,
  type OkResponse,
} from '@conductor/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody, sendError, type ErrorDetail } from '../api/errors.js';
import { withTransaction } from '../db/index.js';
import { revokeUserOAuthTokens } from '../oauth/tokens.js';
import type { AuthRouteDeps } from './routes.js';
import {
  hashToken,
  newSessionToken,
  revokeUserSessions,
  sessionIdHash,
  type Queryable,
} from './sessions.js';
import { rateLimitRouteConfig } from './throttle.js';

// M2-T15a: password resets without mail (ADR-0017 §Invites, sign-up, resets, the admin). An
// admin (`conductor-admin reset-link`, later M2-T15b's admin route) makes a one-hour link and
// passes it on by hand. `POST /auth/reset` uses it once: it sets the password, burns every open
// link of the user and revokes all their sessions. It doesn't lift a `login_throttle` lock: only
// time or `conductor-admin unlock` does (ADR-0017 layer 3).

export const INVALID_RESET_MESSAGE = 'This reset link is not valid. Ask an admin for a new one.';

const OK: OkResponse = { ok: true };

export async function createResetLink(
  db: Queryable,
  opts: { userId: string; publicUrl: URL; now: Date; createdBy?: string | null },
): Promise<{ url: string; expires_at: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(opts.now.getTime() + RESET_LINK_TTL_MS);
  await db.query(
    'INSERT INTO password_reset (token_hash, user_id, created_by, created_at, expires_at) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [hashToken(token), opts.userId, opts.createdBy ?? null, opts.now, expiresAt],
  );
  return {
    url: new URL(`/reset?token=${token}`, opts.publicUrl).toString(),
    expires_at: expiresAt,
  };
}

class ResetRefusal extends Error {
  constructor(
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
  }
}

interface ResetLookupRow {
  id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  email: string;
  disabled_at: Date | null;
}

export function registerResetRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, auth, hasher, now } = deps;
  if (auth.mode !== 'password') return;

  app.post(API_PATHS.authReset, { config: rateLimitRouteConfig('reset') }, async (req, reply) => {
    const body = parseBody(ResetRequestSchema, req.body, reply);
    if (!body) return reply;
    const t = now();
    const tokenHash = sessionIdHash(body.token);
    try {
      await withTransaction(db, async (tx) => {
        if (tokenHash === null) throw new ResetRefusal(INVALID_RESET_MESSAGE);
        const res = await tx.query<ResetLookupRow>(
          'SELECT r.id, r.user_id, r.expires_at, r.used_at, u.email, u.disabled_at ' +
            'FROM password_reset r JOIN app_user u ON u.id = r.user_id ' +
            'WHERE r.token_hash = $1 FOR UPDATE OF r',
          [tokenHash],
        );
        const row = res.rows[0];
        if (!row || row.used_at !== null || row.expires_at <= t || row.disabled_at !== null) {
          throw new ResetRefusal(INVALID_RESET_MESSAGE);
        }
        // Checked before the link is used up, so a weak password doesn't burn it.
        const problems = passwordProblems(body.password, row.email);
        if (problems.length > 0) {
          throw new ResetRefusal(
            'the new password is not acceptable',
            problems.map((message) => ({ path: 'password', message })),
          );
        }
        const hashed = await hasher.hash(body.password);
        await tx.query(
          'UPDATE app_user SET password_hash = $2, password_changed_at = $3 WHERE id = $1',
          [row.user_id, hashed, t],
        );
        await tx.query(
          'UPDATE password_reset SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
          [row.user_id, t],
        );
        await revokeUserSessions(tx, row.user_id);
        await revokeUserOAuthTokens(tx, row.user_id, t);
      });
    } catch (err) {
      if (err instanceof ResetRefusal) {
        return sendError(reply, 400, 'bad_request', err.message, err.details);
      }
      throw err;
    }
    return OK;
  });
}
