import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Queryable } from './sessions.js';

// M2-T08: login throttling (ADR-0017 §Rate limiting and lockout), layers 2 and 3 (nginx is 1).
//   - per email, in `login_throttle`: 10 consecutive failures lock the email for 15 minutes,
//     doubling with each further lockout up to 24 h; a success resets it. Keyed by the normalised
//     string whether or not a user has it, so a lock reveals nothing. A wrong `current` on
//     POST /auth/password feeds the same count (M2-T08b), and the same lock refuses it.
//   - per client IP, in memory (`@fastify/rate-limit`, one instance): RATE_LIMITS. The key is
//     `req.ip`, which honours X-Forwarded-For only from CONDUCTOR_TRUSTED_PROXY (Fastify
//     `trustProxy`).

export const LOCK_AFTER_FAILURES = 10;
export const LOCK_BASE_MS = 15 * 60_000;
export const LOCK_MAX_MS = 24 * 3600_000;

/** `login_throttle.email_norm` for a stored email: normalised as `LoginEmailSchema` does. */
export const throttleKey = (email: string): string => email.trim().toLowerCase();

export async function isLocked(db: Queryable, emailNorm: string, now: Date): Promise<boolean> {
  const res = await db.query<{ locked: boolean }>(
    'SELECT locked_until IS NOT NULL AND locked_until > $2 AS locked ' +
      'FROM login_throttle WHERE email_norm = $1',
    [emailNorm, now],
  );
  return res.rows[0]?.locked ?? false;
}

/**
 * Count one failure, atomically. The 10th consecutive one sets `locked_until` to now + 15 min ×
 * 2^lockouts (capped at 24 h), bumps `lockouts` and restarts the count.
 */
export async function recordFailure(db: Queryable, emailNorm: string, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO login_throttle AS t (email_norm, failures, lockouts, locked_until, updated_at)
       VALUES ($1, 1, 0, NULL, $2)
     ON CONFLICT (email_norm) DO UPDATE SET
       failures = CASE WHEN t.failures + 1 >= $3 THEN 0 ELSE t.failures + 1 END,
       lockouts = CASE WHEN t.failures + 1 >= $3 THEN t.lockouts + 1 ELSE t.lockouts END,
       locked_until = CASE WHEN t.failures + 1 >= $3
         THEN $2::timestamptz + least($4::double precision * power(2, t.lockouts), $5)
           * interval '1 millisecond'
         ELSE t.locked_until END,
       updated_at = $2`,
    [emailNorm, now, LOCK_AFTER_FAILURES, LOCK_BASE_MS, LOCK_MAX_MS],
  );
}

/** A successful login: the count and the doubling start over. */
export async function recordSuccess(db: Queryable, emailNorm: string): Promise<void> {
  await clearThrottle(db, emailNorm);
}

/** `conductor-admin unlock` and the admin's unlock route (M2-T15b1), via `unlockUser`. */
export async function clearThrottle(db: Queryable, emailNorm: string): Promise<void> {
  await db.query('DELETE FROM login_throttle WHERE email_norm = $1', [emailNorm]);
}

/**
 * Per-IP limits (ADR-0017): login 10/min, sign-up and reset 5/10 min, enroll 10/10 min; the
 * admin's reset-link creation 10/10 min (M2-T15b1); the test push 10/10 min (UX-15).
 */
export const RATE_LIMITS = {
  login: { max: 10, timeWindow: 60_000 },
  signup: { max: 5, timeWindow: 600_000 },
  reset: { max: 5, timeWindow: 600_000 },
  enroll: { max: 10, timeWindow: 600_000 },
  adminResetLink: { max: 10, timeWindow: 600_000 },
  pushTest: { max: 10, timeWindow: 600_000 },
} as const;
export type RateLimitKind = keyof typeof RATE_LIMITS;

/**
 * The route `config` that applies one of the limits: `app.post(path, {config:
 * rateLimitRouteConfig('signup')}, handler)`. The route must be registered after
 * `registerRateLimit` has loaded (in a later `app.register` plugin), or the limit is silently not
 * applied. Over the limit: 429 `rate_limited` with Retry-After (the API's error handler).
 */
export function rateLimitRouteConfig(kind: RateLimitKind) {
  return { rateLimit: { ...RATE_LIMITS[kind] } };
}

/** Load `@fastify/rate-limit` with no global limit (only the routes that opt in). */
export function registerRateLimit(app: FastifyInstance): void {
  void app.register(fastifyRateLimit, { global: false });
}
