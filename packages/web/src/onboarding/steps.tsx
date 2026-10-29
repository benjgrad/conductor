import type { EnrollmentTokenCreated, MachineDetail } from '@conductor/shared';
import { useEffect, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { CopyCommand } from '../machines/CopyCommand.js';
import { useCountdown } from '../machines/countdown.js';
import {
  countdown,
  ghTooOld,
  ghTooOldText,
  SERVICE_INSTALL_AVAILABLE,
  serviceCommand,
  shortRepo,
} from '../machines/format.js';
import { routeHash } from '../nav.js';
import {
  DAEMON_COMMANDS,
  GH_INSTALL_URL,
  OS_LABELS,
  OSES,
  PREREQUISITES,
  type Os,
} from './content.js';
import { OsTabs } from './OsTabs.js';

// UX-8: the setup guide's five steps (SetupGuide.tsx holds the state they share).

/** How often step 3 asks for the account's machines (there is no machine event on the stream). */
export const POLL_MS = 3000;
/** How often step 4 re-reads the machine's inventory. */
export const INVENTORY_POLL_MS = 5000;
/** After this long without a machine, step 3 shows troubleshooting. */
export const TROUBLESHOOT_AFTER_MS = 2 * 60_000;

const OS_TABS = OSES.map((key) => ({ key, label: OS_LABELS[key] }));

/** The guide's OS choice, made once in SetupGuide and changeable from steps 1 and 2. */
interface OsChoice {
  os: Os;
  onOs: (os: Os) => void;
}

/** FR-2: what the computer needs, with install and check commands per OS. */
export function Prerequisites({ os, onOs }: OsChoice) {
  return (
    <>
      <p>Install anything missing, then run each check in a terminal on the computer.</p>
      <OsTabs label="Operating system" idPrefix="setup" tabs={OS_TABS} value={os} onChange={onOs}>
        {os === 'windows' && <p>Run every command in PowerShell.</p>}
        <ul className="setup-checklist">
          {PREREQUISITES.map((p) => (
            <li key={p.id}>
              <h4>{p.title}</h4>
              <p className="muted">{p.why}</p>
              {p.id === 'gh' && os === 'linux' && (
                <p>
                  Install it as shown on{' '}
                  <a href={GH_INSTALL_URL} target="_blank" rel="noreferrer">
                    the GitHub CLI install page ↗
                  </a>
                  , then sign in.
                </p>
              )}
              {p.install[os].map((c) => (
                <CopyCommand key={c.label} label={c.label} command={c.command} />
              ))}
              {p.then && <p>{p.then}</p>}
              <p className="setup-verify">Check:</p>
              {p.verify.map((c) => (
                <CopyCommand key={c.label} label={c.label} command={c.command} />
              ))}
            </li>
          ))}
        </ul>
      </OsTabs>
    </>
  );
}

/** FR-3: the one-time install command, what it does, and how to start the daemon. */
export function Install({
  api,
  enrollment,
  onEnrollment,
  os,
  onOs,
}: {
  api: ApiClient;
  enrollment: EnrollmentTokenCreated | null;
  onEnrollment: (e: EnrollmentTokenCreated) => void;
} & OsChoice) {
  const windows = os === 'windows';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      onEnrollment(await api.createEnrollmentToken());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        Generate a one-time command and run it in a terminal on the computer
        {windows ? ' (PowerShell)' : ''}. It's shown once, works once, and expires in 30 minutes.
      </p>
      <OsTabs
        label="Operating system"
        idPrefix="setup-install"
        tabs={OS_TABS}
        value={os}
        onChange={onOs}
      >
        <button type="button" onClick={() => void generate()} disabled={busy}>
          {enrollment ? 'Generate a new command' : 'Generate install command'}
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {enrollment && <OneTimeCommand key={enrollment.token} enrollment={enrollment} os={os} />}

        <h4>What the installer does</h4>
        <ul>
          <li>Downloads the daemon and checks its fingerprint (SHA-256) before installing it.</li>
          {windows ? (
            <li>
              Installs it in .conductor in your user folder and adds it to your PATH. No
              administrator rights, nothing outside your user folder.
            </li>
          ) : (
            <li>Installs it in ~/.conductor. No sudo, nothing outside your home folder.</li>
          )}
          <li>Enrolls the computer: connects it to your conductor account.</li>
        </ul>
        <p className="muted">
          It installs none of the prerequisites; if one is missing, it says which and stops.
        </p>

        <h4>Start the daemon</h4>
        <p>
          When the installer finishes, start the daemon
          {windows ? ' in the same PowerShell window' : ''} and keep that terminal open:
        </p>
        <CopyCommand label="Start the daemon" command={DAEMON_COMMANDS[os].start} />
        <p className="muted">Stop it with Ctrl-C.</p>
      </OsTabs>
    </>
  );
}

function OneTimeCommand({ enrollment, os }: { enrollment: EnrollmentTokenCreated; os: Os }) {
  const left = useCountdown(enrollment.expires_at);
  const expired = left <= 0;
  const windows = os === 'windows';
  // A server from before MW-T11 sends no Windows command.
  const command = windows ? (enrollment.command_windows ?? null) : enrollment.command;
  const service = SERVICE_INSTALL_AVAILABLE && !windows ? serviceCommand(enrollment.command) : null;
  if (command === null) {
    return (
      <p role="alert" className="error">
        This conductor server has no Windows installer yet.
      </p>
    );
  }
  return (
    <div className="machine-panel">
      <CopyCommand label="Install command" command={command} disabled={expired} />
      {expired ? (
        <p role="alert" className="error">
          This command has expired. Generate a new one.
        </p>
      ) : (
        <p className="add-machine-expiry">
          Expires in <span aria-label="Time left">{countdown(left)}</span>
        </p>
      )}
      {service !== null ? (
        <>
          <p>To also start the daemon at login, use this instead:</p>
          <CopyCommand
            label="Install command (start at login)"
            command={service}
            disabled={expired}
          />
        </>
      ) : (
        <p className="muted">
          Starting the daemon automatically at login is coming soon. For now, start it in a terminal
          as shown below.
        </p>
      )}
    </div>
  );
}

/**
 * FR-4: wait for a machine that wasn't online when the guide opened to come online;
 * troubleshooting after 2 minutes.
 */
export function WaitForMachine({
  api,
  baseline,
  machine,
  onFound,
  onNewCommand,
  os,
}: {
  api: ApiClient;
  baseline: ReadonlySet<string> | null;
  machine: MachineDetail | null;
  onFound: (m: MachineDetail) => void;
  onNewCommand: () => void;
  os: Os;
}) {
  const [slow, setSlow] = useState(false);
  const found = machine !== null;

  useEffect(() => {
    if (found || baseline === null) return;
    let cancelled = false;
    let busy = false;
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        const rows = await api.listMachines();
        const row = rows.find(
          (r) => !baseline!.has(r.id) && r.revoked_at === null && r.status === 'online',
        );
        if (row && !cancelled) {
          const detail = await api.getMachine(row.id);
          if (!cancelled) onFound(detail);
        }
      } catch {
        // Keep polling; a blip shouldn't end the wait.
      } finally {
        busy = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, baseline, found, onFound]);

  useEffect(() => {
    if (found) return;
    const timer = setTimeout(() => setSlow(true), TROUBLESHOOT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [found]);

  if (machine) {
    return (
      <div className="setup-success" role="status">
        <p>
          <b>✓ {machine.name} is online.</b>
        </p>
        <p>
          {[
            machine.os && `${machine.os}${machine.arch ? `/${machine.arch}` : ''}`,
            machine.daemon_version && `daemon ${machine.daemon_version}`,
            machine.claude_version && `Claude Code ${machine.claude_version}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="setup-waiting" role="status">
        <span className="setup-spinner" aria-hidden="true" /> Waiting for your machine to connect…
      </p>
      <p className="muted">This page notices it by itself a few seconds after the daemon starts.</p>
      {slow && (
        <section aria-labelledby="setup-troubleshooting">
          <h4 id="setup-troubleshooting">Troubleshooting</h4>
          <ul>
            <li>
              <b>Is the daemon running?</b> Look at the terminal where you started it. If you closed
              it, start <code>{DAEMON_COMMANDS[os].start}</code> again.
            </li>
            <li>
              <b>Is Node.js 22 on the PATH?</b> Run <code>node -v</code> in that same terminal; it
              must print v22 or higher (with nvm, run <code>nvm use 22</code> first).
            </li>
            <li>
              <b>Did the command expire, or was it already used?</b> Enrollment fails then.{' '}
              <button type="button" className="link" onClick={onNewCommand}>
                Generate a new command
              </button>{' '}
              and run it again.
            </li>
            <li>
              <b>Behind a company proxy or firewall?</b> The daemon needs an outgoing WebSocket
              connection (wss) to <code>{window.location.host}</code>. Ask your IT team to allow it.
            </li>
            <li>
              <b>Reading the daemon's output:</b> it prints its errors in the terminal it runs in.
              Copy the last lines if you ask for help.
            </li>
          </ul>
        </section>
      )}
    </>
  );
}

/** FR-5: repo roots, then what the machine reported, with the gh checks pull requests need. */
export function RepoCaps({
  api,
  machine,
  onMachine,
  onConnect,
  os,
}: {
  api: ApiClient;
  machine: MachineDetail | null;
  onMachine: (m: MachineDetail) => void;
  onConnect: () => void;
  os: Os;
}) {
  const id = machine?.id ?? null;
  const commands = DAEMON_COMMANDS[os];

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api.getMachine(id).then(
        (m) => {
          if (!cancelled) onMachine(m);
        },
        () => {},
      );
    }, INVENTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, id, onMachine]);

  return (
    <>
      <p>
        Tell the daemon which folders hold your repos (one or more). Run this on the computer, with
        your own folder:
      </p>
      <CopyCommand label="Set the repo roots" command={commands.roots} />
      <p>
        The daemon rescans every 10 minutes. To apply it now, restart the daemon: press Ctrl-C in
        its terminal, then start it again:
      </p>
      <CopyCommand label="Start the daemon again" command={commands.start} />
      {commands.rescan !== null && (
        <>
          <p>
            Or, without restarting, send it a hang-up signal. This signals only the conductor
            daemon:
          </p>
          <CopyCommand label="Rescan now" command={commands.rescan} />
        </>
      )}

      <h4>What your machine reported</h4>
      {machine === null ? (
        <p>
          Connect a machine first.{' '}
          <button type="button" className="link" onClick={onConnect}>
            Go to Connect
          </button>
        </p>
      ) : (
        <MachineReport machine={machine} />
      )}
    </>
  );
}

function MachineReport({ machine }: { machine: MachineDetail }) {
  const repos = machine.repos;
  return (
    <>
      <p className="muted">This updates by itself.</p>
      <section aria-label="Reported repos">
        <h5>{repos.length === 1 ? '1 repo' : `${repos.length} repos`}</h5>
        {repos.length === 0 ? (
          <p className="muted">No repos found yet. Set the repo roots above, then rescan.</p>
        ) : (
          <ul>
            {repos.map((r) => (
              <li key={r.path}>
                {r.remote ? (
                  shortRepo(r.remote)
                ) : (
                  <>
                    <code>{r.path}</code>{' '}
                    <span className="muted">(no remote: it can't take tickets)</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ul className="setup-checks" aria-label="Checks">
        <ClaudeCheck machine={machine} />
        <GhCheck machine={machine} />
      </ul>
    </>
  );
}

function ClaudeCheck({ machine }: { machine: MachineDetail }) {
  const version = machine.capabilities.claude[0]?.version ?? machine.claude_version;
  const ok = machine.capabilities.claude.length > 0 || machine.claude_version !== null;
  return ok ? (
    <li className="setup-check-ok">✓ Claude Code{version ? ` ${version}` : ''}</li>
  ) : (
    <li className="setup-check-bad">
      ✗ Claude Code wasn't found. Install it and sign in (step 1), then restart the daemon.
    </li>
  );
}

function GhCheck({ machine }: { machine: MachineDetail }) {
  const gh = machine.capabilities.cli.find((c) => c.name === 'gh');
  const mac = machine.os === 'darwin';
  if (!gh) {
    return (
      <li className="setup-check-bad">
        <p className="machine-warning">
          ✗ The GitHub CLI (gh) isn't installed. Pull requests won't work until it is.
        </p>
        {mac ? (
          <CopyCommand label="Install the GitHub CLI" command="brew install gh" />
        ) : (
          <p>
            Install it as shown on{' '}
            <a href={GH_INSTALL_URL} target="_blank" rel="noreferrer">
              the GitHub CLI install page ↗
            </a>
            , then sign in with <code>gh auth login</code>.
          </p>
        )}
      </li>
    );
  }
  const old = ghTooOld(machine.capabilities);
  if (old !== null) {
    return (
      <li className="setup-check-bad">
        <p className="machine-warning">
          ⚠ {ghTooOldText(old)}. Pull requests won't work until you upgrade it.
        </p>
        {mac ? (
          <CopyCommand label="Upgrade the GitHub CLI" command="brew upgrade gh" />
        ) : (
          <p>
            Upgrade it as shown on{' '}
            <a href={GH_INSTALL_URL} target="_blank" rel="noreferrer">
              the GitHub CLI install page ↗
            </a>
            .
          </p>
        )}
      </li>
    );
  }
  if (gh.authed === false) {
    return (
      <li className="setup-check-bad">
        <p className="machine-warning">
          ✗ gh isn't signed in. Pull requests won't work until you sign in on this machine:
        </p>
        <CopyCommand label="Sign in to GitHub" command="gh auth login" />
      </li>
    );
  }
  return (
    <li className="setup-check-ok">
      ✓ gh{gh.version ? ` ${gh.version}` : ''}
      {gh.authed ? ', signed in' : ''}
    </li>
  );
}

/** FR-6. */
export function Done({
  onCreateTicket,
  onFinish,
}: {
  onCreateTicket: () => void;
  onFinish: () => void;
}) {
  return (
    <>
      <p className="setup-success">
        <b>Your machine is ready.</b> Tickets you create now run on it.
      </p>
      <div className="setup-nav">
        <button type="button" className="primary" onClick={onCreateTicket}>
          Create your first ticket
        </button>
        <a href={routeHash({ view: 'machines' })} onClick={onFinish}>
          Go to Machines
        </a>
      </div>
    </>
  );
}
