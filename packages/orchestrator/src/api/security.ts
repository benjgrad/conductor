import type { IncomingHttpHeaders } from 'node:http';
import { API_PATHS, conductorPort } from '@conductor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import { sendError } from './errors.js';

// The HTTP surface's guard, an onRequest hook before routing (09 §M1 local hardening, §Hosted
// security). Every response gets SECURITY_HEADERS (ADR-0017).
// Local mode (M1-T14; loopback, no sign-in): the threats are a browser tab on another origin
// (CSRF) and DNS rebinding (a hostile name resolving to 127.0.0.1):
//   1. 403 `forbidden` unless the Host header is loopback or in `allowedHosts`;
//   2. 403 `forbidden` for an unsafe request whose Origin is present and not allowed;
//   3. 415 `unsupported_media_type` for an unsafe request that isn't `application/json`.
// Password mode (M2-T08, ADR-0017 §CSRF): Host must be the public URL's host; an unsafe request
// must carry Origin = the public origin (no Origin only with `Sec-Fetch-Site: same-origin`, or on
// the token-authenticated POST API_PATHS.machinesEnroll); JSON only. No dev origins in either
// mode: the Vite dev proxy rewrites Vite's own Origin to the orchestrator's (vite.config.ts).

export interface HttpSecurityOptions {
  /** Extra Host names (hostname, or hostname:port) accepted besides loopback. */
  allowedHosts?: readonly string[];
  /**
   * Extra Origins (scheme://host[:port]) allowed on state-changing requests. Always allowed too:
   * the request's own origin (Origin host == Host) and the orchestrator's origin on CONDUCTOR_PORT.
   */
  allowedOrigins?: readonly string[];
}

export const ALLOWED_HOSTS_ENV = 'CONDUCTOR_ALLOWED_HOSTS';
export const ALLOWED_ORIGINS_ENV = 'CONDUCTOR_ALLOWED_ORIGINS';

/** ADR-0017 §Headers: on every response (the API's, and the static web app's in web-static.ts). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** Options from env: CONDUCTOR_ALLOWED_HOSTS / CONDUCTOR_ALLOWED_ORIGINS (comma lists). */
export function httpSecurityFromEnv(env: NodeJS.ProcessEnv = process.env): HttpSecurityOptions {
  return {
    allowedHosts: list(env[ALLOWED_HOSTS_ENV]),
    allowedOrigins: list(env[ALLOWED_ORIGINS_ENV]),
  };
}

/** Split a Host header into a lowercase hostname (IPv6 without brackets) and port. */
export function parseHostHeader(host: string): { hostname: string; port: string } | null {
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]\s/@]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m) return null;
  return { hostname: m[1]!.toLowerCase().replace(/^\[|\]$/g, ''), port: m[2] ?? '' };
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Lowercase `scheme://host[:port]`, or null if it isn't an http(s) origin. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export class HttpGuard {
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;

  constructor(opts: HttpSecurityOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    this.hosts = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));
    const port = conductorPort(env);
    const origins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(opts.allowedOrigins ?? []),
    ];
    this.origins = new Set(origins.map(normalizeOrigin).filter((o): o is string => o !== null));
  }

  hostAllowed(host: string | undefined): boolean {
    if (host === undefined) return false;
    const parsed = parseHostHeader(host);
    if (!parsed) return false;
    if (isLoopbackHostname(parsed.hostname)) return true;
    return this.hosts.has(parsed.hostname) || this.hosts.has(host.trim().toLowerCase());
  }

  /** An Origin is allowed if listed, or same-origin with an allowed Host. */
  originAllowed(origin: string, host: string | undefined): boolean {
    const o = normalizeOrigin(origin);
    if (o === null) return false; // includes the opaque `null` origin
    if (this.origins.has(o)) return true;
    if (host === undefined || !this.hostAllowed(host)) return false;
    const h = host.trim().toLowerCase();
    return o === `http://${h}` || o === `https://${h}`;
  }

  /** Origin check for a non-HTTP-verb surface (the WS upgrade): absent Origin passes. */
  upgradeAllowed(headers: IncomingHttpHeaders): boolean {
    const origin = headers.origin;
    if (origin === undefined) return true;
    return this.originAllowed(origin, headers.host);
  }
}

const isJson = (contentType: string | undefined): boolean =>
  contentType !== undefined &&
  contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';

/** Set on the raw response, so hijacked replies (SSE) carry them too. */
function setSecurityHeaders(reply: FastifyReply): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.raw.setHeader(k, v);
}

const pathOf = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
};

const refuseNonJson = (reply: FastifyReply, method: string) =>
  sendError(
    reply,
    415,
    'unsupported_media_type',
    `${method} requires content-type: application/json`,
  );

/** The local-mode hook (M1-T14). Returns the reply when it refused the request. */
export function securityHook(guard: HttpGuard) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    setSecurityHeaders(reply);
    const host = req.headers.host;
    if (!guard.hostAllowed(host)) {
      return sendError(reply, 403, 'forbidden', `host ${host ?? '(none)'} is not allowed`);
    }
    if (!STATE_CHANGING.has(req.method)) return undefined;
    const origin = req.headers.origin;
    if (origin !== undefined && !guard.originAllowed(origin, host)) {
      return sendError(reply, 403, 'forbidden', `origin ${origin} is not allowed`);
    }
    if (!isJson(req.headers['content-type'])) return refuseNonJson(reply, req.method);
    return undefined;
  };
}

/** `host[:port]` lower-cased, the scheme's default port dropped; null when unparseable. */
function normalizeHost(host: string, scheme: string): string | null {
  const parsed = parseHostHeader(host);
  if (!parsed) return null;
  const name = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  const dflt = scheme === 'https:' ? '443' : '80';
  return parsed.port === '' || parsed.port === dflt ? name : `${name}:${parsed.port}`;
}

/** The password-mode hook (ADR-0017 §CSRF, §Modes). Returns the reply when it refused. */
export function hostedSecurityHook(opts: { publicOrigin: string; publicHost: string }) {
  const scheme = new URL(opts.publicOrigin).protocol;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    setSecurityHeaders(reply);
    const host = req.headers.host;
    if (host === undefined || normalizeHost(host, scheme) !== opts.publicHost) {
      return sendError(reply, 403, 'forbidden', `host ${host ?? '(none)'} is not allowed`);
    }
    if (!STATE_CHANGING.has(req.method)) return undefined;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (normalizeOrigin(origin) !== opts.publicOrigin) {
        return sendError(reply, 403, 'forbidden', `origin ${origin} is not allowed`);
      }
    } else {
      const sameOrigin = req.headers['sec-fetch-site'] === 'same-origin';
      // The daemon's enroll call has neither header; the enrollment token authenticates it.
      const enroll = req.method === 'POST' && pathOf(req.url) === API_PATHS.machinesEnroll;
      if (!sameOrigin && !enroll) {
        return sendError(reply, 403, 'forbidden', 'a request without Origin is not allowed');
      }
    }
    if (!isJson(req.headers['content-type'])) return refuseNonJson(reply, req.method);
    return undefined;
  };
}

/** The hook for the mode: local → `securityHook` with the M1-T14 allow-lists; password → hosted. */
export function securityHookFor(auth: AuthConfig, security: HttpSecurityOptions = {}) {
  return auth.mode === 'password'
    ? hostedSecurityHook(auth)
    : securityHook(new HttpGuard(security));
}
