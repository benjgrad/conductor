import type { IncomingHttpHeaders } from 'node:http';
import { conductorPort } from '@conductor/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';

// M1-T14: local hardening of the HTTP surface (09 §M1 local hardening). The orchestrator listens
// on 127.0.0.1 with no auth in M1, so the threats are a browser tab on another origin (CSRF) and
// DNS rebinding (a hostile name resolving to 127.0.0.1). An onRequest hook:
//   1. 403 unless the Host header is loopback or in `allowedHosts` (defeats DNS rebinding);
//   2. 403 for a state-changing request whose Origin is present and not allowed (CSRF);
//   3. 415 for a POST without `content-type: application/json` (no "simple" cross-site POSTs).
// The error body is the frozen ApiError shape; its code enum has no forbidden / unsupported
// media type entry, so these use `bad_request` with the 403 / 415 status.

export interface HttpSecurityOptions {
  /** Extra Host names (hostname, or hostname:port) accepted besides loopback. */
  allowedHosts?: readonly string[];
  /**
   * Extra Origins (scheme://host[:port]) allowed on state-changing requests. Always allowed too:
   * the request's own origin (Origin host == Host), the orchestrator's origin on CONDUCTOR_PORT,
   * and the Vite dev / preview origins (DEFAULT_DEV_ORIGINS).
   */
  allowedOrigins?: readonly string[];
}

export const ALLOWED_HOSTS_ENV = 'CONDUCTOR_ALLOWED_HOSTS';
export const ALLOWED_ORIGINS_ENV = 'CONDUCTOR_ALLOWED_ORIGINS';

/** Vite dev server (5173) and `vite preview` (4173) on loopback. */
export const DEFAULT_DEV_ORIGINS: readonly string[] = [5173, 4173].flatMap((p) => [
  `http://localhost:${p}`,
  `http://127.0.0.1:${p}`,
]);

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
      ...DEFAULT_DEV_ORIGINS,
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

/** The Fastify onRequest hook. Returns the reply when it refused the request. */
export function securityHook(guard: HttpGuard) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const host = req.headers.host;
    if (!guard.hostAllowed(host)) {
      return sendError(reply, 403, 'bad_request', `host ${host ?? '(none)'} is not allowed`);
    }
    const origin = req.headers.origin;
    if (STATE_CHANGING.has(req.method) && origin !== undefined) {
      if (!guard.originAllowed(origin, host)) {
        return sendError(reply, 403, 'bad_request', `origin ${origin} is not allowed`);
      }
    }
    if (req.method === 'POST' && !isJson(req.headers['content-type'])) {
      return sendError(reply, 415, 'bad_request', 'POST requires content-type: application/json');
    }
    return undefined;
  };
}
