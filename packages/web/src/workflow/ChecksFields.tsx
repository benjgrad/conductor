import type { EntryCheck } from '@conductor/shared';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';

// A check list and the setup before it: a transition's `requires.checks` (TransitionEditor) and a
// repo's check override (ADR-0030, the Repo checks page). Every change goes to `onChange`; the
// caller validates (`checkListIssues`) and passes the problems in `issues`. The fields show those
// at `checksFieldSuffixes`; the caller shows the rest.

/** At most this many checks (TransitionRequires, RepoChecks). */
export const MAX_CHECKS = 20;

export interface ChecksValue {
  checks: EntryCheck[];
  /** undefined = auto-detect from the lockfile, '' = none, otherwise the command. */
  setup: string | undefined;
}

/** A problem at a path relative to the list (`checks.0.name`, `checks`, `setup`). */
export interface ChecksIssue {
  suffix: string;
  message: string;
}

/** The suffixes the fields show problems at, for these checks (setup only while there are checks). */
export function checksFieldSuffixes(checks: readonly EntryCheck[]): Set<string> {
  const out = new Set(['checks']);
  checks.forEach((_, i) => {
    for (const f of ['name', 'cmd', 'timeout']) out.add(`checks.${i}.${f}`);
  });
  if (checks.length > 0) out.add('setup');
  return out;
}

export interface ChecksFieldsProps extends ChecksValue {
  onChange: (next: ChecksValue) => void;
  /** Problems to show under their fields (those at `checksFieldSuffixes`; others are ignored). */
  issues: readonly ChecksIssue[];
  /** The setup field's label. */
  setupLabel?: string;
  /** UXR-71: a check was added at `index` (its problems wait until it loses focus). */
  onAdded?: (index: number) => void;
  /** Focus left check `index` (its fields and buttons). */
  onItemBlur?: (index: number) => void;
  /** A check was moved or removed (the indexes shifted). */
  onReordered?: () => void;
}

/** Focus out of the element `e` was on, to somewhere outside it. */
export const leftItem = (e: FocusEvent<HTMLElement>) =>
  !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget));

/** Focus the first field of a just-added item: `focusNew(i)` after adding item i. */
export function useFocusNew(selector: string) {
  const list = useRef<HTMLOListElement>(null);
  const pending = useRef<number | null>(null);
  // After every render: the item asked for has rendered by the commit that follows the add.
  useEffect(() => {
    if (pending.current === null) return;
    const item = list.current?.children[pending.current];
    if (!item) return;
    pending.current = null;
    item.querySelector<HTMLElement>(selector)?.focus();
  });
  const focusNew = useCallback((index: number) => {
    pending.current = index;
  }, []);
  return { list, focusNew };
}

export function ChecksFields({
  checks,
  setup,
  onChange,
  issues,
  setupLabel = 'Before the checks (in a fresh checkout of the commit)',
  onAdded,
  onItemBlur,
  onReordered,
}: ChecksFieldsProps) {
  const uid = useId();
  const { list, focusNew } = useFocusNew('input');
  /** The user picked "Custom command" (its text may still be empty, which reads as none). */
  const [customSetup, setCustomSetup] = useState(false);
  const issueAt = (suffix: string): ReactNode =>
    issues
      .filter((i) => i.suffix === suffix)
      .map((i) => (
        <p key={i.message} className="wf-field-error" role="alert">
          {i.message}
        </p>
      ));
  const setChecks = (next: EntryCheck[]) => onChange({ checks: next, setup });
  const setSetup = (next: string | undefined) => onChange({ checks, setup: next });
  const setupMode: 'auto' | 'none' | 'custom' =
    setup === undefined ? 'auto' : setup === '' && !customSetup ? 'none' : 'custom';
  return (
    <>
      <ol ref={list} className="wf-items" aria-label="Checks">
        {checks.map((c, i) => (
          <li
            key={i}
            className="wf-item"
            onBlur={(e) => {
              if (leftItem(e)) onItemBlur?.(i);
            }}
          >
            <div className="wf-check">
              <input
                aria-label={`Check ${i + 1} name`}
                value={c.name}
                placeholder="e.g. Tests pass"
                onChange={(e) =>
                  setChecks(checks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <input
                aria-label={`Check ${i + 1} command`}
                className="mono"
                value={c.cmd}
                placeholder="e.g. npm test"
                onChange={(e) =>
                  setChecks(checks.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)))
                }
              />
              <input
                aria-label={`Check ${i + 1} timeout`}
                className="mono"
                value={c.timeout ?? ''}
                placeholder="timeout (default)"
                onChange={(e) =>
                  setChecks(
                    checks.map((x, j) => {
                      if (j !== i) return x;
                      const next = { ...x };
                      delete next.timeout;
                      return e.target.value === '' ? next : { ...next, timeout: e.target.value };
                    }),
                  )
                }
              />
              {issueAt(`checks.${i}.name`)}
              {issueAt(`checks.${i}.cmd`)}
              {issueAt(`checks.${i}.timeout`)}
            </div>
            <ItemActions
              what="check"
              i={i}
              n={checks.length}
              onMove={(j) => {
                onReordered?.();
                setChecks(swap(checks, i, j));
              }}
              onRemove={() => {
                onReordered?.();
                setChecks(checks.filter((_, j) => j !== i));
              }}
            />
          </li>
        ))}
      </ol>
      {issueAt('checks')}
      <div>
        <button
          type="button"
          disabled={checks.length >= MAX_CHECKS}
          onClick={() => {
            onAdded?.(checks.length);
            setChecks([...checks, { name: '', cmd: '' }]);
            focusNew(checks.length);
          }}
        >
          Add check
        </button>
      </div>
      {checks.length > 0 && (
        <div className="wf-setup">
          <label htmlFor={`${uid}-setup`}>{setupLabel}</label>
          <select
            id={`${uid}-setup`}
            value={setupMode}
            onChange={(e) => {
              const mode = e.target.value;
              setCustomSetup(mode === 'custom');
              if (mode === 'auto') setSetup(undefined);
              else if (mode === 'none') setSetup('');
              else setSetup(setup ?? '');
            }}
          >
            <option value="auto">Auto-detect (npm ci / npm install)</option>
            <option value="none">None</option>
            <option value="custom">Custom command</option>
          </select>
          {setupMode === 'custom' && (
            <input
              aria-label="Setup command"
              className="mono"
              value={setup ?? ''}
              placeholder="e.g. pnpm install --frozen-lockfile"
              onChange={(e) => setSetup(e.target.value)}
            />
          )}
          {issueAt('setup')}
        </div>
      )}
    </>
  );
}

/** Move up, move down and remove buttons of one item in a list. */
export function ItemActions({
  what,
  i,
  n,
  onMove,
  onRemove,
}: {
  what: string;
  i: number;
  n: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="wf-item-actions">
      <button
        type="button"
        aria-label={`Move ${what} ${i + 1} up`}
        disabled={i === 0}
        onClick={() => onMove(i - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`Move ${what} ${i + 1} down`}
        disabled={i === n - 1}
        onClick={() => onMove(i + 1)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label={`Remove ${what} ${i + 1}`}
        className="danger"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

export function swap<T>(list: T[], i: number, j: number): T[] {
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
