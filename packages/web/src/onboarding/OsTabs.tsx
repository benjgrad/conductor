import { useRef, type KeyboardEvent, type ReactNode } from 'react';

interface OsTabsProps<K extends string> {
  /** The tablist's accessible name. */
  label: string;
  /** Prefix of the tab and panel ids; unique on the page. */
  idPrefix: string;
  tabs: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  children: ReactNode;
}

/**
 * A tablist and its one panel (UX-8's OS tabs, shared with Add a machine, MW-T11). Arrow keys move
 * the selection and the focus.
 */
export function OsTabs<K extends string>({
  label,
  idPrefix,
  tabs,
  value,
  onChange,
  children,
}: OsTabsProps<K>) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const panelId = `${idPrefix}-tabpanel`;

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.key === value);
    const step = e.key === 'ArrowRight' ? 1 : tabs.length - 1;
    const next = tabs[(at + step) % tabs.length]!.key;
    onChange(next);
    refs.current.get(next)?.focus();
  }

  return (
    <>
      <div className="setup-tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              if (el) refs.current.set(t.key, el);
              else refs.current.delete(t.key);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.key}`}
            aria-selected={t.key === value}
            aria-controls={panelId}
            tabIndex={t.key === value ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={onKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={`${idPrefix}-tab-${value}`}>
        {children}
      </div>
    </>
  );
}
