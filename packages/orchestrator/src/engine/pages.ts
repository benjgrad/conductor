import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  API_PATHS,
  DAEMON_FEATURE_PAGES,
  PAGE_HTML_MAX_BYTES,
  PAGE_TTL_DEFAULT_DAYS,
  PAGES_PER_TICKET_MAX,
  pageLimitsOf,
  pagesOfContext,
  type ApiErrorCode,
  type HostedPage,
  type JsonObject,
  type PublishPageResponse,
  type TicketPage,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { PageRow } from '../db/types.js';
import type { Db } from '../main.js';
import { DefinitionCache } from './rows.js';

// ADR-0038: conductor-hosted pages. The daemon's `publish_page` stores one HTML document per call
// (`publishPage`); GET /p/:id serves it (api/pages.ts); `sweepExpiredPages` deletes expired rows
// once a day. The pages an agent *attached* to its result are read from the session's context
// (`sessionPages`), whatever their host: the page table only says which of them are ours and when
// they expire. Nothing in the pure engine knows about this table.

const DAY_MS = 24 * 3600_000;

/** Page metadata columns (everything but the HTML). */
export const PAGE_META_COLUMNS =
  'id, account_id, ticket_id, session_id, workflow_state, title, size_bytes, share_token, ' +
  'shared_at, shared_by, created_at, expires_at';

/** `<origin>/p/<id>`, with `?t=<token>` for the share link. */
export function pageUrl(origin: string, id: string, token?: string | null): string {
  const base = `${origin.replace(/\/+$/, '')}${API_PATHS.page(id)}`;
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}

/** A fresh share token: 32 random bytes, base64url (unguessable, URL-safe). */
export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time token comparison (false for a missing or differently sized token). */
export function tokenMatches(given: string | null | undefined, stored: string | null): boolean {
  if (stored === null || given === null || given === undefined || given === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The session a page is published for. */
export interface PublishingSession {
  id: string;
  ticket_id: string;
  account_id: string;
  workflow_state: string;
}

export type PageRefusal = { ok: false; status: number; code: ApiErrorCode; message: string };

/**
 * Store one page for the session's ticket: at most PAGE_HTML_MAX_BYTES of UTF-8 and
 * PAGES_PER_TICKET_MAX live pages per ticket (counted under the ticket's row lock).
 */
export async function publishPage(
  db: Db,
  session: PublishingSession,
  input: { title: string; html: string; ttlDays?: number | undefined; share?: boolean | undefined },
  now: Date,
): Promise<{ ok: true; row: PageRow } | PageRefusal> {
  const size = Buffer.byteLength(input.html, 'utf8');
  if (size > PAGE_HTML_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'page_too_large',
      message: `the page is ${size} bytes; at most ${PAGE_HTML_MAX_BYTES}`,
    };
  }
  const expires = new Date(now.getTime() + (input.ttlDays ?? PAGE_TTL_DEFAULT_DAYS) * DAY_MS);
  const token = input.share === true ? newShareToken() : null;
  return withTransaction(db, async (tx) => {
    // Locks in the engine's order (session, then ticket): the page row's FK takes a key-share
    // lock on the session, so locking the ticket first deadlocked with an engine apply.
    await tx.query('SELECT 1 FROM session WHERE id = $1 FOR UPDATE', [session.id]);
    await tx.query('SELECT 1 FROM ticket WHERE id = $1 FOR UPDATE', [session.ticket_id]);
    const n = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM page WHERE ticket_id = $1 AND expires_at > $2',
      [session.ticket_id, now],
    );
    if ((n.rows[0]?.n ?? 0) >= PAGES_PER_TICKET_MAX) {
      return {
        ok: false as const,
        status: 409,
        code: 'page_limit' as const,
        message: `a ticket has at most ${PAGES_PER_TICKET_MAX} live pages`,
      };
    }
    const r = await tx.query<PageRow>(
      'INSERT INTO page (account_id, ticket_id, session_id, workflow_state, title, html, ' +
        'size_bytes, share_token, shared_at, shared_by, created_at, expires_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ' +
        'RETURNING *',
      [
        session.account_id,
        session.ticket_id,
        session.id,
        session.workflow_state,
        input.title,
        input.html,
        size,
        token,
        token === null ? null : now,
        token === null ? null : 'agent',
        now,
        expires,
      ],
    );
    return { ok: true as const, row: r.rows[0]! };
  });
}

/** The response `publish_page` returns to the agent. */
export function publishResponse(origin: string, row: PageRow): PublishPageResponse {
  return {
    id: row.id,
    url: pageUrl(origin, row.id),
    share_url: row.share_token === null ? null : pageUrl(origin, row.id, row.share_token),
    expires_at: row.expires_at.toISOString(),
  };
}

/**
 * Mint the page's share token once (a person's Share, `shared_by = 'user'`); later calls return
 * the same token. null when the page isn't the account's or has expired.
 */
export async function sharePage(
  q: Queryable,
  accountId: string,
  pageId: string,
  now: Date,
): Promise<string | null> {
  const r = await q.query<{ share_token: string }>(
    'UPDATE page SET share_token = COALESCE(share_token, $3), ' +
      "shared_at = COALESCE(shared_at, $4), shared_by = COALESCE(shared_by, 'user') " +
      'WHERE id = $1 AND account_id = $2 AND expires_at > $4 RETURNING share_token',
    [pageId, accountId, newShareToken(), now],
  );
  return r.rows[0]?.share_token ?? null;
}

/** A ticket's hosted pages, newest first (no HTML). */
export async function loadTicketHostedPages(
  q: Queryable,
  accountId: string,
  ticketId: string,
  origin: string,
): Promise<HostedPage[]> {
  const r = await q.query<Omit<PageRow, 'html'>>(
    `SELECT ${PAGE_META_COLUMNS} FROM page WHERE account_id = $1 AND ticket_id = $2 ` +
      'ORDER BY created_at DESC',
    [accountId, ticketId],
  );
  return r.rows.map((p) => ({
    id: p.id,
    url: pageUrl(origin, p.id),
    title: p.title,
    workflow_state: p.workflow_state,
    created_at: p.created_at.toISOString(),
    expires_at: p.expires_at.toISOString(),
    share_url: p.share_token === null ? null : pageUrl(origin, p.id, p.share_token),
    shared_by: p.shared_by,
  }));
}

/** Delete pages past their expiry. Returns how many. */
export async function sweepExpiredPages(q: Queryable, now: Date): Promise<number> {
  const r = await q.query('DELETE FROM page WHERE expires_at <= $1', [now]);
  return r.rowCount ?? 0;
}

/** The sweep runs at most this often (ADR-0038: daily). */
export const PAGE_SWEEP_INTERVAL_MS = DAY_MS;

const defs = new DefinitionCache();

/** What reading a session's attached pages needs. */
export interface PageSession {
  ticket_id: string;
  context: Record<string, JsonObject>;
  workflow_id: string;
  workflow_version: number;
}

const PAGE_PATH = /\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The pages the session's agent states attached (their pinned definition's `{pages: {max}}`),
 * each marked `hosted` when it is one of the ticket's rows in `page` (its expiry then comes from
 * the row), and `expired` once past it. [] when the definition can't be read.
 */
export async function sessionPages(
  q: Queryable,
  session: PageSession | null,
  now: Date = new Date(),
): Promise<TicketPage[]> {
  if (session === null) return [];
  const def = await defs.get(q, session.workflow_id, session.workflow_version).catch(() => null);
  if (def === null) return [];
  const refs = pagesOfContext(session.context, pageLimitsOf(def));
  if (refs.length === 0) return [];
  const ids = refs
    .map((p) => PAGE_PATH.exec(safePath(p.url))?.[1]?.toLowerCase())
    .filter((id): id is string => id !== undefined);
  const rows =
    ids.length === 0
      ? []
      : (
          await q.query<{ id: string; expires_at: Date }>(
            'SELECT id, expires_at FROM page WHERE ticket_id = $1 AND id = ANY($2::uuid[])',
            [session.ticket_id, ids],
          )
        ).rows;
  const byId = new Map(rows.map((r) => [r.id, r.expires_at]));
  return refs.map((p) => {
    const id = PAGE_PATH.exec(safePath(p.url))?.[1]?.toLowerCase();
    const hostedExpiry = id === undefined ? undefined : byId.get(id);
    const expiresAt =
      hostedExpiry !== undefined ? hostedExpiry.toISOString() : (p.expires_at ?? null);
    return {
      url: p.url,
      title: p.title,
      state: p.state,
      expires_at: expiresAt,
      hosted: hostedExpiry !== undefined,
      expired: expiresAt !== null && Date.parse(expiresAt) <= now.getTime(),
    };
  });
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** For a machine without DAEMON_FEATURE_PAGES: the paragraph appended to the prompt. */
export const PAGES_FALLBACK_NOTE =
  "\n\nThis machine's conductor daemon can't publish pages (`publish_page` is not available). " +
  'You can still attach page URLs from another host to your result.';

/**
 * The `start_session` payload for `target` (`machine:<id>`): unchanged unless its `tools` has
 * `pages` and the machine doesn't advertise DAEMON_FEATURE_PAGES, which an older daemon's tool
 * policy would refuse as an unknown alias. Then `pages` is dropped and the prompt says so.
 */
export async function withPagesFeature(
  q: Queryable,
  payload: JsonObject,
  target: string,
): Promise<JsonObject> {
  const tools = payload.tools;
  if (!Array.isArray(tools) || !tools.includes('pages')) return payload;
  const machineId = target.startsWith('machine:') ? target.slice('machine:'.length) : null;
  const m =
    machineId === null
      ? undefined
      : (
          await q.query<{ features: string[] }>('SELECT features FROM machine WHERE id = $1', [
            machineId,
          ])
        ).rows[0];
  if (m?.features.includes(DAEMON_FEATURE_PAGES) === true) return payload;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  return {
    ...payload,
    tools: tools.filter((t) => t !== 'pages'),
    prompt: prompt + PAGES_FALLBACK_NOTE,
  };
}
