import { useState } from 'react';

interface CopyCommandProps {
  /** The input's accessible name; the button is "Copy <label>". */
  label: string;
  command: string;
  disabled?: boolean;
}

/**
 * A read-only command with a Copy button (M2-T11's install command box, shared with the setup
 * guide, UX-8). The result is also announced through an aria-live region.
 */
export function CopyCommand({ label, command, disabled = false }: CopyCommandProps) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  function copy() {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      setCopied('failed');
      return;
    }
    clipboard.writeText(command).then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
  }

  return (
    <>
      <div className="machine-command">
        <input
          readOnly
          value={command}
          aria-label={label}
          disabled={disabled}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" onClick={copy} disabled={disabled} aria-label={`Copy ${label}`}>
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </button>
        <span className="visually-hidden" aria-live="polite">
          {copied === 'yes' ? `${label} copied to the clipboard` : ''}
        </span>
      </div>
      {copied === 'failed' && (
        <p className="error" role="alert">
          Couldn't copy. Select the command and copy it.
        </p>
      )}
    </>
  );
}
