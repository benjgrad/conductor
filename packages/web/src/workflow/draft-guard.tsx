import { useCallback, useState } from 'react';
import type { NavigateOptions, Route, RouteGuard } from '../nav.js';

// Keeps an unsaved draft from being dropped by navigation (the Board, a hash change): the workflow
// editor's, or a repo's checks on the Repo checks page (UXR-81). The view reports what has a dirty
// draft; leaving it is blocked and the user confirms inline (no browser dialogs).

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

export function draftQuestion(dirty: DirtyDraft): string {
  return dirty.kind === 'workflow'
    ? 'Discard unsaved changes to the workflow?'
    : `Discard unsaved changes to ${dirty.repo}’s checks?`;
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
      <span>{draftQuestion(dirty)}</span>
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
