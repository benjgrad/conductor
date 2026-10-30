import { randomUUID } from 'node:crypto';
import { API_PATHS } from '@conductor/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SECURITY_HEADERS } from '../api/security.js';
import type { AuthConfig } from '../auth/config.js';
import { rateLimitRouteConfig } from '../auth/throttle.js';
import { withTransaction } from '../db/index.js';
import type { OAuthClientRow, OAuthCodeRow, OAuthTokenRow } from '../db/types.js';
import type { Db } from '../main.js';
import {
  escapeHtml,
  isLoopbackRedirect,
  isS256Challenge,
  randomSecret,
  redirectUriMatches,
  redirectUriProblem,
  sha256,
  verifyPkceS256,
} from './secrets.js';
import {
  CODE_TTL_MS,
  OAUTH_SCOPE,
  issueTokens,
  revokeGrant,
  type TokenResponse,
} from './tokens.js';

// ADR-0028: conductor as a minimal OAuth 2.1 authorization server for /mcp (MCP authorization
// spec; RFC 8414 / 9728 discovery, RFC 7591 registration, RFC 7636 PKCE S256, RFC 8707 resource).
// Public clients only. The login step is conductor's own sign-in (/signin?next=), the consent
// step a server-rendered page whose form posts back to /oauth/authorize (Origin-checked by the
// security hook: its CSRF guard). /oauth/register and /oauth/token never read the cookie.

export interface OAuthRouteDeps {
  db: Db;
  auth: AuthConfig;
  now: () => Date;
}

/** `https://host` in password mode; the request's own origin in local mode (Host is checked). */
export function issuerOf(auth: AuthConfig, req: FastifyRequest): string {
  return auth.mode === 'password' ? auth.publicOrigin : `http://${req.headers.host ?? ''}`;
}

/** The protected resource: the MCP endpoint (RFC 8707 audience). */
export const resourceOf = (issuer: string): string => issuer + API_PATHS.mcp;

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: resourceOf(issuer),
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'conductor',
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: issuer + API_PATHS.oauthAuthorize,
    token_endpoint: issuer + API_PATHS.oauthToken,
    registration_endpoint: issuer + API_PATHS.oauthRegister,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

const RegisterSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(5),
  client_name: z
    .string()
    .trim()
    .max(60)
    .regex(/^[^\p{Cc}]*$/u)
    .optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
});

/** Every OAuth error body (RFC 6749 §5.2, RFC 7591 §3.2.2). */
const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.code(status).send({ error, error_description: description });

/** The authorize request's fields, from the query (GET) or the consent form (POST). */
type Params = Record<string, string | undefined>;

type AuthorizeCheck =
  /** Client or redirect URI unknown: an error page, never a redirect (RFC 6749 §4.1.2.1). */
  | { kind: 'fatal'; message: string }
  | { kind: 'redirect'; redirectUri: string; state: string | null; error: string; message: string }
  | {
      kind: 'ok';
      client: OAuthClientRow;
      redirectUri: string;
      state: string | null;
      challenge: string;
    };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function paramsOf(source: unknown): Params {
  const o = (source ?? {}) as Record<string, unknown>;
  const out: Params = {};
  for (const k of [
    'client_id',
    'redirect_uri',
    'response_type',
    'code_challenge',
    'code_challenge_method',
    'state',
    'resource',
    'scope',
    'decision',
  ]) {
    out[k] = str(o[k]);
  }
  return out;
}

/** A URL on the client's redirect URI with `params` (and `iss`) added to its query. */
function redirectTo(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

function htmlPage(reply: FastifyReply, status: number, title: string, body: string, csp?: string) {
  if (csp !== undefined) reply.header('content-security-policy', csp);
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>` +
        `<body><main>${body}</main></body></html>`,
    );
}

const PAGE_CSS =
  'body{font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1d2330;margin:0}' +
  'main{max-width:28rem;margin:10vh auto;background:#fff;padding:2rem;border-radius:12px;' +
  'box-shadow:0 1px 4px #0002}h1{font-size:1.25rem;margin:0 0 1rem}.muted{color:#5b6475;' +
  'font-size:.875rem}.row{display:flex;gap:.75rem;margin-top:1.5rem}button{flex:1;padding:.6rem;' +
  'border-radius:8px;border:1px solid #c9ced8;background:#fff;font:inherit;cursor:pointer}' +
  'button.allow{background:#2457d6;border-color:#2457d6;color:#fff}';

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): Promise<void> {
  const { db, auth, now } = deps;

  app.addHook('onSend', (req, reply, payload, done) => {
    if (req.url.startsWith('/oauth/')) void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  // ---------------------------------------------------------------- discovery

  const resourceDoc = (req: FastifyRequest) => protectedResourceMetadata(issuerOf(auth, req));
  app.get(API_PATHS.wellKnownProtectedResource, resourceDoc);
  app.get(API_PATHS.wellKnownProtectedResourceMcp, resourceDoc);
  const serverDoc = (req: FastifyRequest) => authorizationServerMetadata(issuerOf(auth, req));
  app.get(API_PATHS.wellKnownAuthServer, serverDoc);
  // Some clients append the resource path (RFC 8414 §3.1 with a path-ful issuer guess).
  app.get(`${API_PATHS.wellKnownAuthServer}${API_PATHS.mcp}`, serverDoc);

  // ---------------------------------------------------------------- registration (RFC 7591)

  app.post(
    API_PATHS.oauthRegister,
    { config: rateLimitRouteConfig('oauth') },
    async (req, reply) => {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return oauthError(reply, 400, 'invalid_client_metadata', parsed.error.issues[0]!.message);
      }
      for (const uri of parsed.data.redirect_uris) {
        const problem = redirectUriProblem(uri);
        if (problem !== null) {
          return oauthError(reply, 400, 'invalid_redirect_uri', `redirect_uri ${problem}`);
        }
      }
      const name = parsed.data.client_name || 'Unnamed client';
      const id = randomSecret().slice(0, 22);
      await db.query('INSERT INTO oauth_client (id, name, redirect_uris) VALUES ($1, $2, $3)', [
        id,
        name,
        parsed.data.redirect_uris,
      ]);
      return reply.code(201).send({
        client_id: id,
        client_name: name,
        redirect_uris: parsed.data.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    },
  );

  // ---------------------------------------------------------------- authorize + consent

  async function checkAuthorize(p: Params, issuer: string): Promise<AuthorizeCheck> {
    if (!p.client_id || p.client_id.length > 64) return { kind: 'fatal', message: 'Unknown app.' };
    const c = await db.query<OAuthClientRow>('SELECT * FROM oauth_client WHERE id = $1', [
      p.client_id,
    ]);
    const client = c.rows[0];
    if (!client) return { kind: 'fatal', message: 'Unknown app. Connect it again.' };
    const redirectUri =
      p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (redirectUri === undefined || !redirectUriMatches(client.redirect_uris, redirectUri)) {
      return { kind: 'fatal', message: 'The app gave a return address it did not register.' };
    }
    const state = p.state ?? null;
    const fail = (error: string, message: string): AuthorizeCheck => ({
      kind: 'redirect',
      redirectUri,
      state,
      error,
      message,
    });
    if (p.response_type !== 'code') {
      return fail('unsupported_response_type', 'response_type must be code');
    }
    if (p.code_challenge_method !== 'S256' || !p.code_challenge) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    if (!isS256Challenge(p.code_challenge)) {
      return fail('invalid_request', 'code_challenge is not an S256 challenge');
    }
    if (p.resource !== undefined && p.resource !== resourceOf(issuer)) {
      return fail('invalid_target', `resource must be ${resourceOf(issuer)}`);
    }
    return { kind: 'ok', client, redirectUri, state, challenge: p.code_challenge };
  }

  /** Answer a non-ok check: an error page, or the error sent back to the client. */
  function refuse(
    reply: FastifyReply,
    check: Exclude<AuthorizeCheck, { kind: 'ok' }>,
    iss: string,
  ) {
    if (check.kind === 'fatal') {
      return htmlPage(
        reply,
        400,
        'Can’t connect',
        `<h1>Can’t connect this app</h1><p>${escapeHtml(check.message)}</p>`,
      );
    }
    return reply.redirect(
      redirectTo(check.redirectUri, {
        error: check.error,
        error_description: check.message,
        state: check.state,
        iss,
      }),
    );
  }

  app.get(
    API_PATHS.oauthAuthorize,
    { config: rateLimitRouteConfig('oauth') },
    async (req, reply) => {
      const issuer = issuerOf(auth, req);
      const p = paramsOf(req.query);
      const check = await checkAuthorize(p, issuer);
      if (check.kind !== 'ok') return refuse(reply, check, issuer);
      if (req.auth === null) {
        return reply.redirect(`/signin?next=${encodeURIComponent(req.url)}`);
      }
      const back = isLoopbackRedirect(check.redirectUri)
        ? 'an app on this computer'
        : new URL(check.redirectUri).host;
      const hidden = Object.entries(p)
        .filter(([k, v]) => k !== 'decision' && v !== undefined)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v!)}">`)
        .join('');
      // The form's POST answers with a redirect to the client: CSP form-action must allow its
      // origin too, or the browser blocks the redirect (it applies form-action to redirects).
      const csp = SECURITY_HEADERS['content-security-policy']!.replace(
        "form-action 'self'",
        `form-action 'self' ${new URL(check.redirectUri).origin}`,
      );
      return htmlPage(
        reply,
        200,
        'Connect to conductor',
        `<h1>Allow <strong>${escapeHtml(check.client.name)}</strong> to use conductor?</h1>` +
          `<p class="muted">Name given by the app; conductor can’t verify it.</p>` +
          `<p>It will be able to read, create and move your conductor tickets and answer their ` +
          `questions, as <strong>${escapeHtml(req.auth.user.email)}</strong>.</p>` +
          `<p class="muted">It returns to ${escapeHtml(back)}.</p>` +
          `<form method="post" action="${API_PATHS.oauthAuthorize}">${hidden}<div class="row">` +
          `<button type="submit" name="decision" value="deny" autofocus>Deny</button>` +
          `<button type="submit" name="decision" value="allow" class="allow">Allow</button>` +
          `</div></form>`,
        csp,
      );
    },
  );

  app.post(
    API_PATHS.oauthAuthorize,
    { config: rateLimitRouteConfig('oauth') },
    async (req, reply) => {
      const issuer = issuerOf(auth, req);
      const p = paramsOf(req.body);
      const check = await checkAuthorize(p, issuer);
      if (check.kind !== 'ok') return refuse(reply, check, issuer);
      if (req.auth === null) {
        return htmlPage(
          reply,
          401,
          'Signed out',
          '<h1>You are signed out</h1><p>Start again from your app.</p>',
        );
      }
      if (p.decision !== 'allow') {
        return reply.redirect(
          redirectTo(check.redirectUri, {
            error: 'access_denied',
            state: check.state,
            iss: issuer,
          }),
        );
      }
      const code = randomSecret();
      const t = now();
      await db.query(
        'INSERT INTO oauth_code (code_hash, client_id, account_id, user_id, grant_id, ' +
          'redirect_uri, code_challenge, created_at, expires_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          sha256(code),
          check.client.id,
          req.auth.account.id,
          req.auth.user.id,
          randomUUID(),
          check.redirectUri,
          check.challenge,
          t,
          new Date(t.getTime() + CODE_TTL_MS),
        ],
      );
      return reply.redirect(
        redirectTo(check.redirectUri, { code, state: check.state, iss: issuer }),
      );
    },
  );

  // ---------------------------------------------------------------- token

  type TokenResult =
    { ok: true; tokens: TokenResponse } | { ok: false; error: string; message: string };
  const invalidGrant = (message: string): TokenResult => ({
    ok: false,
    error: 'invalid_grant',
    message,
  });

  app.post(API_PATHS.oauthToken, { config: rateLimitRouteConfig('oauth') }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = str(body.grant_type);
    const clientId = str(body.client_id);
    const resource = str(body.resource);
    const issuer = issuerOf(auth, req);
    if (resource !== undefined && resource !== resourceOf(issuer)) {
      return oauthError(reply, 400, 'invalid_target', `resource must be ${resourceOf(issuer)}`);
    }
    if (clientId === undefined)
      return oauthError(reply, 401, 'invalid_client', 'client_id is required');
    const t = now();

    let result: TokenResult;
    if (grantType === 'authorization_code') {
      const code = str(body.code);
      const verifier = str(body.code_verifier);
      const redirectUri = str(body.redirect_uri);
      if (!code || !verifier) {
        return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are required');
      }
      result = await withTransaction(db, async (tx): Promise<TokenResult> => {
        const r = await tx.query<OAuthCodeRow>(
          'SELECT * FROM oauth_code WHERE code_hash = $1 FOR UPDATE',
          [sha256(code)],
        );
        const row = r.rows[0];
        if (!row) return invalidGrant('unknown code');
        if (row.used_at !== null) {
          // RFC 6749 §4.1.2: a replayed code revokes what it issued.
          await revokeGrant(tx, row.grant_id, t);
          return invalidGrant('code already used');
        }
        await tx.query('UPDATE oauth_code SET used_at = $2 WHERE code_hash = $1', [
          row.code_hash,
          t,
        ]);
        if (row.expires_at.getTime() <= t.getTime()) return invalidGrant('code expired');
        if (row.client_id !== clientId) return invalidGrant('code was issued to another client');
        if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
          return invalidGrant('redirect_uri does not match');
        }
        if (!verifyPkceS256(verifier, row.code_challenge)) {
          return invalidGrant('code_verifier does not match');
        }
        return { ok: true, tokens: await issueTokens(tx, row, t) };
      });
    } else if (grantType === 'refresh_token') {
      const refresh = str(body.refresh_token);
      if (!refresh) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');
      result = await withTransaction(db, async (tx): Promise<TokenResult> => {
        const r = await tx.query<OAuthTokenRow>(
          "SELECT * FROM oauth_token WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE",
          [sha256(refresh)],
        );
        const row = r.rows[0];
        if (!row || row.revoked_at !== null || row.expires_at.getTime() <= t.getTime()) {
          return invalidGrant('refresh_token is not valid');
        }
        if (row.client_id !== clientId)
          return invalidGrant('refresh_token belongs to another client');
        // Rotation: the old refresh token is spent; the grant carries on.
        await tx.query('UPDATE oauth_token SET revoked_at = $2 WHERE token_hash = $1', [
          row.token_hash,
          t,
        ]);
        return { ok: true, tokens: await issueTokens(tx, row, t) };
      });
    } else {
      return oauthError(
        reply,
        400,
        'unsupported_grant_type',
        'use authorization_code or refresh_token',
      );
    }
    if (!result.ok) return oauthError(reply, 400, result.error, result.message);
    return reply.header('pragma', 'no-cache').send(result.tokens);
  });

  return Promise.resolve();
}
