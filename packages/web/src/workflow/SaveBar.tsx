import type { WorkflowDefinition } from '@conductor/shared';
import { useId, useRef, type KeyboardEvent } from 'react';
import { useElementHeightVar } from '../components/useMediaQuery.js';
import { columnTitle, type ColumnIssue } from './columns.js';

// UXR-69 FR-1: while a draft exists, a bar sticks to the bottom of the page: "Unsaved changes ·
// N problems ▾ · Discard · Save as vN…" (Save opens the review first, UXR-70). The problems open as a list above the bar, so the diagram
// never moves; each one's Show opens its column or transition. FR-4: an old version's warning
// is repeated here.

export interface SaveBarProps {
  definition: WorkflowDefinition;
  /** The problems to show (still-new items' are held back). */
  issues: ColumnIssue[];
  /** The version a save creates. */
  nextVersion: number;
  /** oldVersionWarning, when the draft starts from an old version. */
  warning: string | null;
  saving: boolean;
  problemsOpen: boolean;
  onProblemsOpen: (open: boolean) => void;
  /** Show buttons only where the issue can be opened (a columns definition). */
  canShow: boolean;
  onShow: (issue: ColumnIssue) => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function SaveBar({
  definition,
  issues,
  nextVersion,
  warning,
  saving,
  problemsOpen,
  onProblemsOpen,
  canShow,
  onShow,
  onDiscard,
  onSave,
}: SaveBarProps) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // The editor panels leave room for the bar (workflow.css).
  useElementHeightVar(bar, '--wf-savebar-h');
  const open = problemsOpen && issues.length > 0;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      onProblemsOpen(false);
      toggle.current?.focus();
    }
  }

  return (
    <div ref={bar} className="wf-savebar" role="region" aria-label="Save" onKeyDown={onKeyDown}>
      {open && (
        <ul id={`${id}-problems`} className="wf-errors wf-problems-popover" aria-label="Problems">
          {issues.map((i, n) => (
            <li key={n}>
              {i.state !== null ? (
                <>
                  <strong>
                    {columnTitle(definition, i.state)}
                    {i.transition ? ` · ${i.transition.name}` : ''}
                  </strong>
                  : {i.message}
                  {canShow && (
                    <button
                      type="button"
                      onClick={() => {
                        onShow(i);
                        onProblemsOpen(false);
                      }}
                    >
                      Show
                    </button>
                  )}
                </>
              ) : (
                <>
                  <code>{i.path}</code>: {i.message}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="wf-unsaved">Unsaved changes</span>
      {warning !== null && (
        <span className="wf-version-warning" role="note">
          {warning}
        </span>
      )}
      {issues.length > 0 && (
        <button
          ref={toggle}
          type="button"
          className="wf-problems-toggle"
          aria-expanded={open}
          aria-controls={`${id}-problems`}
          onClick={() => onProblemsOpen(!open)}
        >
          {issues.length} {issues.length === 1 ? 'problem' : 'problems'} {open ? '▴' : '▾'}
        </button>
      )}
      <span className="wf-savebar-actions">
        <button type="button" onClick={onDiscard} disabled={saving}>
          Discard
        </button>
        <button type="button" className="wf-save primary" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : `Save as v${nextVersion}…`}
        </button>
      </span>
    </div>
  );
}
