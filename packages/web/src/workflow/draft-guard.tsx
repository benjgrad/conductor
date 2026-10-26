import { useCallback, useState } from 'react';
import type { NavigateOptions, Route, RouteGuard } from '../nav.js';

// Keeps an unsaved workflow draft from being dropped by navigation (the Board, a hash change). The Workflows view reports which workflow has a dirty draft; leaving it is
// blocked and the user confirms inline (no browser dialogs).

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
  return (
    <div className="wf-confirm" role="alertdialog" aria-label="Unsaved changes">
      <span>Discard unsaved changes to the workflow?</span>
      <button
        type="button"
        className="danger"
        onClick={() => {
          draft.setDirty(null);
          draft.cancel();
          navigate(pending, { force: true });
        }}
      >
        Discard
      </button>
      <button type="button" onClick={draft.cancel} autoFocus>
        Keep editing
      </button>
    </div>
  );
}
