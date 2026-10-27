import { isIP } from 'node:net';
import { isLoopbackHostname } from '../api/security.js';

// M2-T08: the orchestrator's startup config (ADR-0017 §Modes, §Hosting topology). Pure: main()
// calls it before touching the database, and every error names the variable at fault.

export const AUTH_ENV = 'CONDUCTOR_AUTH';
export const PUBLIC_URL_ENV = 'CONDUCTOR_PUBLIC_URL';
export const BIND_HOST_ENV = 'CONDUCTOR_BIND_HOST';
export const TRUSTED_PROXY_ENV = 'CONDUCTOR_TRUSTED_PROXY';
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** `__Host-` needs `Secure`, so a loopback `http` public URL (tests, e2e) uses the plain name. */
export const SECURE_COOKIE_NAME = '__Host-conductor_session';
export const PLAIN_COOKIE_NAME = 'conductor_session';

export type AuthConfig =
  | { mode: 'local' }
  | {
      mode: 'password';
      publicUrl: URL;
      /** `scheme://host[:port]`, lower-case: the only Origin accepted on unsafe requests. */
      publicOrigin: string;
      /** `host[:port]` (no default port), lower-case: the only Host accepted. */
      publicHost: string;
      cookie: { name: typeof SECURE_COOKIE_NAME | typeof PLAIN_COOKIE_NAME; secure: boolean };
    };

export const DEFAULT_AUTH: AuthConfig = { mode: 'local' };

export interface ServerConfig {
  bindHost: string;
  /** Fastify `trustProxy`: X-Forwarded-* are believed only from this exact peer address. */
  trustedProxy: string | null;
  auth: AuthConfig;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const val = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

/** Bind addresses like `127.0.0.1`, `::1`, `localhost` (brackets allowed for IPv6). */
const isLoopbackBind = (host: string) => isLoopbackHostname(host.replace(/^\[|\]$/g, ''));

/** The public URL (password mode): https, or http on a loopback host; an origin, nothing more. */
export function parsePublicUrl(raw: string | undefined): AuthConfig & { mode: 'password' } {
  if (raw === undefined) {
    throw new ConfigError(`${PUBLIC_URL_ENV} is required when ${AUTH_ENV}=password`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${PUBLIC_URL_ENV}=${raw} is not a URL`);
  }
  const loopback = isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(
      `${PUBLIC_URL_ENV}=${raw} must be https:// (http:// only for a loopback host)`,
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${PUBLIC_URL_ENV}=${raw} must not carry credentials, a query or a hash`);
  }
  if (url.pathname !== '/') {
    throw new ConfigError(`${PUBLIC_URL_ENV}=${raw} must be an origin (no path)`);
  }
  const secure = url.protocol === 'https:';
  return {
    mode: 'password',
    publicUrl: url,
    publicOrigin: url.origin.toLowerCase(),
    publicHost: url.host.toLowerCase(),
    cookie: secure
      ? { name: SECURE_COOKIE_NAME, secure: true }
      : { name: PLAIN_COOKIE_NAME, secure: false },
  };
}

/** Read and check CONDUCTOR_AUTH, CONDUCTOR_PUBLIC_URL, CONDUCTOR_BIND_HOST, CONDUCTOR_TRUSTED_PROXY. */
export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = val(env, AUTH_ENV) ?? 'local';
  if (mode !== 'local' && mode !== 'password') {
    throw new ConfigError(`${AUTH_ENV}=${mode} is not one of: local, password`);
  }
  const bindHost = val(env, BIND_HOST_ENV) ?? DEFAULT_BIND_HOST;
  const trustedProxy = val(env, TRUSTED_PROXY_ENV) ?? null;
  if (trustedProxy !== null && isIP(trustedProxy) === 0) {
    throw new ConfigError(`${TRUSTED_PROXY_ENV}=${trustedProxy} is not an IP address`);
  }
  if (mode === 'local') {
    if (!isLoopbackBind(bindHost)) {
      throw new ConfigError(
        `${BIND_HOST_ENV}=${bindHost}: local mode (no sign-in) only binds to loopback; ` +
          `set ${AUTH_ENV}=password and ${PUBLIC_URL_ENV} to serve other hosts`,
      );
    }
    return { bindHost, trustedProxy, auth: DEFAULT_AUTH };
  }
  // ADR-0017 §Modes: in password mode the allow-list is the public URL, nothing else.
  for (const key of ['CONDUCTOR_ALLOWED_HOSTS', 'CONDUCTOR_ALLOWED_ORIGINS']) {
    if (val(env, key) !== undefined) {
      throw new ConfigError(
        `${key} is not allowed when ${AUTH_ENV}=password (use ${PUBLIC_URL_ENV})`,
      );
    }
  }
  return { bindHost, trustedProxy, auth: parsePublicUrl(val(env, PUBLIC_URL_ENV)) };
}
