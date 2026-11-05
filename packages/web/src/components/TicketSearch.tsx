import {
  TICKET_SEARCH_LIMIT_MAX,
  ticketSearchGroup,
  type TicketSearchResponse,
  type TicketSearchResult,
  type TicketSearchStatus,
} from '@conductor/shared';
import { Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ApiClient } from '../api/client.js';
import { routeHash } from '../nav.js';
import { NavIcon } from './NavIcon.js';
import './TicketSearch.css';

// UXR-85 (11-web-ui §Top bar): find any ticket, done and cancelled ones too. Results as you type
// (GET /api/tickets, the same query as MCP `search_tickets`), grouped Open / Done / Cancelled; a
// result opens the ticket's panel. `/` focuses the field from anywhere but a text field.

/** Wait this long after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 150;
/** Results asked for per search; "More results" raises it. */
export const SEARCH_LIMIT = 20;

export const SEARCH_GROUPS: { id: Exclude<TicketSearchStatus, 'all'>; title: string }[] = [
  { id: 'open', title: 'Open' },
  { id: 'done', title: 'Done' },
  { id: 'cancelled', title: 'Cancelled' },
];

/** Results by group, in SEARCH_GROUPS order, each keeping the server's order (newest first). */
export function groupResults(
  tickets: readonly TicketSearchResult[],
): { id: string; title: string; tickets: TicketSearchResult[] }[] {
  return SEARCH_GROUPS.map((g) => ({
    ...g,
    tickets: tickets.filter((t) => ticketSearchGroup(t.status) === g.id),
  })).filter((g) => g.tickets.length > 0);
}

/** Does the key go to what has focus: a text field, a select or editable content? */
export function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** `/` focuses `ref` (or calls `onSlash`), unless the user is typing or a sheet is open. */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>, onSlash?: () => void) {
  const handler = useRef(onSlash);
  useEffect(() => {
    handler.current = onSlash;
  }, [onSlash]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (typingInto(e.target)) return;
      if (document.documentElement.classList.contains('modal-open')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      if (handler.current) handler.current();
      else ref.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref]);
}

/** A result's one line: title, then the short id, the repo and, for a closed ticket, its status. */
export function SearchResultText({ ticket }: { ticket: TicketSearchResult }): ReactNode {
  const repo = ticket.repo.replace(/^github\.com\//, '');
  return (
    <>
      <span className="search-result-title">{ticket.title}</span>
      <span className="search-result-meta">
        <code>{ticket.id.slice(0, 8)}</code>
        {ticket.external_ref && <span>{ticket.external_ref}</span>}
        <span>{repo}</span>
      </span>
      {ticket.snippet && <span className="search-result-snippet">{ticket.snippet}</span>}
    </>
  );
}

interface TicketSearchProps {
  api: ApiClient;
  /** Open the ticket's panel (its session's, when it has one). */
  onOpen: (ticket: TicketSearchResult) => void;
  /** Phone: an icon that opens the field over the bar. */
  mobile?: boolean;
}

export function TicketSearch({ api, onOpen, mobile = false }: TicketSearchProps) {
  const listId = useId();
  const optionId = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(SEARCH_LIMIT);
  const [found, setFound] = useState<{ q: string; res: TicketSearchResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Phone: the field shows only after the icon (or `/`) opened it.
  const [expanded, setExpanded] = useState(false);
  const seq = useRef(0);
  const q = query.trim();

  useSlashFocus(input, mobile ? () => setExpanded(true) : undefined);

  useEffect(() => {
    if (mobile && expanded) input.current?.focus();
  }, [mobile, expanded]);

  useEffect(() => {
    const mine = ++seq.current;
    // An empty field shows nothing (`shown`); the last results stay unread until the next query.
    if (q === '') return;
    const timer = setTimeout(() => {
      api.searchTickets({ q, status: ['all'], limit }).then(
        (res) => {
          if (mine !== seq.current) return;
          setFound({ q, res });
          setError(null);
          setActive(-1);
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          setError(err instanceof Error ? err.message : 'Search failed');
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, q, limit]);

  // A click outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
        if (mobile && q === '') setExpanded(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, mobile, q]);

  const groups = found ? groupResults(found.res.tickets) : [];
  const flat = groups.flatMap((g) => g.tickets);
  const shown = open && q !== '';

  function reset() {
    setQuery('');
    setLimit(SEARCH_LIMIT);
    setActive(-1);
    setOpen(false);
    if (mobile) setExpanded(false);
  }

  function pick(t: TicketSearchResult) {
    onOpen(t);
    reset();
    input.current?.blur();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (flat.length === 0) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) =>
        i < 0 ? (step > 0 ? 0 : flat.length - 1) : (i + step + flat.length) % flat.length,
      );
    } else if (e.key === 'Enter') {
      const t = flat[active] ?? (flat.length === 1 ? flat[0] : undefined);
      if (shown && t) {
        e.preventDefault();
        pick(t);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query !== '' || open) {
        setQuery('');
        setLimit(SEARCH_LIMIT);
        setOpen(false);
        setActive(-1);
      } else {
        input.current?.blur();
        if (mobile) setExpanded(false);
      }
    }
  }

  if (mobile && !expanded) {
    return (
      <button
        type="button"
        className="search-toggle"
        aria-label="Search tickets"
        title="Search tickets"
        onClick={() => setExpanded(true)}
      >
        <NavIcon icon={Search} />
      </button>
    );
  }

  const current = found !== null && found.q === q;
  let index = -1;
  return (
    <div ref={root} className={`ticket-search${mobile ? ' mobile' : ''}`}>
      <span className="ticket-search-icon" aria-hidden="true">
        <NavIcon icon={Search} />
      </span>
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search tickets"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${optionId}-${active}` : undefined}
        placeholder="Search tickets"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setError(null);
          setLimit(SEARCH_LIMIT);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {!mobile && query === '' && (
        <kbd className="ticket-search-key" aria-hidden="true">
          /
        </kbd>
      )}
      {mobile && (
        <button type="button" className="search-close" aria-label="Close search" onClick={reset}>
          <NavIcon icon={X} />
        </button>
      )}
      {shown && (
        <div className="ticket-search-popup">
          <div id={listId} role="listbox" aria-label="Tickets found">
            {groups.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`${listId}-${g.id}`}>
                <div id={`${listId}-${g.id}`} className="search-group-title" role="presentation">
                  {g.title}
                </div>
                {g.tickets.map((t) => {
                  index++;
                  const i = index;
                  return (
                    <div
                      key={t.id}
                      id={`${optionId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`search-result${i === active ? ' active' : ''}`}
                      // Keep focus in the field; the click picks.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(t)}
                      onMouseEnter={() => setActive(i)}
                    >
                      <SearchResultText ticket={t} />
                      {t.status === 'failed' && (
                        <span className="search-result-status">Failed</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {error && (
            <p className="search-note error" role="alert">
              {error}
            </p>
          )}
          {!error && !current && <p className="search-note">Searching…</p>}
          {!error && current && flat.length === 0 && (
            <p className="search-note">No tickets match “{q}”.</p>
          )}
          <div className="search-footer">
            {current && found.res.next_cursor !== null && (
              <button
                type="button"
                className="search-more"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setLimit((n) => Math.min(n + SEARCH_LIMIT, TICKET_SEARCH_LIMIT_MAX))}
                disabled={limit >= TICKET_SEARCH_LIMIT_MAX}
              >
                More results ({found.res.total})
              </button>
            )}
            <a href={routeHash({ view: 'archive' })} onClick={reset}>
              Browse the archive
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
