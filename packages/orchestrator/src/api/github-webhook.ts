import {
  API_PATHS,
  UuidSchema,
  type GithubWebhookAck,
  type GithubWebhookSecretCreated,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import { withTransaction } from '../db/index.js';
import { WEBHOOK_EVENTS, webhookTarget } from '../github-webhook/events.js';
import { nudgeForWebhook } from '../github-webhook/nudge.js';
import { SIGNATURE_HEADER, verifyGithubSignature } from '../github-webhook/signature.js';
import {
  recordDelivery,
  rotateWebhookSecret,
  setDeliveryNudged,
  webhookSecretOf,
  webhookStatus,
  webhookUrl,
} from '../github-webhook/store.js';
import type { Db } from '../main.js';
import { sendError } from './errors.js';

// R11 (ADR-0037 Q1 amended): GitHub webhooks wake conditions and watches.
// - POST API_PATHS.githubWebhookDelivery (`/api/webhooks/github/:id`, `:id` = the account): public,
//   authenticated by the HMAC of the raw body with the account's secret (no session, no Origin:
//   middleware.ts and security.ts exempt it). A matching session's next check comes forward to
//   now; the sweep and apply do the rest. Deliveries are deduplicated by `X-GitHub-Delivery`.
// - GET API_PATHS.githubWebhook / POST API_PATHS.githubWebhookSecret: the signed-in account's URL
//   and status, and a new secret (shown once).
// This plugin is encapsulated: its raw-buffer JSON parser applies to these routes only.

/** GitHub caps a delivery at 25 MB; the events used here are far smaller. */
export const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;

export interface GithubWebhookRoutesOptions {
  db: Db;
  auth: AuthConfig;
  now: () => Date;
  log?: (msg: string) => void;
}

type IdParams = { Params: { id: string } };

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

export const registerGithubWebhookRoutes: FastifyPluginAsync<GithubWebhookRoutesOptions> = (
  app,
  { db, auth, now, log = (m) => console.warn(`[github-webhook] ${m}`) },
) => {
  // The signature covers the exact bytes: keep them. Only these routes see a Buffer body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  const originOf = (req: FastifyRequest) =>
    auth.mode === 'password' ? auth.publicUrl.origin : `http://${req.headers.host ?? '127.0.0.1'}`;

  app.get(API_PATHS.githubWebhook, (req) =>
    webhookStatus(db, req.auth!.scope.account_id, originOf(req)),
  );

  app.post(API_PATHS.githubWebhookSecret, async (req): Promise<GithubWebhookSecretCreated> => {
    const accountId = req.auth!.scope.account_id;
    const secret = await rotateWebhookSecret(db, accountId, now());
    return { url: webhookUrl(originOf(req), accountId), secret };
  });

  app.post<IdParams>(API_PATHS.githubWebhookDelivery(':id'), async (req, reply) => {
    const accountId = req.params.id;
    const notFound = () => sendError(reply, 404, 'not_found', 'no webhook here');
    if (!UuidSchema.safeParse(accountId).success) return notFound();
    const secret = await webhookSecretOf(db, accountId);
    if (secret === null) return notFound();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyGithubSignature(secret, raw, req.headers[SIGNATURE_HEADER])) {
      log(`account ${accountId}: a delivery with a bad or missing signature was refused`);
      return sendError(reply, 401, 'unauthorized', 'invalid signature');
    }
    const event = header(req, 'x-github-event');
    const deliveryId = header(req, 'x-github-delivery');
    if (event === undefined || deliveryId === undefined || deliveryId.length > 200) {
      return sendError(reply, 400, 'bad_request', 'X-GitHub-Event and X-GitHub-Delivery required');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(reply, 400, 'bad_request', 'body is not valid JSON');
    }
    // GitHub's test delivery when the hook is added: nothing to record.
    if (event === 'ping') return reply.code(200).send({ ok: true, nudged: 0 });

    const at = now();
    const ack = await withTransaction(db, async (tx): Promise<GithubWebhookAck> => {
      if (!(await recordDelivery(tx, { deliveryId, accountId, event, now: at }))) {
        return { ok: true, nudged: 0, duplicate: true };
      }
      const target = (WEBHOOK_EVENTS as readonly string[]).includes(event)
        ? webhookTarget(event, payload)
        : null;
      if (target === null) return { ok: true, nudged: 0, ignored: true };
      const n = await nudgeForWebhook(tx, { accountId, target, now: at });
      const nudged = n.conditions + n.watches;
      await setDeliveryNudged(tx, deliveryId, nudged);
      return { ok: true, nudged };
    });
    return reply.code(ack.duplicate === true ? 200 : 202).send(ack);
  });

  return Promise.resolve();
};
