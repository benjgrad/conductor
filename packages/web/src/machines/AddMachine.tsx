import type { EnrollmentTokenCreated } from '@conductor/shared';
import { useEffect, useState } from 'react';
import { countdown, serviceCommand, SETUP_GUIDE_URL } from './format.js';

interface AddMachineProps {
  enrollment: EnrollmentTokenCreated;
  onClose: () => void;
}

/**
 * The install command from POST /api/machines/enrollment-tokens, shown once (ADR-0013
 * §Enrollment): the token is only ever in that response. The page keeps it in state only while
 * this is open; Close drops it. The command is shown verbatim, whatever form the server uses.
 */
export function AddMachine({ enrollment, onClose }: AddMachineProps) {
  const expiresAt = Date.parse(enrollment.expires_at);
  const [left, setLeft] = useState(() => expiresAt - Date.now());
  const expired = left <= 0;

  useEffect(() => {
    if (expired) return;
    const timer = setInterval(() => setLeft(expiresAt - Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, expired]);

  return (
    <div className="machine-panel" role="dialog" aria-label="Add a machine">
      <h3>Add a machine</h3>
      <p>
        Run this in a terminal on the computer. It's shown once, works once, and expires in 30
        minutes.
      </p>
      <Command label="Install command" command={enrollment.command} disabled={expired} />
      <p>To also start the daemon at login, use this instead:</p>
      <Command
        label="Install command (start at login)"
        command={serviceCommand(enrollment.command)}
        disabled={expired}
      />
      {expired ? (
        <p role="alert" className="error">
          This command has expired. Close and add a machine again.
        </p>
      ) : (
        <p className="add-machine-expiry">
          Expires in <span aria-label="Time left">{countdown(left)}</span>
        </p>
      )}
      <p>
        <a href={SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
          Setup guide: add a machine ↗
        </a>
      </p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function Command({
  label,
  command,
  disabled,
}: {
  label: string;
  command: string;
  disabled: boolean;
}) {
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
      </div>
      {copied === 'failed' && (
        <p className="error">Couldn't copy. Select the command and copy it.</p>
      )}
    </>
  );
}
