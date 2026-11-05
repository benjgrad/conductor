import {
  TICKET_SEARCH_STATUSES,
  type TicketKind,
  type TicketSearchResult,
  type TicketSearchStatus,
  type TicketStatus,
} from '@conductor/shared';
import type { Db } from '../main.js';

// UXR-85: one ticket search for MCP `search_tickets` and the web's GET /api/tickets (search box
// and Archive). Account-scoped: another account's ticket is never found.

const SNIPPET_MAX = 200;

/** `s` as a literal ILIKE pattern (backslash is the escape). */
export const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** ≤ SNIPPET_MAX chars of `text` around the first case-insensitive `query`, or its start. */
export function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - 60);
  const cut = flat.slice(start, start + SNIPPET_MAX - 2);
  return ((start > 0 ? '…' : '') + cut + (start + cut.length < flat.length ? '…' : '')).slice(
    0,
    SNIPPET_MAX,
  );
}

/** The ticket statuses of `groups`; null = every status (`all` among them). */
export function statusesOf(groups: readonly TicketSearchStatus[]): TicketStatus[] | null {
  if (groups.includes('all')) return null;
  return [...new Set(groups.flatMap((g) => TICKET_SEARCH_STATUSES[g as Exclude<typeof g, 'all'>]))];
}

export interface TicketSearchRow {
  id: string;
  title: string;
  body: string;
  external_ref: string | null;
  status: TicketStatus;
  kind: TicketKind | null;
  repo: string;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TicketSearchOptions {
  /** Trimmed; undefined = no text filter. */
  q?: string | undefined;
  statuses: readonly TicketSearchStatus[];
  limit: number;
  /** An offset. */
  cursor: number;
}

/**
 * The account's tickets matching `q` (title, external ref or body, case-insensitive; or the start
 * of the id, ≥ 4 hex) in `statuses`, most recently updated first, and how many match in all.
 */
export async function searchTickets(
  db: Db,
  accountId: string,
  opts: TicketSearchOptions,
): Promise<{ rows: TicketSearchRow[]; total: number }> {
  const q = opts.q === undefined || opts.q === '' ? null : opts.q;
  const hex = q?.toLowerCase().replace(/-/g, '') ?? '';
  // TD-200: ILIKE is a sequential scan of the account's tickets; M3-T02's tsvector + GIN index
  // replaces it.
  const where =
    "WHERE t.account_id = $1 AND ($2::text IS NULL OR t.title ILIKE $2 ESCAPE '\\' OR " +
    "t.external_ref ILIKE $2 ESCAPE '\\' OR t.body ILIKE $2 ESCAPE '\\' OR ($3::text IS NOT NULL " +
    "AND replace(t.id::text, '-', '') LIKE $3 || '%')) AND ($4::text[] IS NULL OR " +
    't.status::text = ANY($4::text[])) ';
  const params = [
    accountId,
    q === null ? null : `%${likeLiteral(q)}%`,
    q !== null && /^[0-9a-f]{4,32}$/.test(hex) ? hex : null,
    statusesOf(opts.statuses),
  ];
  const [rows, count] = await Promise.all([
    db.query<TicketSearchRow>(
      'SELECT t.id, t.title, t.body, t.external_ref, t.status, t.kind, t.repo, ' +
        't.created_at, t.updated_at, s.id AS session_id FROM ticket t ' +
        'LEFT JOIN LATERAL (SELECT id FROM session WHERE ticket_id = t.id AND account_id = ' +
        't.account_id ORDER BY created_at DESC LIMIT 1) s ON true ' +
        where +
        'ORDER BY t.updated_at DESC, t.id OFFSET $5 LIMIT $6',
      [...params, opts.cursor, opts.limit],
    ),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ticket t ${where}`, params),
  ]);
  return { rows: rows.rows, total: count.rows[0]?.n ?? 0 };
}

/** A row as the REST result (`snippet` only with a query). */
export function toSearchResult(row: TicketSearchRow, q: string | undefined): TicketSearchResult {
  return {
    id: row.id,
    title: row.title,
    external_ref: row.external_ref,
    status: row.status,
    kind: row.kind,
    repo: row.repo,
    snippet: q ? snippetOf(row.body, q) : null,
    session_id: row.session_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
