import {
  API_PATHS,
  EmailSchema,
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  type InvitePreview,
} from '@conductor/shared';
import type { FastifyInstance } from 'fastify';
import type { InviteRow } from '../db/types.js';
import type { AuthRouteDeps } from './routes.js';
import { hashToken, newSessionToken, sessionIdHash, type Queryable } from './sessions.js';

// M2-T15a: invites (ADR-0017 §Invites, sign-up, resets, the admin). A token is 32 random bytes
// (base64url, the same shape as a session cookie); `invite.token_hash` stores only its SHA-256,
// and the URL is the only place the token is ever shown. Creating invites is the CLI's job for
// now (`conductor-admin bootstrap`); the admin routes are M2-T15b.

export const DAY_MS = 24 * 3600_000;

export interface CreatedInvite {
  id: string;
  /** Shown once, inside `url`; never stored. */
  token: string;
  /** `<public url>/signup?invite=<token>`. */
  url: string;
  expires_at: Date;
}

/**
 * Insert an invite and return its one-time URL. `days` (an integer 1..INVITE_MAX_DAYS, default
 * INVITE_DEFAULT_DAYS) sets the expiry; `ttlMs` overrides it (bootstrap's one hour).
 */
export async function createInvite(
  db: Queryable,
  opts: {
    publicUrl: URL;
    now: Date;
    days?: number;
    ttlMs?: number;
    email?: string | null;
    isAdmin?: boolean;
    claimsAccount?: string | null;
    createdBy?: string | null;
  },
): Promise<CreatedInvite> {
  const days = opts.days ?? INVITE_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > INVITE_MAX_DAYS) {
    throw new RangeError(`invite days must be an integer from 1 to ${INVITE_MAX_DAYS}`);
  }
  const ttl = opts.ttlMs ?? days * DAY_MS;
  if (!(ttl > 0 && ttl <= INVITE_MAX_DAYS * DAY_MS)) {
    throw new RangeError(`invite lifetime must be positive and at most ${INVITE_MAX_DAYS} days`);
  }
  const email = opts.email == null ? null : EmailSchema.parse(opts.email);
  const token = newSessionToken();
  const expiresAt = new Date(opts.now.getTime() + ttl);
  const res = await db.query<{ id: string }>(
    'INSERT INTO invite (token_hash, created_by, email, is_admin, claims_account, created_at, ' +
      'expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [
      hashToken(token),
      opts.createdBy ?? null,
      email,
      opts.isAdmin ?? false,
      opts.claimsAccount ?? null,
      opts.now,
      expiresAt,
    ],
  );
  const url = new URL(`/signup?invite=${token}`, opts.publicUrl).toString();
  return { id: res.rows[0]!.id, token, url, expires_at: expiresAt };
}

/** Unused, unrevoked and unexpired (preview and sign-up agree on this). */
export function inviteIsOpen(
  row: Pick<InviteRow, 'used_at' | 'revoked_at' | 'expires_at'>,
  now: Date,
): boolean {
  return row.used_at === null && row.revoked_at === null && row.expires_at > now;
}

const INVALID: InvitePreview = { valid: false, expires_at: null };

/**
 * GET /auth/invites/:token: validity, expiry and the pinned email, nothing else. Unknown,
 * malformed, used, revoked and expired tokens all get the same `{valid: false, expires_at: null}`.
 */
export async function previewInvite(
  db: Queryable,
  token: string,
  now: Date,
): Promise<InvitePreview> {
  const hash = sessionIdHash(token);
  if (hash === null) return INVALID;
  const res = await db.query<Pick<InviteRow, 'email' | 'expires_at' | 'used_at' | 'revoked_at'>>(
    'SELECT email, expires_at, used_at, revoked_at FROM invite WHERE token_hash = $1',
    [hash],
  );
  const row = res.rows[0];
  if (!row || !inviteIsOpen(row, now)) return INVALID;
  return {
    valid: true,
    ...(row.email !== null ? { email: row.email } : {}),
    expires_at: row.expires_at.toISOString(),
  };
}

/**
 * Password mode only (registered by `registerAuthRoutes`). No per-IP limit: a side-effect-free
 * GET against a 256-bit token space, and a limit would eat into the sign-up page's own budget.
 */
export function registerInviteRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, now } = deps;
  app.get<{ Params: { token: string } }>(API_PATHS.authInvitePreview(':token'), (req) =>
    previewInvite(db, req.params.token, now()),
  );
}
