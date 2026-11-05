import type { TicketSearchResult, TicketSearchStatus } from '@conductor/shared';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { ago } from './format.js';
import { SearchResultText } from './TicketSearch.js';
import './ArchivePage.css';

// UXR-85 (11-web-ui §Archive): `#/archive`, the done and cancelled tickets, newest first, a page
// at a time. Read once per filter: closed tickets rarely change, so it doesn't follow the stream.

export const ARCHIVE_PAGE = 25;

const FILTERS: { id: string; label: string; status: TicketSearchStatus[] }[] = [
  { id: 'closed', label: 'All closed', status: ['done', 'cancelled'] },
  { id: 'done', label: 'Done', status: ['done'] },
  { id: 'cancelled', label: 'Cancelled', status: ['cancelled'] },
];

interface ArchivePageProps {
  api: ApiClient;
  onOpen: (ticket: TicketSearchResult) => void;
  /** Tickets per page (tests use a small one). */
  pageSize?: number;
}

export function ArchivePage({ api, onOpen, pageSize = ARCHIVE_PAGE }: ArchivePageProps) {
  const [filter, setFilter] = useState(FILTERS[0]!);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const key = `${filter.id}|${q}|${pageSize}`;
  // The list as last read, for the filter it was read with (`key`).
  const [page, setPage] = useState<{
    key: string;
    tickets: TicketSearchResult[];
    next: number | null;
    total: number | null;
    error: string | null;
  } | null>(null);
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  // The filter box searches a moment after the last keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);

  const ask = (cursor: number) =>
    api.searchTickets({ ...(q ? { q } : {}), status: filter.status, limit: pageSize, cursor });
  const failed = (err: unknown) =>
    err instanceof Error ? err.message : 'Could not load the archive';

  // The first page, whenever the filter changes.
  useEffect(() => {
    const mine = ++seq.current;
    api
      .searchTickets({ ...(q ? { q } : {}), status: filter.status, limit: pageSize, cursor: 0 })
      .then(
        (res) => {
          if (mine !== seq.current) return;
          setPage({
            key,
            tickets: res.tickets,
            next: res.next_cursor,
            total: res.total,
            error: null,
          });
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          setPage({ key, tickets: [], next: null, total: null, error: failed(err) });
        },
      );
  }, [api, filter, q, pageSize, key]);

  function loadMore(cursor: number) {
    const mine = ++seq.current;
    setMore(true);
    ask(cursor).then(
      (res) => {
        setMore(false);
        if (mine !== seq.current) return;
        setPage((p) =>
          p === null
            ? p
            : {
                ...p,
                tickets: [...p.tickets, ...res.tickets],
                next: res.next_cursor,
                total: res.total,
                error: null,
              },
        );
      },
      (err: unknown) => {
        setMore(false);
        if (mine !== seq.current) return;
        setPage((p) => (p === null ? p : { ...p, error: failed(err) }));
      },
    );
  }

  const loading = page?.key !== key || more;
  const tickets = page?.tickets ?? [];
  const next = page?.next ?? null;
  const total = page?.key === key ? page.total : null;
  const error = page?.error ?? null;

  return (
    <section className="archive-page" aria-labelledby="archive-title">
      <header className="archive-header">
        <h2 id="archive-title">Archive</h2>
        {total !== null && (
          <span className="archive-count">
            {total} {total === 1 ? 'ticket' : 'tickets'}
          </span>
        )}
      </header>
      <div className="archive-filters">
        <div role="group" aria-label="Show" className="archive-chips">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={f.id === filter.id}
              onClick={() => setFilter(f)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Filter the archive"
          placeholder="Filter"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loading && !error && tickets.length === 0 && (
        <p className="archive-empty">
          {q ? `No closed tickets match “${q}”.` : 'No closed tickets yet.'}
        </p>
      )}
      {tickets.length > 0 && (
        <ul className="archive-list">
          {tickets.map((t) => (
            <li key={t.id}>
              <button type="button" className="archive-row" onClick={() => onOpen(t)}>
                <span className="archive-row-text">
                  <SearchResultText ticket={t} />
                </span>
                <span className={`archive-status status-${t.status}`}>
                  {t.status === 'cancelled' ? 'Cancelled' : 'Done'}
                </span>
                <time dateTime={t.updated_at} className="archive-when">
                  {ago(t.updated_at)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="loading">Loading…</p>}
      {!loading && next !== null && (
        <button type="button" className="archive-more" onClick={() => loadMore(next)}>
          Load more
        </button>
      )}
    </section>
  );
}
