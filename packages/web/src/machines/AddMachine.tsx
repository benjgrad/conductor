import type { EnrollmentTokenCreated } from '@conductor/shared';
import { CopyCommand as Command } from './CopyCommand.js';
import { useCountdown } from './countdown.js';
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
  const left = useCountdown(enrollment.expires_at);
  const expired = left <= 0;
  const service = serviceCommand(enrollment.command);

  return (
    <div className="machine-panel" role="dialog" aria-label="Add a machine">
      <h3>Add a machine</h3>
      <p>
        Run this in a terminal on the computer. It's shown once, works once, and expires in 30
        minutes.
      </p>
      <Command label="Install command" command={enrollment.command} disabled={expired} />
      {service !== null && (
        <>
          <p>To also start the daemon at login, use this instead:</p>
          <Command label="Install command (start at login)" command={service} disabled={expired} />
        </>
      )}
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
