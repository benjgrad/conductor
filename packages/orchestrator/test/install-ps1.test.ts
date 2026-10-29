// MW-T11: the rendered /install.ps1, run the way Add a machine says (`$env:…='<token>'; irm … |
// iex`) in Windows PowerShell 5.1, against a local orchestrator serving a small fake daemon
// tarball: the real bin\conductor-daemon.cmd entry (assets/conductor-daemon.cmd.tmpl) in front of
// a dist/main.js that records each call. Windows only (the daemon-windows workflow runs it). The
// root is a temp dir; the real node and git are used, claude.exe is a copy of node.exe. The script
// adds <root>\bin to the user PATH in HKCU, so the suite restores that value afterwards.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installCommandWindows } from '../src/api/machines.js';
import { findDaemonBuild, serveDistribution } from '../src/distribution.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'enroll-tok-3f9a1c2b';
const V1 = '0.0.0+aaaaaaa';
const V2 = '0.0.0+bbbbbbb';

/** Records `{argv, token, root, sha}` per call; `enroll` writes machine.json (or fails). */
const FAKE_MAIN = `const fs = require('node:fs');
const path = require('node:path');
const e = process.env;
fs.appendFileSync(e.CALLS_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  token: e.CONDUCTOR_ENROLL_TOKEN ?? null,
  root: e.CONDUCTOR_ROOT ?? null,
  sha: e.CONDUCTOR_BUILD_SHA ?? null,
}) + '\\n');
if (process.argv[2] === 'enroll') {
  if (e.FAKE_ENROLL_FAIL) process.exit(3);
  fs.writeFileSync(path.join(e.CONDUCTOR_ROOT, 'machine.json'), '{}');
}
`;

interface Call {
  argv: string[];
  token: string | null;
  root: string | null;
  sha: string | null;
}

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async: the orchestrator serving the tarball runs in this process, so never spawnSync here. */
function run(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const ps = (command: string, env: NodeJS.ProcessEnv) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], env);

describe.skipIf(process.platform !== 'win32')('install.ps1 (Windows PowerShell 5.1)', () => {
  let work: string;
  const servers: Server[] = [];
  let savedUserPath: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'conductor-install-ps1-'));
    const saved = await ps(
      "$k = Get-Item -LiteralPath 'HKCU:\\Environment'; " +
        "Write-Output ($k.GetValueKind('Path').ToString() + '|' + $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'))",
      process.env,
    );
    savedUserPath = saved.stdout.trim();
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    const bar = savedUserPath.indexOf('|');
    if (bar > 0) {
      const kind = savedUserPath.slice(0, bar);
      const value = savedUserPath.slice(bar + 1).replace(/'/g, "''");
      await ps(
        `New-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value '${value}' -PropertyType ${kind} -Force | Out-Null`,
        process.env,
      );
    }
    rmSync(work, { recursive: true, force: true });
  });

  /** A downloads dir with a fake tarball for `version`, served on a fresh local port. */
  async function serve(version: string): Promise<string> {
    const pkg = join(work, `pkg-${version}`);
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    mkdirSync(join(pkg, 'dist'));
    const sha = version.split('+')[1]!;
    const cmd = readFileSync(join(pkgDir, 'assets', 'conductor-daemon.cmd.tmpl'), 'utf8')
      .replaceAll('@@BUILD_SHA@@', sha)
      .replace(/\r?\n/g, '\r\n');
    writeFileSync(join(pkg, 'bin', 'conductor-daemon.cmd'), cmd);
    writeFileSync(join(pkg, 'dist', 'main.js'), FAKE_MAIN);
    writeFileSync(join(pkg, 'package.json'), '{"name":"fake-daemon","private":true}\n');
    const dir = join(work, `downloads-${version}`);
    mkdirSync(dir);
    const file = `conductor-daemon-${version}.tgz`;
    const tar = await run('tar', ['-C', pkg, '-czf', join(dir, file), '.'], process.env);
    expect(tar.status, tar.stderr).toBe(0);
    const hex = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
    writeFileSync(join(dir, `${file}.sha256`), `${hex}  ${file}\n`);

    const build = findDaemonBuild(dir);
    expect(build).not.toBeNull();
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serveDistribution(server, {
      db: { query: () => Promise.resolve() },
      publicUrl: url,
      build,
      version,
    });
    return url;
  }

  /** A dir to put first on PATH, holding `claude` as `.exe` (node.exe), `.cmd`, or nothing. */
  function fakeBin(claude: 'exe' | 'cmd' | 'none'): string {
    const bin = mkdtempSync(join(work, 'bin-'));
    if (claude === 'exe') copyFileSync(process.execPath, join(bin, 'claude.exe'));
    if (claude === 'cmd') writeFileSync(join(bin, 'claude.cmd'), '@echo 2.1.308\r\n');
    return bin;
  }

  /** The PATH without any directory that already holds a claude. */
  function basePath(): string {
    return (process.env.Path ?? process.env.PATH ?? '')
      .split(';')
      .filter((d) => d !== '' && !['claude.exe', 'claude.cmd'].some((c) => existsSync(join(d, c))))
      .join(';');
  }

  /** Run `command`, then print what the session looks like afterwards. */
  function install(command: string, root: string, bin: string, extra: NodeJS.ProcessEnv = {}) {
    const after =
      "; Write-Output ('TOKEN_AFTER=[' + $env:CONDUCTOR_ENROLL_TOKEN + ']')" +
      "; Write-Output ('ROOT_AFTER=[' + $env:CONDUCTOR_ROOT + ']')" +
      `; Write-Output ('ON_PATH=' + [bool](($env:Path -split ';') -contains '${join(root, 'bin')}'))`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      Path: `${bin};${basePath()}`,
      CONDUCTOR_ROOT: root,
      CALLS_LOG: join(work, 'calls.log'),
      ...extra,
    };
    delete env.PATH;
    return ps(command + after, env);
  }

  const calls = (): Call[] => {
    const log = join(work, 'calls.log');
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
  };

  const userPath = async () =>
    (
      await ps(
        "(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
        process.env,
      )
    ).stdout.trim();

  it(
    'installs, enrolls with the token in the environment only, then upgrades in place',
    {
      timeout: 180_000,
    },
    async () => {
      const root = join(work, 'croot');
      const bin = fakeBin('exe');
      const url1 = await serve(V1);

      const first = await install(installCommandWindows(url1, TOKEN), root, bin);
      expect(first.stdout, first.stderr).toContain(`installed conductor-daemon ${V1}`);
      expect(first.stdout).not.toContain('conductor install:');
      // Nothing is left in the caller's session but the PATH entry.
      expect(first.stdout).toContain('TOKEN_AFTER=[]');
      expect(first.stdout).toContain(`ROOT_AFTER=[${root}]`);
      expect(first.stdout).toContain('ON_PATH=True');

      const enrolls = calls();
      expect(enrolls).toHaveLength(1);
      expect(enrolls[0]!.argv).toEqual(['enroll', '--url', url1]);
      expect(enrolls[0]!.token).toBe(TOKEN);
      expect(enrolls[0]!.root).toBe(root);
      expect(enrolls[0]!.sha).toBe('aaaaaaa');
      expect(existsSync(join(root, 'machine.json'))).toBe(true);

      // `current` is a junction (U-107: lstat reports it as a link) to the version dir.
      const current = join(root, 'daemon', 'current');
      expect(lstatSync(current).isSymbolicLink()).toBe(true);
      expect(realpathSync.native(current)).toBe(realpathSync.native(join(root, 'daemon', V1)));
      expect(existsSync(join(root, 'bin', 'conductor-daemon.cmd'))).toBe(true);
      expect((await userPath()).toLowerCase()).toContain(join(root, 'bin').toLowerCase());

      // Owner-only (ADR-0024 section 3): no inherited entries, you as the owner.
      const acl = await ps(
        `$a = Get-Acl -LiteralPath '${root}'; Write-Output ('PROTECTED=' + $a.AreAccessRulesProtected); ` +
          "Write-Output ('OWNER=' + $a.GetOwner([Security.Principal.SecurityIdentifier]).Value); " +
          "Write-Output ('ME=' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
        process.env,
      );
      expect(acl.stdout).toContain('PROTECTED=True');
      const owner = /OWNER=(\S+)/.exec(acl.stdout)?.[1];
      expect(owner).toBe(/ME=(\S+)/.exec(acl.stdout)?.[1]);

      // The installed command runs the daemon (the .cmd chain passes arguments and the exit code).
      const help = await run(
        'cmd.exe',
        ['/d', '/c', join(root, 'bin', 'conductor-daemon.cmd'), 'config', 'show'],
        { ...process.env, CALLS_LOG: join(work, 'calls.log') },
      );
      expect(help.status, help.stderr).toBe(0);
      expect(calls().at(-1)!.argv).toEqual(['config', 'show']);

      // Re-run without a token: upgrade in place, enrollment kept, no second enroll.
      const url2 = await serve(V2);
      const second = await install(`irm ${url2}/install.ps1 | iex`, root, bin);
      expect(second.stdout, second.stderr).toContain(`installed conductor-daemon ${V2}`);
      expect(second.stdout).toContain('upgraded in place; enrollment kept');
      expect(calls().filter((c) => c.argv[0] === 'enroll')).toHaveLength(1);
      expect(realpathSync.native(current)).toBe(realpathSync.native(join(root, 'daemon', V2)));
      // The PATH entry isn't added twice.
      const entries = (await userPath())
        .toLowerCase()
        .split(';')
        .filter((d) => d === join(root, 'bin').toLowerCase());
      expect(entries).toHaveLength(1);

      // A tarball that doesn't match the script's SHA-256: aborts, nothing switched.
      const v3 = '0.0.0+fffffff';
      const url3 = await serve(v3);
      writeFileSync(join(work, `downloads-${v3}`, `conductor-daemon-${v3}.tgz`), 'tampered');
      const third = await install(`irm ${url3}/install.ps1 | iex`, root, bin);
      expect(third.stdout).toContain(`conductor install: SHA-256 mismatch`);
      expect(existsSync(join(root, 'daemon', v3))).toBe(false);
      expect(realpathSync.native(current)).toBe(realpathSync.native(join(root, 'daemon', V2)));
    },
  );

  it('lists a missing claude and installs nothing', { timeout: 120_000 }, async () => {
    const root = join(work, 'no-claude');
    const url = await serve('0.0.0+ccccccc');
    const r = await install(installCommandWindows(url, TOKEN), root, fakeBin('none'));
    expect(r.stdout).toContain('conductor install: missing prerequisites');
    expect(r.stdout).toContain('Claude Code (claude.exe) is required');
    expect(r.stdout).toContain('TOKEN_AFTER=[]');
    expect(existsSync(root)).toBe(false);
  });

  it(
    "refuses npm's claude.cmd with the native-install hint (U-110)",
    { timeout: 120_000 },
    async () => {
      const root = join(work, 'cmd-claude');
      const url = await serve('0.0.0+ddddddd');
      const r = await install(installCommandWindows(url, TOKEN), root, fakeBin('cmd'));
      expect(r.stdout).toContain('the native Claude Code (claude.exe) is required');
      expect(existsSync(root)).toBe(false);
    },
  );

  it('says so when enrollment fails, with the daemon installed', { timeout: 120_000 }, async () => {
    const root = join(work, 'enroll-fails');
    const url = await serve('0.0.0+eeeeeee');
    const r = await install(installCommandWindows(url, TOKEN), root, fakeBin('exe'), {
      FAKE_ENROLL_FAIL: '1',
    });
    expect(r.stdout).toContain('conductor install: enrollment failed');
    expect(r.stdout).toContain('TOKEN_AFTER=[]');
    expect(existsSync(join(root, 'bin', 'conductor-daemon.cmd'))).toBe(true);
    expect(existsSync(join(root, 'machine.json'))).toBe(false);
  });
});
