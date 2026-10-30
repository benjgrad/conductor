import type { RepoSuggestion } from '@conductor/shared';
import { useId, useState, type KeyboardEvent } from 'react';

interface RepoComboboxProps {
  value: string;
  onChange: (repo: string) => void;
  /** GET /api/repos, best first. Empty while loading or when it failed: a plain text field. */
  suggestions: RepoSuggestion[];
}

/** The suggestions containing `query` (case-insensitive), in ranked order. */
export function filterRepos(suggestions: RepoSuggestion[], query: string): RepoSuggestion[] {
  const q = query.trim().toLowerCase();
  return q === '' ? suggestions : suggestions.filter((s) => s.repo.toLowerCase().includes(q));
}

/**
 * The create-ticket form's Repo field: free text, with a searchable list of the account's repos
 * (most used first, with a recency bias). ARIA combobox like the composer's slash menu.
 */
export function RepoCombobox({ value, onChange, suggestions }: RepoComboboxProps) {
  const inputId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Focusing a filled field lists every repo; typing filters.
  const [query, setQuery] = useState('');
  const items = filterRepos(suggestions, query);
  const shown = open && items.length > 0;

  function pick(repo: string) {
    onChange(repo);
    setOpen(false);
    setActive(-1);
    setQuery('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown) {
        setOpen(true);
        setActive(e.key === 'ArrowDown' ? 0 : items.length - 1);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + items.length) % items.length);
    } else if (e.key === 'Enter' && shown && active >= 0 && active < items.length) {
      // Picks the option; the form doesn't submit.
      e.preventDefault();
      pick(items[active]!.repo);
    } else if (e.key === 'Escape' && shown) {
      // Closes the list only, not the sheet around the form.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="repo-field">
      <label htmlFor={inputId}>Repo</label>
      <input
        id={inputId}
        value={value}
        required
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
          setQuery('');
        }}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul className="repo-options" role="listbox" id={listId} aria-label="Repos">
          {items.map((s, i) => (
            <li
              key={s.repo}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s.repo)}
            >
              <span className="repo-name">{s.repo}</span>
              {s.ticket_count > 0 && (
                <span className="repo-count muted">
                  {s.ticket_count} {s.ticket_count === 1 ? 'ticket' : 'tickets'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
