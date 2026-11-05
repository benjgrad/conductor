import { z } from 'zod';
import type { JsonObject } from '../domain.js';
import { pagesSpec, type WorkflowDefinition } from '../workflow/schema.js';

// ADR-0038: pages an agent attaches to its result (a mockup, a diagram, a data walkthrough). An
// agent state that lists `{"pages": {"max": n}}` in its `result` may add
// `"pages": [{"url", "title"}]` to its `complete_state` result. The engine stores it in
// `context[<state>]` like any extra key and never fails on it; this module reads it back, as
// api/proposals.ts does for `proposed_tickets`. Host-neutral: a Conductor-hosted `/p/:id` page
// (published with the `pages` tool's `publish_page`) or any other https page.

/** The `complete_state` result key carrying the pages (never a required `result` key). */
export const PAGES_KEY = 'pages';

/** Hosted pages: default and longest lifetime, largest document, most per ticket. */
export const PAGE_TTL_DEFAULT_DAYS = 7;
export const PAGE_TTL_MAX_DAYS = 30;
export const PAGE_HTML_MAX_BYTES = 2 * 1024 * 1024;
export const PAGES_PER_TICKET_MAX = 30;
export const PAGE_TITLE_MAX = 200;

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** https, or http on a loopback host (a local-mode conductor serves http://127.0.0.1). */
export function isPageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname));
}

/** One page as the agent writes it in its result. */
export const PageRefSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2_000)
    .refine(isPageUrl, 'a page url is https (http only on loopback)'),
  title: z.string().trim().min(1).max(PAGE_TITLE_MAX),
  expires_at: z.iso.datetime({ offset: true }).optional(),
});
export type PageRef = z.infer<typeof PageRefSchema>;

/** A page read from a session's context (GET session / ticket, get_ticket_artifacts). */
export const TicketPageSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** The state whose result attached it. */
  state: z.string(),
  expires_at: z.string().nullable(),
  /** A page this conductor hosts (`/p/:id`): the web app embeds it in a sandboxed iframe. */
  hosted: z.boolean(),
  /** A hosted page past its expiry, or swept: the link no longer opens. */
  expired: z.boolean(),
});
export type TicketPage = z.infer<typeof TicketPageSchema>;

/** How many pages each agent state's result may attach: its `{pages: {max}}`, 0 without one. */
export function pageLimitsOf(def: Pick<WorkflowDefinition, 'states'>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, s] of Object.entries(def.states)) {
    if (s.type !== 'agent') continue;
    const spec = pagesSpec(s);
    if (spec !== null) out.set(name, spec.max);
  }
  return out;
}

/**
 * Every well-formed page in the session's context, in context order, each state up to its limit
 * (`pageLimitsOf`; a state it doesn't name contributes nothing). `__`-prefixed keys are conductor's
 * bookkeeping. A `pages` that isn't an array is ignored, entries that don't parse are dropped, and
 * a url already seen is kept once. Never throws.
 */
export function pagesOfContext(
  context: Record<string, JsonObject> | null | undefined,
  limits: ReadonlyMap<string, number>,
): (PageRef & { state: string })[] {
  const out: (PageRef & { state: string })[] = [];
  const seen = new Set<string>();
  for (const [state, result] of Object.entries(context ?? {})) {
    if (state.startsWith('__')) continue;
    const limit = limits.get(state) ?? 0;
    if (limit === 0) continue;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) continue;
    const raw = (result as Record<string, unknown>)[PAGES_KEY];
    if (!Array.isArray(raw)) continue;
    let taken = 0;
    for (const entry of raw) {
      if (taken >= limit) break;
      const parsed = PageRefSchema.safeParse(entry);
      if (!parsed.success) continue;
      taken++;
      if (seen.has(parsed.data.url)) continue;
      seen.add(parsed.data.url);
      out.push({ ...parsed.data, state });
    }
  }
  return out;
}

/** The page id of a conductor-hosted page URL on `origin` (`<origin>/p/<uuid>`), else null. */
export function hostedPageId(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const m = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    u.pathname,
  );
  return m ? m[1]!.toLowerCase() : null;
}

/** POST API_PATHS.daemonSessionPages (the daemon, for its agent's `publish_page`). */
export const PublishPageRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(PAGE_TITLE_MAX),
  /** One self-contained HTML document; at most PAGE_HTML_MAX_BYTES of UTF-8 (checked on the server). */
  html: z.string().min(1),
  ttl_days: z.number().int().min(1).max(PAGE_TTL_MAX_DAYS).optional(),
  /** Mint a share link that opens without signing in (off by default). */
  share: z.boolean().optional(),
});
export type PublishPageRequest = z.input<typeof PublishPageRequestSchema>;

export const PublishPageResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** The link that opens without signing in; null unless shared. */
  share_url: z.string().nullable(),
  expires_at: z.string(),
});
export type PublishPageResponse = z.infer<typeof PublishPageResponseSchema>;

/** A ticket's hosted page (GET API_PATHS.ticketPages): the row without its HTML. */
export const HostedPageSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  workflow_state: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  share_url: z.string().nullable(),
  shared_by: z.enum(['agent', 'user']).nullable(),
});
export type HostedPage = z.infer<typeof HostedPageSchema>;

/** POST API_PATHS.ticketPageShare → ShareResponse (idempotent: the same link every time). */
export const SharePageResponseSchema = z.object({ share_url: z.string() });
export type SharePageResponse = z.infer<typeof SharePageResponseSchema>;
