import type { ReactNode } from 'react';
import type { ReadableChange } from './version-diff.js';

// UXR-70 / UXR-73: a readable diff (version-diff.ts) as a list: one item per column, transition
// or setting, its Added / Removed / Changed badge, and its changes in the editor's words. Shared
// by Compare, the Save review dialog and the advisor's proposals.

const OP_LABEL: Record<ReadableChange['op'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

/** `**bold**` and `` `code` `` in a diff line, as elements (nothing else is markup). */
export function richText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export interface VersionDiffProps {
  changes: readonly ReadableChange[];
  /** Accessible name of the list. */
  label: string;
  /** Shown when there are no changes. */
  empty?: string;
  /** A "Show" button per column or transition (selects it in the editor). */
  onShow?: (change: ReadableChange) => void;
}

export function VersionDiff({ changes, label, empty = 'No changes.', onShow }: VersionDiffProps) {
  if (changes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="wf-diff" aria-label={label}>
      {changes.map((c, i) => (
        <li
          key={`${c.scope}:${c.state ?? ''}:${c.transition ?? ''}:${i}`}
          className={`wf-diff-item wf-diff-${c.op}`}
        >
          <div className="wf-diff-head">
            <span className="wf-diff-op">{OP_LABEL[c.op]}</span>
            <strong>{c.title}</strong>
            {onShow && c.op !== 'removed' && c.state !== undefined && (
              <button type="button" onClick={() => onShow(c)}>
                Show
              </button>
            )}
          </div>
          {c.lines.length > 0 && (
            <ul className="wf-diff-lines">
              {c.lines.map((l, n) => (
                <li key={n}>{richText(l)}</li>
              ))}
            </ul>
          )}
          {(c.before !== undefined || c.after !== undefined) && (
            <dl className="wf-diff-sentences">
              {c.before !== undefined && (
                <>
                  <dt>{c.after !== undefined ? 'Before' : 'Was'}</dt>
                  <dd>{richText(c.before)}</dd>
                </>
              )}
              {c.after !== undefined && (
                <>
                  <dt>{c.before !== undefined ? 'After' : 'Now'}</dt>
                  <dd>{richText(c.after)}</dd>
                </>
              )}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}
