import { useState, type FormEvent } from 'react';

/** RenameMachineRequest's limit (10-contracts). */
export const NAME_MAX = 64;

/** Inline rename of a machine (in its drawer). Escape cancels without closing the drawer. */
export function RenameForm({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  const ok = trimmed !== '' && trimmed.length <= NAME_MAX;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (ok) onSave(trimmed);
  }

  return (
    <form className="machine-rename" aria-label="Rename machine" onSubmit={onSubmit}>
      <input
        aria-label="Machine name"
        value={value}
        maxLength={NAME_MAX}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Leaves the form, not the sheet around it.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="submit" disabled={!ok}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
