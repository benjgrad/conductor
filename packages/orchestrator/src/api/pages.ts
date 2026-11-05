import {
  API_PATHS,
  DAEMON_AUTH_HEADER,
  PAGE_HTML_MAX_BYTES,
  PublishPageRequestSchema,
  UuidSchema,
  parseDaemonAuthHeader,
  type SharePageResponse,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import type { PageRow } from '../db/types.js';
import {
  loadTicketHostedPages,
  publishPage,
  publishResponse,
  sharePage,
  tokenMatches,
  type PublishingSession,
} from '../engine/pages.js';
import { authenticateMachine } from '../gateway/auth.js';
import type { Db } from '../main.js';
import { sendError } from './errors.js';

// ADR-0038: conductor-hosted pages (06 §Pages, 10-contracts §Pages).
// - POST API_PATHS.daemonSessionPages: the daemon publishes its agent's page (machine credential,
//   as the agent attachment upload; JSON, so no special body parser).
// - GET API_PATHS.ticketPages / POST API_PATHS.pageShare: the card lists the ticket's pages and
//   mints a share link (session auth, the account's own pages only).
// - GET API_PATHS.page (`/p/:id`, outside /api): the HTML, for a session of the page's account or
//   with `?t=<share token>`. The page is untrusted (an agent wrote it), so PAGE_HEADERS replace
//   the app's security headers: a CSP `sandbox` gives the document an opaque origin even when it
//   is opened top-level, and `default-src 'none'` leaves it no network at all.

/** The publish route's body limit: the largest page, JSON-escaped, with room to spare. */
export const PAGE_BODY_LIMIT = PAGE_HTML_MAX_BYTES * 2;

/** What GET /p/:id is served with (ADR-0038 §Serving). */
export const PAGE_CSP =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; " +
  "base-uri 'none'; frame-ancestors 'self'";

export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PAGE_CSP,
  'x-frame-options': 'SAMEORIGIN',
  'x-content-type-options': 'nosniff',
  // The share token is in the query: never send it on.
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
};

/** A small HTML answer for /p/:id (a browser opened the link). */
function htmlStatus(reply: FastifyReply, status: number, text: string): FastifyReply {
  return reply
    .code(status)
    .headers({ ...PAGE_HEADERS, 'content-security-policy': "sandbox; default-src 'none'" })
    .send(`<!doctype html><meta charset="utf-8"><title>${text}</title><p>${text}</p>`);
}

export interface PageRoutesOptions {
  db: Db;
  auth: AuthConfig;
  now: () => Date;
}

type IdParams = { Params: { id: string } };

export const registerPageRoutes: FastifyPluginAsync<PageRoutesOptions> = (
  app,
  { db, auth, now },
) => {
  /** The origin page URLs are built on: the public URL, or the Host the request came in on. */
  const originOf = (req: FastifyRequest) =>
    auth.mode === 'password' ? auth.publicUrl.origin : `http://${req.headers.host ?? '127.0.0.1'}`;

  /**
   * An agent publishes a page. Password mode: the machine credential, and the session must be
   * live and on that machine (else 404). Local mode (loopback only, ADR-0017 §Modes): any live
   * session. The state is the session's own, never the daemon's word.
   */
  app.post<IdParams>(
    API_PATHS.daemonSessionPages(':id'),
    { bodyLimit: PAGE_BODY_LIMIT },
    async (req, reply) => {
      const id = req.params.id;
      let machineId: string | null = null;
      if (auth.mode === 'password') {
        const credential = parseDaemonAuthHeader(req.headers[DAEMON_AUTH_HEADER]);
        const machine = credential === null ? null : await authenticateMachine(db, credential);
        if (machine === null)
          return sendError(reply, 401, 'unauthorized', 'machine credential required');
        machineId = machine.machineId;
      }
      const noSession = () => sendError(reply, 404, 'not_found', `session ${id} not found`);
      if (!UuidSchema.safeParse(id).success) return noSession();
      const body = PublishPageRequestSchema.safeParse(req.body);
      if (!body.success) {
        return sendError(reply, 400, 'bad_request', 'expected {title, html, ttl_days?, share?}');
      }
      const s = await db.query<PublishingSession>(
        'SELECT id, ticket_id, account_id, workflow_state FROM session WHERE id = $1 ' +
          "AND status NOT IN ('done', 'failed', 'lost') " +
          'AND ($2::text IS NULL OR machine_id = $2)',
        [id, machineId],
      );
      const session = s.rows[0];
      if (!session) return noSession();
      const res = await publishPage(
        db,
        session,
        {
          title: body.data.title,
          html: body.data.html,
          ttlDays: body.data.ttl_days,
          share: body.data.share,
        },
        now(),
      );
      if (!res.ok) return sendError(reply, res.status, res.code, res.message);
      return reply.code(201).send(publishResponse(originOf(req), res.row));
    },
  );

  app.get<IdParams>(API_PATHS.ticketPages(':id'), async (req, reply) => {
    const id = req.params.id;
    if (!UuidSchema.safeParse(id).success) {
      return sendError(reply, 404, 'not_found', `ticket ${id} not found`);
    }
    return loadTicketHostedPages(db, req.auth!.scope.account_id, id, originOf(req));
  });

  app.post<IdParams>(API_PATHS.pageShare(':id'), async (req, reply) => {
    const id = req.params.id;
    const missing = () => sendError(reply, 404, 'not_found', `page ${id} not found`);
    if (!UuidSchema.safeParse(id).success) return missing();
    const token = await sharePage(db, req.auth!.scope.account_id, id, now());
    if (token === null) return missing();
    const res: SharePageResponse = { share_url: `${originOf(req)}/p/${id}?t=${token}` };
    return res;
  });

  /**
   * The page itself. A session of the page's account (always, in local mode), or the page's share
   * token. Another account's page, or a wrong token, is 404 like a missing one; no session and no
   * token is 401. Past `expires_at` it is 410 until the sweep deletes it.
   */
  const servePage = async (req: FastifyRequest<IdParams & { Querystring: { t?: string } }>, reply: FastifyReply) => {
    const id = req.params.id;
    if (!UuidSchema.safeParse(id).success) return htmlStatus(reply, 404, 'Page not found');
    const r = await db.query<PageRow>('SELECT * FROM page WHERE id = $1', [id]);
    const page = r.rows[0];
    const token = typeof req.query.t === 'string' ? req.query.t : null;
    const viewer = req.auth;
    const bySession = page !== undefined && viewer !== null && viewer.account.id === page.account_id;
    const byToken = page !== undefined && tokenMatches(token, page.share_token);
    if (!bySession && !byToken) {
      if (viewer === null && token === null) {
        return htmlStatus(reply, 401, 'Sign in to Conductor to view this page');
      }
      return htmlStatus(reply, 404, 'Page not found');
    }
    if (page.expires_at.getTime() <= now().getTime()) {
      return htmlStatus(reply, 410, 'This page has expired');
    }
    return reply.code(200).headers(PAGE_HEADERS).send(page.html);
  };
  app.get(API_PATHS.page(':id'), servePage);
  return Promise.resolve();
};
