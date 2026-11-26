import { ConfigError } from '../auth/config.js';

// ADR-0046: outbound email (invites) through Resend. Pure, like parsePushConfig: main() calls it
// before touching the database, and every error names the variable at fault. RESEND_API_KEY unset
// → mail is off: invites are created and shown once, as before, with `emailed: false`.

export const RESEND_API_KEY_ENV = 'RESEND_API_KEY';
export const MAIL_FROM_ENV = 'CONDUCTOR_MAIL_FROM';
export const DEFAULT_MAIL_FROM = 'Conductor <conductor@gradyserver.com>';

export interface MailConfig {
  /** A secret: never logged, never returned by the API. */
  apiKey: string;
  /** `Name <addr>` or a bare address; the domain must be verified in Resend. */
  from: string;
}

const val = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const NAMED = /^[^<>\r\n]+<([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>$/;

/** Whether `from` is `addr@host` or `Name <addr@host>`. */
export const isMailFrom = (from: string): boolean => ADDRESS.test(from) || NAMED.test(from);

/** The mail config, or null when mail is off. Throws ConfigError on a bad one. */
export function parseMailConfig(env: NodeJS.ProcessEnv): MailConfig | null {
  const apiKey = val(env, RESEND_API_KEY_ENV);
  const from = val(env, MAIL_FROM_ENV) ?? DEFAULT_MAIL_FROM;
  if (!isMailFrom(from)) {
    throw new ConfigError(`${MAIL_FROM_ENV}=${from} is not an address or "Name <address>"`);
  }
  if (apiKey === undefined) return null;
  if (/\s/.test(apiKey)) throw new ConfigError(`${RESEND_API_KEY_ENV} must not contain spaces`);
  return { apiKey, from };
}
