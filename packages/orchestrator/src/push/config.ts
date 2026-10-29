import { ConfigError } from '../auth/config.js';

// UX-15: the Web Push (VAPID, RFC 8292) config. Pure, like parseServerConfig: main() calls it
// before touching the database, and every error names the variable at fault. All three unset →
// push is disabled (the /api/push/* routes answer 404 `push_disabled`, nothing is enqueued).

export const VAPID_PUBLIC_KEY_ENV = 'CONDUCTOR_VAPID_PUBLIC_KEY';
export const VAPID_PRIVATE_KEY_ENV = 'CONDUCTOR_VAPID_PRIVATE_KEY';
export const VAPID_SUBJECT_ENV = 'CONDUCTOR_VAPID_SUBJECT';

export interface PushConfig {
  /** base64url, an uncompressed P-256 point (65 bytes): the browser's `applicationServerKey`. */
  publicKey: string;
  /** base64url, 32 bytes. A secret: rotating it invalidates every subscription. */
  privateKey: string;
  /** `mailto:` (or `https:`): how a push service can reach the sender. */
  subject: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const val = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

function key(name: string, raw: string, bytes: number): string {
  if (!BASE64URL.test(raw) || Buffer.from(raw, 'base64url').length !== bytes) {
    throw new ConfigError(
      `${name} is not a base64url ${bytes}-byte key (conductor-admin vapid-keys)`,
    );
  }
  return raw;
}

/** The VAPID config, or null when push is disabled. Throws ConfigError on a partial or bad one. */
export function parsePushConfig(env: NodeJS.ProcessEnv): PushConfig | null {
  const names = [VAPID_PUBLIC_KEY_ENV, VAPID_PRIVATE_KEY_ENV, VAPID_SUBJECT_ENV] as const;
  const [pub, priv, subject] = names.map((n) => val(env, n));
  if (pub === undefined && priv === undefined && subject === undefined) return null;
  const missing = names.filter((n) => val(env, n) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`${missing.join(', ')} must be set too (or unset all CONDUCTOR_VAPID_*)`);
  }
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject!) && !/^https:\/\/\S+$/.test(subject!)) {
    throw new ConfigError(`${VAPID_SUBJECT_ENV}=${subject!} is not a mailto: address`);
  }
  return {
    publicKey: key(VAPID_PUBLIC_KEY_ENV, pub!, 65),
    privateKey: key(VAPID_PRIVATE_KEY_ENV, priv!, 32),
    subject: subject!,
  };
}
