import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isLoopbackHostname } from '../api/security.js';

// ADR-0028: the pure parts of the OAuth server. Secrets are 32 random bytes, base64url; only
// their SHA-256 is stored. Redirect URIs follow RFC 8252 (loopback: any port) and OAuth 2.1.

/** Access-token prefix (helps secret scanners). */
export const ACCESS_PREFIX = 'cnd_at_';
/** Refresh-token prefix. */
export const REFRESH_PREFIX = 'cnd_rt_';

/** `prefix` + base64url(32 random bytes). */
export function randomSecret(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

/** SHA-256 of a secret's UTF-8, the stored form. */
export function sha256(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** RFC 7636 §4.6: base64url(sha256(verifier)) = challenge, compared in constant time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: 43..128 unreserved characters.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const given = Buffer.from(challenge);
  return computed.length === given.length && timingSafeEqual(computed, given);
}

/** A PKCE S256 challenge: base64url of 32 bytes. */
export const isS256Challenge = (s: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(s);

const loopbackHost = (u: URL): boolean => isLoopbackHostname(u.hostname.replace(/^\[|\]$/g, ''));

/**
 * Why a redirect URI can't be registered, or null when it can: `https:`, or `http:` on a loopback
 * host; no fragment, no userinfo, at most 2 000 chars.
 */
export function redirectUriProblem(raw: string): string | null {
  if (raw.length > 2000) return 'is too long';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopbackHost(u))) {
    return 'must be https:// (http:// only on a loopback host)';
  }
  if (u.hash !== '' || raw.includes('#')) return 'must not have a fragment';
  if (u.username !== '' || u.password !== '') return 'must not carry credentials';
  return null;
}

/**
 * Whether `given` matches a registered URI: exactly, or (RFC 8252 §7.3) a loopback URI that
 * differs only in its port.
 */
export function redirectUriMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== 'http:' || !loopbackHost(g)) return false;
  return registered.some((r) => {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return false;
    }
    return (
      u.protocol === 'http:' &&
      u.hostname === g.hostname &&
      u.pathname === g.pathname &&
      u.search === g.search
    );
  });
}

/** Whether the redirect goes back to this computer (the consent page says so). */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && loopbackHost(u);
  } catch {
    return false;
  }
}

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
