import type { MachineDetail, MachineRow } from '@conductor/shared';
import { HelpLink } from '../help/HelpPage.js';
import { CopyCommand } from './CopyCommand.js';

// Manual daemon upgrade instructions. Stopgap until daemons update themselves (ADR-0021, MR-T14):
// delete this file, its two call sites (Machines.tsx, MachineDrawer.tsx) and
// `MachineRow.upgrade_command*` in MR-T18a.

/** Which upgrade commands to show for a machine's `os` (null = unknown: both). */
export function upgradeShells(os: string | null | undefined): { posix: boolean; windows: boolean } {
  if (!os) return { posix: true, windows: true };
  const windows = os.toLowerCase().startsWith('win');
  return { posix: !windows, windows };
}

const SERVICE_TIP = '~/.conductor/bin/conductor-daemon service install';
const LINGER_TIP = 'loginctl enable-linger "$USER"';

function AfterUpgrade() {
  return (
    <>
      <p>
        If the daemon runs as a service, it restarts on the new version by itself. Otherwise, or on
        Windows, restart <code>conductor-daemon</code> yourself.
      </p>
      <p className="muted">
        To start the daemon at login on macOS and Linux, run <code>{SERVICE_TIP}</code>. On a Linux
        server, also run <code>{LINGER_TIP}</code> so it keeps running while you are logged out.
      </p>
    </>
  );
}

interface UpgradeBannerProps {
  rows: readonly MachineRow[];
  details: ReadonlyMap<string, MachineDetail>;
}

/** The Machines page's banner: every unrevoked outdated machine and the command to run on each. */
export function UpgradeBanner({ rows, details }: UpgradeBannerProps) {
  const outdated = rows.filter((r) => r.revoked_at === null && r.upgrade_command !== null);
  if (outdated.length === 0) return null;
  const posix = outdated.find((r) => r.upgrade_command !== null)?.upgrade_command ?? null;
  const windows =
    outdated.find(
      (r) => r.upgrade_command_windows !== null && upgradeShells(details.get(r.id)?.os).windows,
    )?.upgrade_command_windows ?? null;
  const showPosix = outdated.some((r) => upgradeShells(details.get(r.id)?.os).posix);
  const names = outdated.map((r) => r.name).join(', ');
  return (
    <div className="machine-panel" role="region" aria-label="Daemon update available">
      <h3>Daemon update available</h3>
      <p>
        {outdated.length === 1
          ? `1 machine runs an older daemon: ${names}.`
          : `${outdated.length} machines run an older daemon: ${names}.`}{' '}
        Daemons don't update themselves yet. On each one, run:
      </p>
      {showPosix && posix !== null && <CopyCommand label="Upgrade command" command={posix} />}
      {windows !== null && (
        <CopyCommand label="Upgrade command (Windows PowerShell)" command={windows} />
      )}
      <AfterUpgrade />
      <HelpLink>Help: upgrade a machine</HelpLink>
    </div>
  );
}

/** The drawer's section for one outdated machine: the command for its OS. */
export function UpgradeSection({ machine }: { machine: MachineDetail }) {
  if (machine.revoked_at !== null || machine.upgrade_command === null) return null;
  const shells = upgradeShells(machine.os);
  return (
    <section aria-label="Update available">
      <h3>Update available</h3>
      <p>This machine runs an older daemon. Daemons don't update themselves yet: on it, run</p>
      {shells.posix && <CopyCommand label="Upgrade command" command={machine.upgrade_command} />}
      {shells.windows && machine.upgrade_command_windows !== null && (
        <CopyCommand
          label="Upgrade command (Windows PowerShell)"
          command={machine.upgrade_command_windows}
        />
      )}
      <AfterUpgrade />
    </section>
  );
}
