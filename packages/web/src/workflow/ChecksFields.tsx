import type { EntryCheck } from '@conductor/shared';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { BasePreviewRow } from './BasePreview.js';

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
    for (const f of ['name', 'cmd', 'timeout', 'paths']) out.add(`checks.${i}.${f}`);
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

/** Focus moved out of the element the handler is on, to somewhere outside it. */
export const leftItem = (e: FocusEvent<HTMLElement>) =>
  !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget));

/**
 * Focus the first `selector` field of a just-added item: put `list` on the list, `data-item={i}`
 * on each item, and call `focusNew(i)` when adding item i.
 */
export function useFocusNew<T extends HTMLElement>(selector: string) {
  const list = useRef<T>(null);
  const pending = useRef<number | null>(null);
  // After every render: the item asked for has rendered by the commit that follows the add.
  useEffect(() => {
    if (pending.current === null) return;
    const field = list.current?.querySelector<HTMLElement>(
      `[data-item="${pending.current}"] ${selector}`,
    );
    if (!field) return;
    pending.current = null;
    field.focus();
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
  setupLabel = 'Setup: runs first, in a fresh checkout of the commit',
  onAdded,
  onItemBlur,
  onReordered,
}: ChecksFieldsProps) {
  const uid = useId();
  const { list, focusNew } = useFocusNew<HTMLTableSectionElement>('input');
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
  const setupField = checks.length > 0 && (
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
  );
  const setAt = (i: number, next: EntryCheck) =>
    setChecks(checks.map((x, j) => (j === i ? next : x)));
  return (
    <>
      {/* UXR-61: the setup runs first, so it is listed first. */}
      {setupField}
      {checks.length > 0 && (
        <div className="wf-checks-scroll">
          <table className="wf-checks" aria-label="Checks">
            <thead>
              <tr>
                <th scope="col" className="wf-checks-name">
                  Name
                </th>
                <th scope="col">Command</th>
                <th scope="col" className="wf-checks-timeout">
                  Timeout
                </th>
                <th scope="col" className="wf-checks-order">
                  <span className="visually-hidden">Order</span>
                </th>
              </tr>
            </thead>
            <tbody ref={list}>
              {checks.map((c, i) => {
                // A row's problems span the row under it (each names its column, FR-5).
                // R3: a paths problem shows under the paths field instead.
                const problems = ['name', 'cmd', 'timeout'].flatMap((f) =>
                  issues.some((x) => x.suffix === `checks.${i}.${f}`) ? [f] : [],
                );
                return (
                  <Fragment key={i}>
                    <tr
                      data-item={i}
                      onBlur={(e) => {
                        if (leftItem(e)) onItemBlur?.(i);
                      }}
                    >
                      <td>
                        <input
                          aria-label={`Check ${i + 1} name`}
                          value={c.name}
                          placeholder="e.g. Tests pass"
                          onChange={(e) => setAt(i, { ...c, name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Check ${i + 1} command`}
                          className="mono"
                          value={c.cmd}
                          placeholder="e.g. npm test"
                          onChange={(e) => setAt(i, { ...c, cmd: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Check ${i + 1} timeout`}
                          className="mono"
                          value={c.timeout ?? ''}
                          placeholder="default"
                          onChange={(e) => {
                            const next = { ...c };
                            delete next.timeout;
                            setAt(
                              i,
                              e.target.value === '' ? next : { ...next, timeout: e.target.value },
                            );
                          }}
                        />
                      </td>
                      <td>
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
                      </td>
                    </tr>
                    <BasePreviewRow text={c.cmd} colSpan={4} />
                    {problems.length > 0 && (
                      <tr className="wf-checks-problems">
                        <td colSpan={4}>
                          {problems.map((f) => (
                            <Fragment key={f}>{issueAt(`checks.${i}.${f}`)}</Fragment>
                          ))}
                        </td>
                      </tr>
                    )}
                    <tr className="wf-checks-paths">
                      <td colSpan={4}>
                        <PathsInput
                          i={i}
                          paths={c.paths}
                          onChange={(paths) => {
                            const next = { ...c };
                            delete next.paths;
                            setAt(i, paths.length === 0 ? next : { ...next, paths });
                          }}
                        />
                        {issueAt(`checks.${i}.paths`)}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
    </>
  );
}

/** R3: a check's `paths` as typed: globs separated by commas or new lines, blanks dropped. */
export function parsePaths(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter((g) => g !== '');
}

/**
 * R3: "Only when these change": the check's path globs. Empty = always run. The text is kept as
 * typed (a trailing comma stays while typing) and re-read when the check's paths change elsewhere.
 */
function PathsInput({
  i,
  paths,
  onChange,
}: {
  i: number;
  paths: readonly string[] | undefined;
  onChange: (paths: string[]) => void;
}) {
  const joined = (paths ?? []).join(', ');
  const [text, setText] = useState(joined);
  // The paths changed elsewhere (a reorder, a reset): show them.
  if (parsePaths(text).join('\u0000') !== (paths ?? []).join('\u0000')) setText(joined);
  return (
    <label className="wf-checks-paths-field">
      <span className="muted">Only when these change</span>
      <input
        aria-label={`Check ${i + 1} paths`}
        className="mono"
        value={text}
        placeholder="any file (e.g. crates/**, Cargo.*)"
        onChange={(e) => {
          setText(e.target.value);
          onChange(parsePaths(e.target.value));
        }}
      />
    </label>
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
