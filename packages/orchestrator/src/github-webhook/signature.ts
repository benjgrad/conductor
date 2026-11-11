import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// R11: GitHub signs every delivery with the webhook's secret: `X-Hub-Signature-256: sha256=<hex>`,
// HMAC-SHA256 over the raw request body. Only the SHA-256 header is accepted (the legacy SHA-1
// `X-Hub-Signature` never is). Pure.

export const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

/** Does `header` sign `raw` with `secret`? Constant-time on the digest. */
export function verifyGithubSignature(
  secret: string,
  raw: Buffer,
  header: string | string[] | undefined,
): boolean {
  if (typeof header !== 'string' || secret === '') return false;
  const m = SIGNATURE_RE.exec(header.trim().toLowerCase());
  if (m === null) return false;
  const given = Buffer.from(m[1]!, 'hex');
  const computed = createHmac('sha256', secret).update(raw).digest();
  return given.length === computed.length && timingSafeEqual(given, computed);
}

/** `sha256=<hex>` for `raw` (tests, and the docs' example). */
export function signGithubPayload(secret: string, raw: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** A new webhook secret: 32 random bytes, hex (what GitHub's form accepts as-is). */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}
