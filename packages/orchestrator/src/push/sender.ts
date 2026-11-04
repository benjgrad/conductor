import webpush from 'web-push';
import type { PushConfig } from './config.js';

// UX-15: the one place that talks to the browsers' push services (Web Push, RFC 8291 / 8292).
// Everything else takes a `PushSender`, so tests inject a fake one.

/** A push notification lives this long at the push service (FR-4: TTL 1 hour). */
export const PUSH_TTL_SECONDS = 3600;
/** Socket timeout of one send: a slow push service only delays pushes (NFR-1). */
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** How much of a push service's answer goes into an error (Apple: `{"reason":"BadJwtToken"}`). */
const REASON_MAX = 200;

/** One subscription's address and keys (`PushSubscription.toJSON()`). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult =
  | { ok: true }
  /** `gone`: the push service answered 404 / 410, the subscription no longer exists. */
  | { ok: false; gone: boolean; status: number | null; error: string };

export interface PushSender {
  send(target: PushTarget, payload: string): Promise<PushResult>;
}

/** The push service's reason, from its response body: JSON `reason` (Apple) or the text. */
function reasonOf(body: unknown): string {
  if (typeof body !== 'string') return '';
  const text = body.trim();
  if (text === '') return '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
      const reason = parsed.reason;
      if (typeof reason === 'string' && reason) return reason.slice(0, REASON_MAX);
    }
  } catch {
    // not JSON: the text itself
  }
  return text.replace(/\s+/g, ' ').slice(0, REASON_MAX);
}

/**
 * A failed send as a PushResult. The error is `http_<status>` plus the push service's reason
 * (e.g. `http_403 BadJwtToken`), so the test route and the outbox say *why* (iOS: a bad VAPID
 * subject or a key mismatch). Never the endpoint: it is a capability (NFR-2).
 */
export function failureOf(err: unknown): Extract<PushResult, { ok: false }> {
  const status =
    err instanceof webpush.WebPushError && typeof err.statusCode === 'number'
      ? err.statusCode
      : null;
  let error: string;
  if (status !== null) {
    const reason = reasonOf((err as webpush.WebPushError).body);
    error = reason ? `http_${status} ${reason}` : `http_${status}`;
  } else {
    error = err instanceof Error ? err.message.slice(0, REASON_MAX) : 'error';
  }
  return { ok: false, gone: status === 404 || status === 410, status, error };
}

/** The push service's host (`web.push.apple.com`), for logs: never the whole endpoint. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}

/** The real sender (`web-push`): TTL 1 hour, urgency high. Logs each failure (host + reason). */
export function webPushSender(cfg: PushConfig): PushSender {
  const vapidDetails = {
    subject: cfg.subject,
    publicKey: cfg.publicKey,
    privateKey: cfg.privateKey,
  };
  return {
    async send(target, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          payload,
          { vapidDetails, TTL: PUSH_TTL_SECONDS, urgency: 'high', timeout: PUSH_SEND_TIMEOUT_MS },
        );
        return { ok: true };
      } catch (err) {
        const failure = failureOf(err);
        console.warn(`[push] send to ${endpointHost(target.endpoint)} failed: ${failure.error}`);
        return failure;
      }
    },
  };
}

/** A new VAPID key pair (base64url), for `conductor-admin vapid-keys`. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}
