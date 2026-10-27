import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

// M2-T08: server-side web sessions (ADR-0017 §Session cookie). The cookie holds 32 random bytes
// (base64url); `web_session.id_hash` stores only their SHA-256. Every function takes `now`, so
// expiry is testable with a fake clock.

export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
/** `last_seen_at` is written at most this often (so the idle window is 7 d + up to 5 min). */
export const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/** A pool or a transaction client. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The hash of a well-formed cookie value, or null (anything else can't be a session). */
export function sessionIdHash(token: string): Buffer | null {
  return TOKEN_RE.test(token) ? hashToken(token) : null;
}

export interface SessionInfo {
  idHash: Buffer;
  user: { id: string; email: string; display_name: string; is_admin: boolean };
  account: { id: string; name: string };
}

export async function createSession(
  db: Queryable,
  opts: {
    userId: string;
    accountId: string;
    userAgent: string | null;
    ip: string | null;
    now: Date;
  },
): Promise<{ token: string; idHash: Buffer; expiresAt: Date }> {
  const token = newSessionToken();
  const idHash = hashToken(token);
  const expiresAt = new Date(opts.now.getTime() + SESSION_ABSOLUTE_MS);
  await db.query(
    'INSERT INTO web_session (id_hash, user_id, account_id, created_at, last_seen_at, ' +
      'expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $4, $5, $6, $7)',
    [idHash, opts.userId, opts.accountId, opts.now, expiresAt, opts.userAgent, opts.ip],
  );
  return { token, idHash, expiresAt };
}

interface LookupRow {
  expires_at: Date;
  last_seen_at: Date;
  disabled_at: Date | null;
  user_id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  account_id: string;
  account_name: string;
}

/**
 * The live session for a cookie value, or null: unknown, past `expires_at` (30 d absolute), idle
 * for more than 7 d, or its user disabled. An expired row is deleted on the way.
 */
export async function lookupSession(
  db: Queryable,
  token: string,
  now: Date,
): Promise<SessionInfo | null> {
  const idHash = sessionIdHash(token);
  if (idHash === null) return null;
  const res = await db.query<LookupRow>(
    'SELECT s.expires_at, s.last_seen_at, u.disabled_at, u.id AS user_id, u.email, ' +
      'u.display_name, u.is_admin, a.id AS account_id, a.name AS account_name ' +
      'FROM web_session s JOIN app_user u ON u.id = s.user_id ' +
      'JOIN account a ON a.id = s.account_id WHERE s.id_hash = $1',
    [idHash],
  );
  const row = res.rows[0];
  if (!row) return null;
  const t = now.getTime();
  if (row.expires_at.getTime() <= t || row.last_seen_at.getTime() + SESSION_IDLE_MS <= t) {
    await revokeSession(db, idHash);
    return null;
  }
  if (row.disabled_at !== null) return null;
  if (row.last_seen_at.getTime() + LAST_SEEN_THROTTLE_MS <= t) {
    await db.query('UPDATE web_session SET last_seen_at = $2 WHERE id_hash = $1', [idHash, now]);
  }
  return {
    idHash,
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      is_admin: row.is_admin,
    },
    account: { id: row.account_id, name: row.account_name },
  };
}

export async function revokeSession(db: Queryable, idHash: Buffer): Promise<void> {
  await db.query('DELETE FROM web_session WHERE id_hash = $1', [idHash]);
}

/** Every session of the user, or every other one when `except` is given (a password change). */
export async function revokeUserSessions(
  db: Queryable,
  userId: string,
  opts: { except?: Buffer | null } = {},
): Promise<void> {
  if (opts.except) {
    await db.query('DELETE FROM web_session WHERE user_id = $1 AND id_hash <> $2', [
      userId,
      opts.except,
    ]);
  } else {
    await db.query('DELETE FROM web_session WHERE user_id = $1', [userId]);
  }
}
