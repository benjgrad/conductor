import { useState } from 'react';
import { useCopy } from '../components/use-copy.js';

interface CopyCommandProps {
  /** The input's accessible name; the button is "Copy <label>". */
  label: string;
  command: string;
  disabled?: boolean;
}

/**
 * A read-only command with a Copy button (M2-T11's install command box, shared with the setup
 * guide, UX-8). Success is the shared "Copied" toast (UXR-55); a failure says so here.
 */
export function CopyCommand({ label, command, disabled = false }: CopyCommandProps) {
  const [failed, setFailed] = useState(false);
  const copyText = useCopy();

  function copy() {
    void copyText(command).then((ok) => setFailed(!ok));
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
          Copy
        </button>
      </div>
      {failed && (
        <p className="error" role="alert">
          Couldn't copy. Select the command and copy it.
        </p>
      )}
    </>
  );
}
