import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceManager } from '../platform/index.js';
import { pathWith, writeFakeBin } from '../test-support/fake-bin.js';
import { EXIT_FATAL_AUTH } from '../ws-client.js';
import {
  LAUNCHER_ASSET,
  LAUNCHD_LABEL,
  renderPlist,
  renderSystemdUnit,
  serviceCommand,
  stopSupervisedJob,
  type ServiceDeps,
} from './service.js';

// M2-T18: `conductor-daemon service …`. The unit files are pure renderers (snapshots); the
// install / uninstall / restart flow runs against fake launchctl / systemctl / sudo on PATH.

const EXIT_RESTART_FOR_UPDATE = 75; // ADR-0021 §2 (T18b's constant in shared)

const INPUTS = {
  root: '/Users/ann/.conductor',
  node: '/opt/homebrew/bin/node',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  home: '/Users/ann',
};

/** What the unit tells systemd to do when the main process exits with `code`. */
function systemdRestarts(unit: string, code: number): boolean {
  expect(unit).toMatch(/^Restart=on-failure$/m);
  const prevent = (/^RestartPreventExitStatus=(.*)$/m.exec(unit)?.[1] ?? '').split(/\s+/);
  return code !== 0 && !prevent.includes(String(code));
}

/** What launchd does: KeepAlive {SuccessfulExit: false} restarts any non-zero exit of a loaded job. */
function launchdRestarts(plist: string, code: number, bootedOut: boolean): boolean {
  expect(plist).toMatch(
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  );
  return code !== 0 && !bootedOut;
}

describe('unit files', () => {
  it('launchd on macOS, systemd on Linux, none on Windows', () => {
    expect(serviceManager('darwin')).toBe('launchd');
    expect(serviceManager('linux')).toBe('systemd');
    expect(serviceManager('win32')).toBeNull();
  });

  it('the launchd plist runs the launcher, supervised, with pinned node, logs and a throttle', () => {
    const plist = renderPlist(INPUTS);
    expect(plist).toMatchSnapshot();
    expect(plist).toContain(
      '<key>ProgramArguments</key>\n  <array>\n    <string>/Users/ann/.conductor/bin/conductor-launch</string>',
    );
    expect(plist).toContain('<key>CONDUCTOR_SUPERVISED</key>\n    <string>launchd</string>');
    expect(plist).toContain(
      '<key>CONDUCTOR_NODE</key>\n    <string>/opt/homebrew/bin/node</string>',
    );
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
    expect(plist).toContain('<string>/Users/ann/.conductor/logs/daemon.log</string>');
  });

  it('the systemd unit runs the launcher, supervised, and never restarts on 78', () => {
    const unit = renderSystemdUnit(INPUTS);
    expect(unit).toMatchSnapshot();
    expect(unit).toContain('ExecStart="/Users/ann/.conductor/bin/conductor-launch"');
    expect(unit).toContain('Environment="CONDUCTOR_SUPERVISED=systemd"');
    expect(unit).toMatch(/^RestartPreventExitStatus=78$/m);
  });

  it('escapes XML and systemd specifiers, and refuses what systemd cannot quote', () => {
    const odd = { ...INPUTS, root: '/home/a&b/100%<x>' };
    expect(renderPlist(odd)).toContain(
      '<string>/home/a&amp;b/100%&lt;x&gt;/bin/conductor-launch</string>',
    );
    expect(renderSystemdUnit(odd)).toContain('ExecStart="/home/a&b/100%%<x>/bin/conductor-launch"');
    expect(() => renderSystemdUnit({ ...INPUTS, path: '/bin:/x"y' })).toThrow(/systemd unit/);
  });

  it('restart policy: 75 and crashes restart, 0 and 78 do not (TD-119, ADR-0021)', () => {
    const unit = renderSystemdUnit(INPUTS);
    expect(systemdRestarts(unit, 1)).toBe(true);
    expect(systemdRestarts(unit, EXIT_RESTART_FOR_UPDATE)).toBe(true);
    expect(systemdRestarts(unit, 0)).toBe(false);
    expect(systemdRestarts(unit, EXIT_FATAL_AUTH)).toBe(false);

    const plist = renderPlist(INPUTS);
    const booted: string[][] = [];
    const exitUnderLaunchd = (code: number) => {
      // The daemon's fatal path (main.ts onFatal) runs stopSupervisedJob before exiting 78.
      if (code === EXIT_FATAL_AUTH) {
        stopSupervisedJob({ CONDUCTOR_SUPERVISED: 'launchd' }, 501, (f, a) =>
          booted.push([f, ...a]),
        );
      }
      return launchdRestarts(plist, code, booted.length > 0);
    };
    expect(exitUnderLaunchd(1)).toBe(true);
    expect(exitUnderLaunchd(EXIT_RESTART_FOR_UPDATE)).toBe(true);
    expect(exitUnderLaunchd(0)).toBe(false);
    expect(exitUnderLaunchd(EXIT_FATAL_AUTH)).toBe(false);
    expect(booted).toEqual([['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]]);
  });

  it('stopSupervisedJob does nothing when unsupervised or under systemd', () => {
    const calls: string[][] = [];
    const rec = (f: string, a: string[]) => calls.push([f, ...a]);
    stopSupervisedJob({}, 501, rec);
    stopSupervisedJob({ CONDUCTOR_SUPERVISED: 'systemd' }, 501, rec);
    expect(calls).toEqual([]);
  });
});

// Spawns fake launchctl / systemctl / sudo / node: the command-line boundary to the service
// managers is what's under test. POSIX only (no launchd or systemd on Windows; `service` refuses).
describe.skipIf(process.platform === 'win32')('service install / uninstall / restart', () => {
  let tmp: string;
  let home: string;
  let root: string;
  let fakebin: string;
  let log: string;
  let out: string[];
  let err: string[];

  const FAKE_CTL = `import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, [basename(process.argv[1]), ...args].join(' ') + '\\n');
const state = process.env.FAKE_STATE;
if (args[0] === 'print') process.exit(existsSync(state) ? 0 : 113);
if (args[0] === 'bootstrap') writeFileSync(state, 'loaded');
if (args[0] === 'bootout') rmSync(state, { force: true });
if (args[1] === 'is-active') { console.log('active'); }
`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'conductor-service-'));
    home = join(tmp, 'home');
    root = join(home, '.conductor');
    fakebin = join(tmp, 'fakebin');
    log = join(tmp, 'calls.log');
    mkdirSync(join(root, 'daemon', 'current', 'bin'), { recursive: true });
    writeFileSync(join(root, 'daemon', 'current', 'bin', 'conductor-daemon'), '#!/bin/sh\n');
    writeFileSync(join(root, 'machine.json'), '{}');
    mkdirSync(fakebin);
    for (const name of ['launchctl', 'systemctl', 'sudo']) writeFakeBin(fakebin, name, FAKE_CTL);
    writeFakeBin(fakebin, 'node20', "console.log('v20.18.0');\n");
    out = [];
    err = [];
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function deps(
    manager: 'launchd' | 'systemd',
    env: Record<string, string> = {},
  ): Partial<ServiceDeps> {
    const full: Record<string, string> = {
      HOME: home,
      PATH: pathWith(fakebin, dirname(process.execPath), '/usr/bin', '/bin'),
      FAKE_LOG: log,
      FAKE_STATE: join(tmp, 'loaded'),
      CONDUCTOR_NODE: process.execPath,
      ...env,
    };
    return {
      manager,
      home,
      uid: 501,
      env: full,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      wsl: () => false,
      // `run` is the real spawnSync with this env, so the fake tools are first on PATH.
    };
  }

  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const service = (argv: string[], d: Partial<ServiceDeps>) => serviceCommand(argv, d);

  for (const manager of ['launchd', 'systemd'] as const) {
    const unitFile = () =>
      manager === 'launchd'
        ? join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
        : join(home, '.config', 'systemd', 'user', 'conductor-daemon.service');

    it(`${manager}: install writes the unit and the launcher; a second install changes nothing`, () => {
      const d = deps(manager);
      expect(service(['install'], d), err.join('\n')).toBe(0);
      const inputs = {
        root,
        node: process.execPath,
        path: [...new Set([dirname(process.execPath), ...(d.env!.PATH ?? '').split(':')])].join(
          ':',
        ),
        home,
      };
      const expected = manager === 'launchd' ? renderPlist(inputs) : renderSystemdUnit(inputs);
      expect(readFileSync(unitFile(), 'utf8')).toBe(expected);
      const launcher = join(root, 'bin', 'conductor-launch');
      expect(readFileSync(launcher)).toEqual(readFileSync(LAUNCHER_ASSET));
      expect(statSync(launcher).mode & 0o777).toBe(0o755);
      expect(statSync(join(root, 'logs')).isDirectory()).toBe(true);
      const first = calls();
      expect(first).toEqual(
        manager === 'launchd'
          ? [
              `launchctl print gui/501/${LAUNCHD_LABEL}`,
              `launchctl enable gui/501/${LAUNCHD_LABEL}`,
              `launchctl bootstrap gui/501 ${unitFile()}`,
            ]
          : [
              'systemctl --user daemon-reload',
              'systemctl --user enable conductor-daemon.service',
              'systemctl --user restart conductor-daemon.service',
            ],
      );

      const before = [unitFile(), launcher].map((p) => [
        readFileSync(p, 'utf8'),
        statSync(p).mtimeMs,
      ]);
      expect(service(['install'], d)).toBe(0);
      expect(
        [unitFile(), launcher].map((p) => [readFileSync(p, 'utf8'), statSync(p).mtimeMs]),
      ).toEqual(before);
      // Nothing re-bootstrapped or reloaded: only a check (launchd) or the idempotent enable.
      expect(calls().slice(first.length)).toEqual(
        manager === 'launchd'
          ? [`launchctl print gui/501/${LAUNCHD_LABEL}`]
          : ['systemctl --user enable --now conductor-daemon.service'],
      );
    });

    it(`${manager}: restart, status and uninstall; sudo is never used`, () => {
      const d = deps(manager);
      expect(service(['restart'], d)).toBe(1);
      expect(err.join('\n')).toContain('not installed');
      expect(service(['install'], d)).toBe(0);
      expect(service(['restart'], d)).toBe(0);
      expect(calls().at(-1)).toBe(
        manager === 'launchd'
          ? `launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`
          : 'systemctl --user restart conductor-daemon.service',
      );
      service(['status'], d);
      expect(out.join('\n')).toContain(unitFile());
      expect(service(['uninstall'], d)).toBe(0);
      expect(existsSync(unitFile())).toBe(false);
      expect(calls()).toContain(
        manager === 'launchd'
          ? `launchctl bootout gui/501/${LAUNCHD_LABEL}`
          : 'systemctl --user disable --now conductor-daemon.service',
      );
      expect(service(['uninstall'], d)).toBe(0); // nothing left: still fine
      expect(calls().filter((c) => /(^|\s)sudo(\s|$)/.test(c))).toEqual([]);
    });

    it(`${manager}: refuses without an installed daemon, and with Node 20`, () => {
      expect(service(['install'], deps(manager, { CONDUCTOR_NODE: join(fakebin, 'node20') }))).toBe(
        1,
      );
      expect(err.join('\n')).toMatch(/needs Node\.js 22\+.*v20\.18\.0.*CONDUCTOR_NODE=/);
      rmSync(join(root, 'daemon'), { recursive: true });
      expect(service(['install'], deps(manager))).toBe(1);
      expect(err.join('\n')).toContain('install conductor with install.sh first');
      expect(existsSync(unitFile())).toBe(false);
    });
  }

  it('usage errors and an OS without a service manager exit 2', () => {
    expect(service(['bogus'], deps('systemd'))).toBe(2);
    expect(service(['install'], { ...deps('systemd'), manager: null })).toBe(2);
  });
});
