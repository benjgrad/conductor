import {
  API_PATHS,
  LOCAL_USER_ID,
  localMeResponse,
  localScope,
  type AccountScope,
  type AuthMode,
  type MeResponse,
} from '@conductor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../api/errors.js';
import { policyPath } from '../api/security.js';
import type { Db } from '../main.js';
import type { AuthConfig } from './config.js';
import { SESSION_ABSOLUTE_MS, lookupSession } from './sessions.js';

// M2-T08: who is asking (ADR-0017 §Auth: behaviour, ADR-0012 §Tenancy). An onRequest hook, after
// the security hook, sets `request.auth`:
//   - local mode: the virtual local user in the `local` account (`localScope`), always;
//   - password mode: the session cookie's user and account, or null. `/api/*` without a session
//     is 401 `unauthorized`, except POST API_PATHS.machinesEnroll (token-authenticated) and GET
//     API_PATHS.daemonAttachmentContent and POST API_PATHS.daemonSessionAttachments /
//     daemonSessionPages (machine-credential-authenticated), and POST
//     API_PATHS.githubWebhookDelivery (signed with the account's webhook secret, R11). `/p/:id` (ADR-0038) is outside
//     /api and checks `request.auth` or its share token itself. `/auth/*`
//     routes check `request.auth` themselves. The path is the matched route (`policyPath`), never
//     the raw URL alone, so no encoding of it gets past the check.

export interface RequestAuth {
  user: MeResponse['user'];
  account: MeResponse['account'];
  scope: AccountScope;
  mode: AuthMode;
  /** The current session's `web_session.id_hash`; null in local mode. */
  sessionIdHash: Buffer | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}

/** The value of one cookie in a Cookie header, or null. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

type PasswordAuth = AuthConfig & { mode: 'password' };

const cookieFlags = (auth: PasswordAuth) =>
  `HttpOnly; ${auth.cookie.secure ? 'Secure; ' : ''}SameSite=Lax; Path=/`;

/** `Set-Cookie` for a new session (lives as long as the session's absolute expiry). */
export function sessionCookie(auth: PasswordAuth, token: string): string {
  const maxAge = Math.floor(SESSION_ABSOLUTE_MS / 1000);
  return `${auth.cookie.name}=${token}; ${cookieFlags(auth)}; Max-Age=${maxAge}`;
}

/** `Set-Cookie` that clears the session cookie (logout). */
export function clearedSessionCookie(auth: PasswordAuth): string {
  return `${auth.cookie.name}=; ${cookieFlags(auth)}; Max-Age=0`;
}

export function localAuth(): RequestAuth {
  const me = localMeResponse();
  return {
    user: me.user,
    account: me.account,
    scope: localScope({ kind: 'user', user_id: LOCAL_USER_ID }),
    mode: 'local',
    sessionIdHash: null,
  };
}

/** 06 §Attachments: the daemon's download, authenticated by its machine credential instead. */
const DAEMON_ATTACHMENT = API_PATHS.daemonAttachmentContent(':id');
/** 06 §Attachments: the daemon uploading what its agent captured (machine credential too). */
const DAEMON_SESSION_ATTACHMENTS = API_PATHS.daemonSessionAttachments(':id');
/** ADR-0038: the daemon publishing its agent's page (machine credential too). */
const DAEMON_SESSION_PAGES = API_PATHS.daemonSessionPages(':id');
/** R11: a GitHub delivery, authenticated by the HMAC of its body (api/github-webhook.ts). */
const GITHUB_WEBHOOK_DELIVERY = API_PATHS.githubWebhookDelivery(':id');

const needsSession = (method: string, path: string): boolean =>
  (path === '/api' || path.startsWith('/api/')) &&
  !(method === 'POST' && path === API_PATHS.machinesEnroll) &&
  !(method === 'GET' && path === DAEMON_ATTACHMENT) &&
  !(method === 'POST' && path === DAEMON_SESSION_ATTACHMENTS) &&
  !(method === 'POST' && path === DAEMON_SESSION_PAGES) &&
  !(method === 'POST' && path === GITHUB_WEBHOOK_DELIVERY);

export function authHook(deps: { db: Db; auth: AuthConfig; now: () => Date }) {
  const { db, auth, now } = deps;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (auth.mode === 'local') {
      req.auth = localAuth();
      return undefined;
    }
    req.auth = null;
    const token = parseCookie(req.headers.cookie, auth.cookie.name);
    if (token !== null && token !== '') {
      const s = await lookupSession(db, token, now());
      if (s !== null) {
        req.auth = {
          user: s.user,
          account: s.account,
          scope: { account_id: s.account.id, actor: { kind: 'user', user_id: s.user.id } },
          mode: 'password',
          sessionIdHash: s.idHash,
        };
      }
    }
    if (req.auth === null && needsSession(req.method, policyPath(req))) {
      return sendError(reply, 401, 'unauthorized', 'sign in required');
    }
    return undefined;
  };
}

/**
 * Admin-only routes (M2-T15): true when the signed-in user is an admin; else sends 403
 * `forbidden` and returns false. The local user is not an admin.
 */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth?.user.is_admin === true) return true;
  void sendError(reply, 403, 'forbidden', 'admin only');
  return false;
}
