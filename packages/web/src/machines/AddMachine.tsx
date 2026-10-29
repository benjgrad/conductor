import type { EnrollmentTokenCreated } from '@conductor/shared';
import { useState } from 'react';
import { guessOs } from '../onboarding/content.js';
import { OsTabs } from '../onboarding/OsTabs.js';
import { CopyCommand as Command } from './CopyCommand.js';
import { useCountdown } from './countdown.js';
import { countdown, serviceCommand, SETUP_GUIDE_URL } from './format.js';

interface AddMachineProps {
  enrollment: EnrollmentTokenCreated;
  onClose: () => void;
}

type Platform = 'unix' | 'windows';

const PLATFORM_TABS: readonly { key: Platform; label: string }[] = [
  { key: 'unix', label: 'macOS or Linux' },
  { key: 'windows', label: 'Windows' },
];

/**
 * The install command from POST /api/machines/enrollment-tokens, shown once (ADR-0013
 * §Enrollment): the token is only ever in that response. The page keeps it in state only while
 * this is open; Close drops it. The commands are shown verbatim, whatever form the server uses;
 * the Windows tab (MW-T11) only when the server sends `command_windows`.
 */
export function AddMachine({ enrollment, onClose }: AddMachineProps) {
  const left = useCountdown(enrollment.expires_at);
  const expired = left <= 0;
  const service = serviceCommand(enrollment.command);
  const windowsCommand = enrollment.command_windows ?? null;
  const [platform, setPlatform] = useState<Platform>(() =>
    windowsCommand !== null && guessOs() === 'windows' ? 'windows' : 'unix',
  );

  const unix = (
    <>
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
    </>
  );

  return (
    <div className="machine-panel" role="dialog" aria-label="Add a machine">
      <h3>Add a machine</h3>
      {windowsCommand === null ? (
        unix
      ) : (
        <OsTabs
          label="Operating system"
          idPrefix="add-machine"
          tabs={PLATFORM_TABS}
          value={platform}
          onChange={setPlatform}
        >
          {platform === 'unix' ? (
            unix
          ) : (
            <>
              <p>
                Run this in PowerShell on the computer. It's shown once, works once, and expires in
                30 minutes. Then start the daemon in the same window with{' '}
                <code>conductor-daemon</code>.
              </p>
              <Command label="Install command" command={windowsCommand} disabled={expired} />
            </>
          )}
        </OsTabs>
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
