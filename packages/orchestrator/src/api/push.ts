import {
  API_PATHS,
  PushSubscribeRequestSchema,
  PushUnsubscribeRequestSchema,
  type OkResponse,
  type PushTestResponse,
  type PushVapidPublicKeyResponse,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { rateLimitRouteConfig } from '../auth/throttle.js';
import type { Db } from '../main.js';
import type { PushConfig } from '../push/config.js';
import { testPayload } from '../push/payload.js';
import { webPushSender, type PushSender } from '../push/sender.js';
import {
  deleteSubscription,
  recordResult,
  subscriptionsOf,
  upsertSubscription,
  type PushOwner,
} from '../push/store.js';
import { parseBody, sendError } from './errors.js';

// UX-15: the Web Push routes (10-contracts §Web Push). Signed in; the security hook (Origin /
// CSRF) and the auth hook (401) cover them like every /api/* route. Subscriptions are the
// caller's own (account + user); an endpoint is never sent back (NFR-2).

export interface PushRoutesOptions {
  db: Db;
  /** null → every route answers 404 `push_disabled`. */
  push: PushConfig | null;
  /** Default: web-push with `push`. */
  sender?: PushSender;
  now: () => Date;
}

const OK: OkResponse = { ok: true };

export const registerPushRoutes: FastifyPluginAsync<PushRoutesOptions> = (
  app,
  { db, push, sender, now },
) => {
  const send = push ? (sender ?? webPushSender(push)) : null;
  const disabled = (reply: FastifyReply) =>
    sendError(reply, 404, 'push_disabled', 'push notifications are not configured on this server');
  const ownerOf = (req: FastifyRequest): PushOwner | null => {
    const scope = req.auth!.scope;
    return scope.actor.kind === 'user'
      ? { account_id: scope.account_id, user_id: scope.actor.user_id }
      : null;
  };

  app.get(API_PATHS.pushVapidPublicKey, (_req, reply) => {
    if (!push) return disabled(reply);
    const body: PushVapidPublicKeyResponse = { public_key: push.publicKey };
    return reply.send(body);
  });

  app.post(API_PATHS.pushSubscriptions, async (req, reply) => {
    if (!push) return disabled(reply);
    const body = parseBody(PushSubscribeRequestSchema, req.body, reply);
    if (!body) return reply;
    const owner = ownerOf(req);
    if (!owner) return sendError(reply, 403, 'forbidden', 'only a user can subscribe');
    const ua = req.headers['user-agent'];
    await upsertSubscription(
      db,
      owner,
      { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth },
      typeof ua === 'string' ? ua : null,
    );
    return reply.code(201).send(OK);
  });

  app.delete(API_PATHS.pushSubscriptions, async (req, reply) => {
    if (!push) return disabled(reply);
    const body = parseBody(PushUnsubscribeRequestSchema, req.body, reply);
    if (!body) return reply;
    const owner = ownerOf(req);
    if (owner) await deleteSubscription(db, owner, body.endpoint);
    return reply.send(OK);
  });

  /** Sent directly, not through the outbox: the caller is waiting for the count. */
  app.post(API_PATHS.pushTest, { config: rateLimitRouteConfig('pushTest') }, async (req, reply) => {
    if (!push || !send) return disabled(reply);
    const owner = ownerOf(req);
    const payload = JSON.stringify(testPayload());
    let sent = 0;
    for (const sub of owner ? await subscriptionsOf(db, owner) : []) {
      const result = await send.send(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        payload,
      );
      if ((await recordResult(db, sub.id, result, now())) === 'ok') sent++;
    }
    const body: PushTestResponse = { sent };
    return reply.send(body);
  });
  return Promise.resolve();
};
