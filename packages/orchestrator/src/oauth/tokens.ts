import { LOCAL_USER_ID } from '@conductor/shared';
import type { AuthMode } from '@conductor/shared';
import { localAuth, type RequestAuth } from '../auth/middleware.js';
import type { Queryable } from '../contracts.js';
import { ACCESS_PREFIX, REFRESH_PREFIX, randomSecret, sha256 } from './secrets.js';

// ADR-0028: opaque access and refresh tokens. Only SHA-256 hashes are stored; a token is checked
// on every /mcp request with one query (no cache), so a revocation takes effect at once.

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const CODE_TTL_MS = 60_000;
/** The one scope (ADR-0028: no read / write split yet). */
export const OAUTH_SCOPE = 'conductor';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Insert a new access + refresh pair for a grant and return the token response. */
export async function issueTokens(
  q: Queryable,
  grant: { grant_id: string; client_id: string; account_id: string; user_id: string },
  now: Date,
): Promise<TokenResponse> {
  const access = randomSecret(ACCESS_PREFIX);
  const refresh = randomSecret(REFRESH_PREFIX);
  const insert =
    'INSERT INTO oauth_token (token_hash, kind, grant_id, client_id, account_id, user_id, ' +
    'created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
  const common = [grant.grant_id, grant.client_id, grant.account_id, grant.user_id, now];
  await q.query(insert, [
    sha256(access),
    'access',
    ...common,
    new Date(now.getTime() + ACCESS_TTL_MS),
  ]);
  await q.query(insert, [
    sha256(refresh),
    'refresh',
    ...common,
    new Date(now.getTime() + REFRESH_TTL_MS),
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope: OAUTH_SCOPE,
  };
}

/** Revoke every live token of a grant (a replayed authorization code). */
export async function revokeGrant(q: Queryable, grantId: string, now: Date): Promise<void> {
  await q.query(
    'UPDATE oauth_token SET revoked_at = $2 WHERE grant_id = $1 AND revoked_at IS NULL',
    [grantId, now],
  );
}

/** Revoke every live token of a user: password reset, disable, `conductor-admin revoke-sessions`. */
export async function revokeUserOAuthTokens(
  q: Queryable,
  userId: string,
  now: Date,
): Promise<number> {
  const res = await q.query(
    'UPDATE oauth_token SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
    [userId, now],
  );
  return res.rowCount ?? 0;
}

interface VerifyRow {
  account_id: string;
  account_name: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  email: string | null;
  display_name: string | null;
  is_admin: boolean | null;
  disabled_at: Date | null;
  has_user: boolean;
}

/**
 * Who a bearer access token acts as, or null: unknown, not an access token, expired, revoked, or
 * its user disabled. The virtual local user (no app_user row) is valid only in `local` mode.
 */
export async function verifyAccessToken(
  q: Queryable,
  raw: string,
  now: Date,
  mode: AuthMode,
): Promise<RequestAuth | null> {
  if (!raw.startsWith(ACCESS_PREFIX) || raw.length > 200) return null;
  const res = await q.query<VerifyRow>(
    'SELECT t.account_id, a.name AS account_name, t.user_id, t.expires_at, t.revoked_at, ' +
      'u.email, u.display_name, u.is_admin, u.disabled_at, u.id IS NOT NULL AS has_user ' +
      'FROM oauth_token t JOIN account a ON a.id = t.account_id ' +
      'LEFT JOIN app_user u ON u.id = t.user_id ' +
      "WHERE t.token_hash = $1 AND t.kind = 'access'",
    [sha256(raw)],
  );
  const row = res.rows[0];
  if (!row || row.revoked_at !== null || row.expires_at.getTime() <= now.getTime()) return null;
  if (!row.has_user) {
    return mode === 'local' && row.user_id === LOCAL_USER_ID ? localAuth() : null;
  }
  if (row.disabled_at !== null) return null;
  return {
    user: {
      id: row.user_id,
      email: row.email!,
      display_name: row.display_name!,
      is_admin: row.is_admin!,
    },
    account: { id: row.account_id, name: row.account_name },
    scope: { account_id: row.account_id, actor: { kind: 'user', user_id: row.user_id } },
    mode,
    sessionIdHash: null,
  };
}
