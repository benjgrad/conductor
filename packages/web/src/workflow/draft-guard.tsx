import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { NavigateOptions, Route, RouteGuard } from '../nav.js';

// Keeps an unsaved workflow draft from being dropped by navigation (the Board, a hash change). The
// Workflows view reports which workflow has a dirty draft; leaving it is blocked and the user
// confirms in a modal dialog (UXR-69 FR-3; no browser dialogs).

export interface DraftGuard {
  guard: RouteGuard;
  onBlocked: (next: Route) => void;
  /** The view reports the workflow id with a dirty draft (null = clean). */
  setDirty: (workflowId: string | null) => void;
  dirty: string | null;
  pending: Route | null;
  cancel: () => void;
}

export function useDraftGuard(): DraftGuard {
  const [dirty, setDirty] = useState<string | null>(null);
  const [pending, setPending] = useState<Route | null>(null);
  const guard = useCallback<RouteGuard>(
    (next, current) => {
      if (dirty === null) return 'allow';
      // There is one workflow (ADR-0010): any workflows URL is the same view, draft and all.
      if (next.view === 'workflows' && current.view === 'workflows') return 'allow';
      return 'block';
    },
    [dirty],
  );
  const cancel = useCallback(() => setPending(null), []);
  return { guard, onBlocked: setPending, setDirty, dirty, pending, cancel };
}

export function DiscardDraftConfirm({
  draft,
  navigate,
}: {
  draft: DraftGuard;
  navigate: (route: Route, opts?: NavigateOptions) => void;
}) {
  const { pending, dirty } = draft;
  if (!pending || dirty === null) return null;
  return <LeaveDialog draft={draft} pending={pending} navigate={navigate} />;
}

function LeaveDialog({
  draft,
  pending,
  navigate,
}: {
  draft: DraftGuard;
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
        <p id={`${id}-text`}>Your changes to the workflow aren’t saved.</p>
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
