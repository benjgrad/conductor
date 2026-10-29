import webpush from 'web-push';
import type { PushConfig } from './config.js';

// UX-15: the one place that talks to the browsers' push services (Web Push, RFC 8291 / 8292).
// Everything else takes a `PushSender`, so tests inject a fake one.

/** A push notification lives this long at the push service (FR-4: TTL 1 hour). */
export const PUSH_TTL_SECONDS = 3600;
/** Socket timeout of one send: a slow push service only delays pushes (NFR-1). */
export const PUSH_SEND_TIMEOUT_MS = 10_000;

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

/** The real sender (`web-push`): TTL 1 hour, urgency high. */
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
        const status =
          err instanceof webpush.WebPushError && typeof err.statusCode === 'number'
            ? err.statusCode
            : null;
        return {
          ok: false,
          gone: status === 404 || status === 410,
          status,
          error: status !== null ? `http_${status}` : err instanceof Error ? err.message : 'error',
        };
      }
    },
  };
}

/** A new VAPID key pair (base64url), for `conductor-admin vapid-keys`. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}
