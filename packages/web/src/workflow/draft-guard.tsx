import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { NavigateOptions, Route, RouteGuard } from '../nav.js';

// Keeps an unsaved draft from being dropped by navigation (the Board, a hash change): the workflow
// editor's, or a repo's checks on the Repo checks page (UXR-81). The view reports what has a dirty
// draft; leaving it is blocked and the user confirms in a modal dialog (UXR-69 FR-3; no browser
// dialogs).

/** What has unsaved changes. */
export type DirtyDraft = { kind: 'workflow'; id: string } | { kind: 'repo-checks'; repo: string };

export interface DraftGuard {
  guard: RouteGuard;
  onBlocked: (next: Route) => void;
  /** The view reports its dirty draft (null = clean). */
  setDirty: (dirty: DirtyDraft | null) => void;
  dirty: DirtyDraft | null;
  pending: Route | null;
  cancel: () => void;
}

/** Whether going to `next` keeps `dirty`'s draft on screen (else the guard blocks). */
export function keepsDraft(dirty: DirtyDraft, next: Route): boolean {
  // There is one workflow (ADR-0010): any workflows URL is the same view, draft and all.
  if (dirty.kind === 'workflow') return next.view === 'workflows';
  // Another repo, or the list on a phone, remounts the editor.
  return next.view === 'repo-checks' && next.repo === dirty.repo;
}

export function useDraftGuard(): DraftGuard {
  const [dirty, setDirtyState] = useState<DirtyDraft | null>(null);
  const [pending, setPending] = useState<Route | null>(null);
  const guard = useCallback<RouteGuard>(
    (next) => (dirty === null || keepsDraft(dirty, next) ? 'allow' : 'block'),
    [dirty],
  );
  const setDirty = useCallback((next: DirtyDraft | null) => {
    setDirtyState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  const cancel = useCallback(() => setPending(null), []);
  return { guard, onBlocked: setPending, setDirty, dirty, pending, cancel };
}

/** The leave dialog's sentence for what is unsaved. */
export function draftText(dirty: DirtyDraft): string {
  return dirty.kind === 'workflow'
    ? 'Your changes to the workflow aren’t saved.'
    : `Your changes to ${dirty.repo}’s checks aren’t saved.`;
}

export function DiscardDraftConfirm({
  draft,
  navigate,
}: {
  draft: DraftGuard;
  navigate: (route: Route, opts?: NavigateOptions) => void;
}) {
  const { pending, dirty, cancel } = draft;
  // A navigation blocked just before the view reported clean (a save's reload commits a render,
  // and the view's dirty report is a passive effect after it): nothing is unsaved any more, so go
  // where the user asked instead of dropping it with no dialog. Forced: the router's guard is
  // updated in the parent's effect, after this one, and would still see the old draft.
  useEffect(() => {
    if (pending === null || dirty !== null) return;
    cancel();
    navigate(pending, { force: true });
  }, [pending, dirty, cancel, navigate]);
  if (!pending || dirty === null) return null;
  return <LeaveDialog draft={draft} dirty={dirty} pending={pending} navigate={navigate} />;
}

function LeaveDialog({
  draft,
  dirty,
  pending,
  navigate,
}: {
  draft: DraftGuard;
  dirty: DirtyDraft;
  pending: Route;
  navigate: (route: Route, opts?: NavigateOptions) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  // Focus goes back where it was when the dialog closes (Keep editing).
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    keep.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      draft.cancel();
      return;
    }
    if (e.key !== 'Tab') return;
    // A two-button focus trap: Tab and Shift+Tab stay in the dialog.
    const buttons = [...(dialog.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[next]!.focus();
  }

  return (
    <div
      className="wf-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) draft.cancel();
      }}
    >
      <div
        ref={dialog}
        className="wf-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`}>Unsaved changes</h2>
        <p id={`${id}-text`}>{draftText(dirty)}</p>
        <div className="wf-modal-actions">
          <button
            type="button"
            className="danger"
            onClick={() => {
              draft.setDirty(null);
              draft.cancel();
              navigate(pending, { force: true });
            }}
          >
            Leave without saving
          </button>
          <button ref={keep} type="button" className="primary" onClick={draft.cancel}>
            Keep editing
          </button>
        </div>
      </div>
    </div>
  );
}
