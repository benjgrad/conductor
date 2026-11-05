import { WORKFLOW_NOTE_MAX } from '@conductor/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { ModalDialog } from '../components/ModalDialog.js';
import type { ReadableChange } from './version-diff.js';
import { VersionDiff } from './VersionDiff.js';

// UXR-70 (FR-3): Save opens this review first: what the save changes from the latest version, in
// the editor's words, and an optional note for the version history. Nothing is saved until
// "Save as vN"; Cancel or Escape keeps the draft. A ModalDialog (UXR-51): backdrop, focus kept
// inside, Esc closes it.

export interface SaveReviewDialogProps {
  /** The latest version (the diff is from it); null while it loads. */
  latest: number | null;
  /** The changes from the latest version; null while they load. */
  changes: readonly ReadableChange[] | null;
  /** The latest version could not be read. */
  error?: string | null;
  saving: boolean;
  onSave: (note: string) => void;
  onCancel: () => void;
}

export function SaveReviewDialog({
  latest,
  changes,
  error,
  saving,
  onSave,
  onCancel,
}: SaveReviewDialogProps) {
  const [note, setNote] = useState('');
  const titleId = useId();
  const noteId = useId();
  const noteField = useRef<HTMLTextAreaElement>(null);

  // The note, not the first control in the diff, takes focus on open.
  useEffect(() => {
    noteField.current?.focus();
  }, []);

  const next = latest === null ? null : latest + 1;
  const nothing = changes !== null && changes.length === 0;
  return (
    <ModalDialog
      className="modal wf-review-dialog"
      labelledBy={titleId}
      onClose={() => {
        if (!saving) onCancel();
      }}
    >
      <h3 id={titleId}>Review changes before saving</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {changes === null && !error && <p className="muted">Loading the latest version…</p>}
      {changes !== null && latest !== null && (
        <>
          <p className="muted">
            Changes from v{latest}. Running tickets keep the version they started on; new tickets
            and reopened ones use v{next}.
          </p>
          <VersionDiff
            changes={changes}
            label={`Changes from v${latest}`}
            empty={`Nothing changed from v${latest}.`}
          />
        </>
      )}
      <label htmlFor={noteId} className="wf-review-note">
        Note (optional)
      </label>
      <textarea
        ref={noteField}
        id={noteId}
        value={note}
        maxLength={WORKFLOW_NOTE_MAX}
        placeholder="What changed and why, for the version history"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="wf-review-actions">
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onSave(note)}
          disabled={saving || changes === null || nothing || next === null}
        >
          {saving ? 'Saving…' : `Save as v${next ?? '…'}`}
        </button>
      </div>
    </ModalDialog>
  );
}
