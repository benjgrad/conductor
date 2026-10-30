import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootDirFrom } from '../config.js';
import { serviceManager, type ServiceManager } from '../platform/index.js';

// launchd and systemd are POSIX-only, so unit paths and PATH are always `/` and `:` (also when the
// pure renderers run in the Windows test job).
const { delimiter } = posix;
const join = (...parts: string[]): string => posix.join(...parts);
const dirname = (p: string): string => posix.dirname(p);
const isAbsolute = (p: string): boolean => posix.isAbsolute(p);

// `conductor-daemon service install | uninstall | restart | status` (M2-T18; ADR-0017 §Daemon
// distribution, ADR-0021 §3/§5). Starts the daemon at login, as the user, never with sudo:
// - macOS: a launchd agent, ~/Library/LaunchAgents/com.conductor.daemon.plist, in gui/<uid>;
//   logs in <root>/logs/daemon.log.
// - Linux: a systemd user unit, ~/.config/systemd/user/conductor-daemon.service; logs in the journal.
// Both run <root>/bin/conductor-launch (assets/conductor-launch.sh; install.sh writes the same
// bytes), which execs <root>/daemon/current/bin/conductor-daemon run, so an upgrade takes effect on
// restart. They set CONDUCTOR_SUPERVISED, CONDUCTOR_ROOT, and pin Node: CONDUCTOR_NODE is an
// absolute Node 22+ resolved here (the tarball's shim runs it), PATH is the installing shell's PATH
// with that node's dir first (launchd's own PATH has no claude, gh or Homebrew).
// Exit codes (TD-119, 10-contracts §Daemon auto-update): 78 EXIT_FATAL_AUTH must not restart
// (systemd RestartPreventExitStatus; launchd can't exclude a status, so the daemon's fatal path
// boots its own job out, `stopSupervisedJob`, with ThrottleInterval as a floor); 75 and any other
// failure restart under both.

export const LAUNCHD_LABEL = 'com.conductor.daemon';
export const SYSTEMD_UNIT = 'conductor-daemon.service';
export const MIN_NODE_MAJOR = 22;

/** The launcher, shipped in the package (and so in the tarball's ./assets). */
export const LAUNCHER_ASSET = fileURLToPath(
  new URL('../../assets/conductor-launch.sh', import.meta.url),
);

export const SERVICE_USAGE = 'usage: conductor-daemon service install|uninstall|restart|status';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceDeps {
  /** launchd, systemd, or null where `service` isn't supported (win32). */
  manager: ServiceManager | null;
  home: string;
  uid: number;
  env: Record<string, string | undefined>;
  /** Run a tool (argv, no shell). */
  run: (file: string, args: string[]) => RunResult;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The node running this command. */
  execPath: string;
  /** True under WSL (the systemd note differs). */
  wsl: () => boolean;
}

/** `run` for `env`: spawnSync, argv only, no shell; a missing tool is status null. */
function spawnRunner(env: Record<string, string | undefined>): ServiceDeps['run'] {
  return (file, args) => {
    const r = spawnSync(file, args, { env, encoding: 'utf8' });
    return {
      status: r.error ? null : r.status,
      stdout: r.stdout ?? '',
      stderr: r.error ? r.error.message : (r.stderr ?? ''),
    };
  };
}

function defaultDeps(deps: Partial<ServiceDeps>): ServiceDeps {
  const env = deps.env ?? process.env;
  return {
    manager: serviceManager(),
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    env,
    run: spawnRunner(env),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`[conductor-daemon] ${l}\n`),
    execPath: process.execPath,
    wsl: () => {
      try {
        return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
      } catch {
        return false;
      }
    },
  };
}

export interface UnitInputs {
  root: string;
  /** Absolute Node 22+. */
  node: string;
  /** PATH for the daemon. */
  path: string;
  home: string;
}

function unitEnv(u: UnitInputs, supervisor: 'launchd' | 'systemd'): [string, string][] {
  return [
    ['CONDUCTOR_SUPERVISED', supervisor],
    ['CONDUCTOR_ROOT', u.root],
    ['CONDUCTOR_NODE', u.node],
    ['PATH', u.path],
  ];
}

const xml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function launcherPath(root: string): string {
  return join(root, 'bin', 'conductor-launch');
}

export function logPath(root: string): string {
  return join(root, 'logs', 'daemon.log');
}

/** The launchd agent. KeepAlive restarts any failed exit; ThrottleInterval spaces restarts. */
export function renderPlist(u: UnitInputs): string {
  const env = unitEnv(u, 'launchd')
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by conductor-daemon service install; re-run it rather than editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(launcherPath(u.root))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(u.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logPath(u.root))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath(u.root))}</string>
</dict>
</plist>
`;
}

/** A value systemd reads literally inside double quotes (`%` → `%%`); throws on what can't be. */
function systemdQuote(v: string): string {
  if (/["\\\n\r]/.test(v)) {
    throw new Error(`cannot write ${JSON.stringify(v)} into a systemd unit (", \\ or a newline)`);
  }
  return `"${v.replaceAll('%', '%%')}"`;
}

/** The systemd user unit. 78 (EXIT_FATAL_AUTH) never restarts; 75 and other failures do. */
export function renderSystemdUnit(u: UnitInputs): string {
  const env = unitEnv(u, 'systemd')
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join('\n');
  return `# Written by conductor-daemon service install; re-run it rather than editing this file.
[Unit]
Description=conductor daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(launcherPath(u.root))}
${env}
WorkingDirectory=%h
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

/**
 * The daemon's fatal-auth path (TD-119): under launchd, boot our own job out so KeepAlive doesn't
 * restart a revoked machine. It loads again at the next login. systemd needs nothing.
 */
export function stopSupervisedJob(
  env: Record<string, string | undefined> = process.env,
  uid: number = process.getuid?.() ?? -1,
  start: (file: string, args: string[]) => void = (file, args) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  },
): void {
  if (env.CONDUCTOR_SUPERVISED !== 'launchd' || uid < 0) return;
  try {
    start('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
  } catch {
    // Best effort: ThrottleInterval still spaces the restarts.
  }
}

/** `<file> --version` → major, or null. */
function nodeMajor(d: ServiceDeps, node: string): { major: number; version: string } | null {
  const r = d.run(node, ['--version']);
  const version = r.stdout.trim();
  const m = /^v(\d+)\./.exec(version);
  return r.status === 0 && m ? { major: Number(m[1]), version } : null;
}

function findOnPath(path: string | undefined, name: string): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * The absolute node the units pin: CONDUCTOR_NODE, else `node` on PATH when it is the node running
 * this (a stable path such as /opt/homebrew/bin/node, not the Cellar one), else this node.
 */
export function resolveNode(d: ServiceDeps): { node: string } | { error: string } {
  const fromEnv = d.env.CONDUCTOR_NODE?.trim();
  let node: string;
  let source: string;
  if (fromEnv) {
    if (!isAbsolute(fromEnv))
      return { error: `CONDUCTOR_NODE must be an absolute path (got ${fromEnv})` };
    node = fromEnv;
    source = 'CONDUCTOR_NODE';
  } else {
    const onPath = findOnPath(d.env.PATH, 'node');
    node = onPath !== null && sameFile(onPath, d.execPath) ? onPath : d.execPath;
    source = 'the node running this command';
  }
  const v = nodeMajor(d, node);
  if (v === null) return { error: `${node} (${source}) is not a working node` };
  if (v.major < MIN_NODE_MAJOR) {
    return {
      error:
        `the service needs Node.js ${MIN_NODE_MAJOR}+, but ${node} (${source}) is ${v.version}; ` +
        're-run with CONDUCTOR_NODE=/path/to/node22 (with nvm: CONDUCTOR_NODE="$(nvm which 22)")',
    };
  }
  return { node };
}

/** Write `content` (atomically, `mode`) unless the file already holds exactly it. True if written. */
function writeIfChanged(path: string, content: string, mode: number): boolean {
  try {
    if (readFileSync(path, 'utf8') === content && (statSync(path).mode & 0o777) === mode) {
      return false;
    }
  } catch {
    // missing: write it
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return true;
}

function plistPath(d: Pick<ServiceDeps, 'home'>): string {
  return join(d.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(d: Pick<ServiceDeps, 'home'>): string {
  return join(d.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

/** The PATH the units get: the node's dir first, then the installing shell's PATH, deduplicated. */
function unitPathVar(node: string, path: string | undefined): string {
  const dirs = [dirname(node), ...(path ?? '').split(delimiter)].filter(
    (p) => p !== '' && isAbsolute(p),
  );
  return [...new Set(dirs)].join(delimiter);
}

function failed(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.status ?? 'error'}`).split('\n')[0]!;
}

/** Run `service …`; returns the exit code (0 ok, 1 failed, 2 usage; `status`: 3 not running). */
export function serviceCommand(argv: string[], deps: Partial<ServiceDeps> = {}): number {
  const d = { ...defaultDeps(deps), ...deps };
  const [sub, ...rest] = argv;
  if (
    sub === undefined ||
    rest.length > 0 ||
    !['install', 'uninstall', 'restart', 'status'].includes(sub)
  ) {
    d.err(SERVICE_USAGE);
    return 2;
  }
  if (d.manager === null) {
    d.err('service is not supported on this OS yet; start conductor-daemon yourself');
    return 2;
  }
  const root = rootDirFrom(d.env, { home: d.home });
  const ctl = d.manager === 'launchd' ? launchd(d) : systemd(d);
  try {
    switch (sub) {
      case 'install':
        return install(d, root, ctl);
      case 'uninstall':
        return ctl.uninstall();
      case 'restart':
        if (!existsSync(ctl.unit)) {
          d.err(
            `the service is not installed (${ctl.unit}); run: conductor-daemon service install`,
          );
          return 1;
        }
        return ctl.restart();
      default:
        return ctl.status(root);
    }
  } catch (e) {
    d.err(`service ${sub}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

interface Supervisor {
  unit: string;
  render(u: UnitInputs): string;
  /** After the unit file is written (`changed`) or left as it was. */
  activate(changed: boolean): number;
  uninstall(): number;
  restart(): number;
  status(root: string): number;
  logs(root: string): string;
}

function install(d: ServiceDeps, root: string, ctl: Supervisor): number {
  const daemon = join(root, 'daemon', 'current', 'bin', 'conductor-daemon');
  if (!existsSync(daemon)) {
    d.err(
      `${daemon} is missing: install conductor with install.sh first (Machines → Add a machine)`,
    );
    return 1;
  }
  if (!existsSync(join(root, 'machine.json'))) {
    d.err(
      `warning: ${root} is not enrolled; the daemon will run in local mode until you enroll it`,
    );
  }
  const node = resolveNode(d);
  if ('error' in node) {
    d.err(node.error);
    return 1;
  }
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  writeIfChanged(launcherPath(root), readFileSync(LAUNCHER_ASSET, 'utf8'), 0o755);
  const content = ctl.render({
    root,
    node: node.node,
    path: unitPathVar(node.node, d.env.PATH),
    home: d.home,
  });
  const changed = writeIfChanged(ctl.unit, content, 0o644);
  const code = ctl.activate(changed);
  if (code !== 0) return code;
  d.out(`conductor-daemon service installed: ${ctl.unit} (node ${node.node})`);
  d.out(`logs: ${ctl.logs(root)}`);
  return 0;
}

function launchd(d: ServiceDeps): Supervisor {
  const domain = `gui/${d.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const unit = plistPath(d);
  const loaded = () => d.run('launchctl', ['print', target]).status === 0;
  const bootstrap = (): number => {
    // A job disabled earlier (e.g. by `launchctl disable`) would refuse to bootstrap.
    d.run('launchctl', ['enable', target]);
    const r = d.run('launchctl', ['bootstrap', domain, unit]);
    if (r.status !== 0) {
      d.err(`launchctl bootstrap ${domain} failed: ${failed(r)}`);
      return 1;
    }
    return 0;
  };
  return {
    unit,
    render: renderPlist,
    activate(changed) {
      if (changed) {
        if (loaded()) d.run('launchctl', ['bootout', target]);
        return bootstrap();
      }
      return loaded() ? 0 : bootstrap();
    },
    uninstall() {
      if (loaded()) d.run('launchctl', ['bootout', target]);
      rmSync(unit, { force: true });
      d.out(`conductor-daemon service removed (${unit})`);
      return 0;
    },
    restart() {
      if (!loaded()) return bootstrap();
      const r = d.run('launchctl', ['kickstart', '-k', target]);
      if (r.status !== 0) {
        d.err(`launchctl kickstart failed: ${failed(r)}`);
        return 1;
      }
      return 0;
    },
    status(root) {
      const installed = existsSync(unit);
      const r = d.run('launchctl', ['print', target]);
      const pid = r.status === 0 ? /\bpid = (\d+)/.exec(r.stdout)?.[1] : undefined;
      d.out(`unit: ${unit} (${installed ? 'installed' : 'not installed'})`);
      d.out(
        `state: ${pid ? `running (pid ${pid})` : r.status === 0 ? 'loaded, not running' : 'not loaded'}`,
      );
      d.out(`logs: ${logPath(root)}`);
      return pid ? 0 : 3;
    },
    logs: logPath,
  };
}

function systemd(d: ServiceDeps): Supervisor {
  const unit = systemdUnitPath(d);
  const ctl = (...args: string[]) => d.run('systemctl', ['--user', ...args]);
  const noBus = (r: RunResult): number => {
    d.err(
      `systemctl --user failed: ${failed(r)}. It needs your login session's user manager ` +
        '(not plain ssh/su); log in normally, or run: loginctl enable-linger "$USER"',
    );
    return 1;
  };
  const logs = () => 'journalctl --user -u conductor-daemon';
  return {
    unit,
    render: renderSystemdUnit,
    activate(changed) {
      if (changed) {
        // A changed unit applies to a running service only after a restart (which also starts it).
        for (const args of [
          ['daemon-reload'],
          ['enable', SYSTEMD_UNIT],
          ['restart', SYSTEMD_UNIT],
        ]) {
          const r = ctl(...args);
          if (r.status !== 0) return noBus(r);
        }
      } else {
        const r = ctl('enable', '--now', SYSTEMD_UNIT);
        if (r.status !== 0) return noBus(r);
      }
      d.out(
        'to keep it running while you are logged out: loginctl enable-linger "$USER"' +
          (d.wsl()
            ? ' (WSL: systemd must be on in /etc/wsl.conf, and WSL itself starts only when you open it)'
            : ''),
      );
      return 0;
    },
    uninstall() {
      if (existsSync(unit)) ctl('disable', '--now', SYSTEMD_UNIT);
      rmSync(unit, { force: true });
      ctl('daemon-reload');
      d.out(`conductor-daemon service removed (${unit})`);
      return 0;
    },
    restart() {
      const r = ctl('restart', SYSTEMD_UNIT);
      return r.status === 0 ? 0 : noBus(r);
    },
    status() {
      const installed = existsSync(unit);
      const r = ctl('is-active', SYSTEMD_UNIT);
      const state = r.stdout.trim() || 'unknown';
      d.out(`unit: ${unit} (${installed ? 'installed' : 'not installed'})`);
      d.out(`state: ${state}`);
      d.out(`logs: ${logs()}`);
      return state === 'active' ? 0 : 3;
    },
    logs,
  };
}
