// M2-T14: the rendered /install.sh, run with `sh` the way `curl … | sh -s -- …` runs it, against a
// local orchestrator serving small fake daemon tarballs, one per target (MR-T15). HOME and --root
// are temp dirs; git, claude, uname and sysctl are fakes on PATH, next to a toolbox of the real
// tools the script needs and no node (the native daemon needs none); the fake conductor-daemon
// records each call (TD-117: the token must arrive in CONDUCTOR_ENROLL_TOKEN, never in argv).
// M2-T18: the tarball's assets/conductor-launch.sh lands byte-identical in
// <root>/bin/conductor-launch.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PATHS, EnrollRequestSchema } from '@conductor/shared';
import {
  DAEMON_TARGETS,
  findDaemonDist,
  serveDistribution,
  type DaemonTarget,
} from '../src/distribution.js';

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const whichCmd = (c: string) => {
  const r = spawnSync('sh', ['-c', `command -v ${c}`], {
    env: { PATH: SYSTEM_PATH },
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
};
const hasCmd = (c: string) => whichCmd(c) !== null;
const runnable =
  ['sh', 'curl', 'tar', 'mktemp', 'cut'].every(hasCmd) && (hasCmd('shasum') || hasCmd('sha256sum'));
/** The real tools install.sh (and the fake daemon) use; no node among them. */
const TOOLS = [
  'sh',
  'curl',
  'tar',
  'gzip',
  'mktemp',
  'shasum',
  'sha256sum',
  'cut',
  'rm',
  'mkdir',
  'chmod',
  'mv',
  'ln',
  'cp',
  'cat',
  'env',
  'dirname',
  'perl',
];
const HOST = 'x86_64-unknown-linux-gnu';

const TOKEN = 'enroll-tok-3f9a1c2b';
const V1 = '0.0.0+aaaaaaa';
const V2 = '0.0.0+bbbbbbb';
const V3 = '0.0.0+ccccccc';

/**
 * The fake daemon: `--version` answers (install.sh runs it before switching `current`) and is not
 * recorded; every other call records `argv|token|root`; `enroll` writes machine.json.
 */
const FAKE_DAEMON = `#!/bin/sh
[ "$1" = --version ] && { echo fake; exit 0; }
printf '%s|%s|%s\\n' "$*" "\${CONDUCTOR_ENROLL_TOKEN-<unset>}" "\${CONDUCTOR_ROOT-<unset>}" >>"$CALLS_LOG"
if [ "$1" = enroll ]; then
  printf '{"machine_id":"m-1","credential":"secret"}\\n' >"$CONDUCTOR_ROOT/machine.json"
fi
`;
/** A daemon this machine can't run: its `--version` fails. */
const BROKEN_DAEMON = '#!/bin/sh\nexit 126\n';

let work: string;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** The launcher every install writes (the daemon's asset; `service install` writes it too). */
const LAUNCHER = join(REPO, 'crates', 'conductor-daemon', 'assets', 'conductor-launch.sh');

interface BuildOpts {
  launcher?: boolean;
  /** The targets to build (default all); each tarball's TARGET file names its own. */
  targets?: readonly DaemonTarget[];
  broken?: boolean;
}

/** Build a downloads dir with a fake tarball per target for `version`. */
function buildDownloads(version: string, opts: BuildOpts = {}): string {
  const dir = mkdtempSync(join(work, `downloads-${version}-`));
  for (const target of opts.targets ?? DAEMON_TARGETS) {
    const pkg = mkdtempSync(join(work, `pkg-${version}-${target}-`));
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'bin', 'conductor-daemon'), opts.broken ? BROKEN_DAEMON : FAKE_DAEMON);
    chmodSync(join(pkg, 'bin', 'conductor-daemon'), 0o755);
    if (opts.launcher ?? true) {
      mkdirSync(join(pkg, 'assets'), { recursive: true });
      writeFileSync(join(pkg, 'assets', 'conductor-launch.sh'), readFileSync(LAUNCHER));
    }
    writeFileSync(join(pkg, 'VERSION'), version);
    writeFileSync(join(pkg, 'TARGET'), target);
    const file = `conductor-daemon-${version}-${target}.tgz`;
    const tar = spawnSync('tar', ['-C', pkg, '-czf', join(dir, file), '.']);
    expect(tar.status, tar.stderr.toString()).toBe(0);
    const hex = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
    writeFileSync(join(dir, `${file}.sha256`), `${hex}  ${file}\n`);
  }
  return dir;
}

interface Served {
  server: Server;
  url: string;
  script: string;
}

async function serve(version: string, opts: BuildOpts = {}): Promise<Served> {
  return serveDir(buildDownloads(version, opts), version);
}

async function serveDir(downloads: string, version: string): Promise<Served> {
  const dist = findDaemonDist(downloads);
  expect(dist).not.toBeNull();
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serveDistribution(server, {
    db: { query: () => Promise.resolve() },
    publicUrl: url,
    dist,
    version,
  });
  const res = await fetch(`${url}/install.sh`);
  expect(res.status).toBe(200);
  return { server, url, script: await res.text() };
}

const close = (s: Served) => new Promise<void>((r) => s.server.close(() => r()));

/**
 * A temp HOME whose PATH is a dir of fakes (git, claude; uname and sysctl answer from
 * FAKE_UNAME_S / FAKE_UNAME_M / FAKE_ROSETTA, default Linux x86_64) plus a toolbox of real tools,
 * and no node. `realUname`: the real uname and sysctl instead (the real daemon is this host's).
 */
function makeHome(opts: { without?: string[]; realUname?: boolean } = {}) {
  const home = mkdtempSync(join(work, 'home-'));
  const bin = join(home, 'fakebin');
  const tools = join(home, 'toolbox');
  mkdirSync(bin);
  mkdirSync(tools);
  const fakes: Record<string, string> = {
    git: '#!/bin/sh\necho git version 2.45.0\n',
    claude: '#!/bin/sh\necho 2.1.308\n',
  };
  if (!opts.realUname) {
    fakes.uname =
      '#!/bin/sh\ncase "$1" in -s) echo "${FAKE_UNAME_S:-Linux}" ;; -m) echo "${FAKE_UNAME_M:-x86_64}" ;; esac\n';
    fakes.sysctl = '#!/bin/sh\necho "${FAKE_ROSETTA:-0}"\n';
  }
  for (const [name, body] of Object.entries(fakes)) {
    if (opts.without?.includes(name)) continue;
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  for (const tool of [...TOOLS, ...(opts.realUname ? ['uname', 'sysctl'] : [])]) {
    const real = whichCmd(tool);
    if (real !== null) symlinkSync(real, join(tools, tool));
  }
  return {
    home,
    bin,
    path: `${bin}:${tools}`,
    root: join(home, 'croot'),
    calls: join(home, 'calls.log'),
  };
}

type Home = ReturnType<typeof makeHome>;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async: the orchestrator serving the tarball runs in this process, so never spawnSync here. */
function sh(args: string[], env: Record<string, string>, input: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.on('error', () => {}).end(input);
  });
}

/** Run the script like `curl | sh -s -- args` (stdin = the script), or from a file. */
function run(
  h: Home,
  script: string,
  args: string[],
  opts: { env?: Record<string, string>; fromFile?: boolean; stdin?: string } = {},
) {
  const env = {
    HOME: h.home,
    PATH: h.path,
    CALLS_LOG: h.calls,
    ...opts.env,
  };
  if (opts.fromFile) {
    const file = join(h.home, 'install.sh');
    writeFileSync(file, script);
    return sh([file, ...args], env, opts.stdin ?? '');
  }
  return sh(['-s', '--', ...args], env, script);
}

const calls = (h: Home) =>
  existsSync(h.calls)
    ? readFileSync(h.calls, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          const [argv, token, root] = l.split('|');
          return { argv: argv!, token: token!, root: root! };
        })
    : [];

function expectLauncher(root: string) {
  const path = join(root, 'bin', 'conductor-launch');
  expect(readFileSync(path)).toEqual(readFileSync(LAUNCHER));
  expect(statSync(path).mode & 0o777).toBe(0o755);
}

function expectInstalled(h: Home, version: string, target: DaemonTarget = HOST) {
  expect(existsSync(join(h.root, 'daemon', version, 'bin', 'conductor-daemon'))).toBe(true);
  expect(readFileSync(join(h.root, 'daemon', version, 'TARGET'), 'utf8')).toBe(target);
  expectLauncher(h.root);
  expect(readlinkSync(join(h.root, 'daemon', 'current'))).toBe(version);
  expect(realpathSync(join(h.root, 'bin', 'conductor-daemon'))).toBe(
    realpathSync(join(h.root, 'daemon', version, 'bin', 'conductor-daemon')),
  );
}

describe.skipIf(!runnable)('install.sh', () => {
  let v1: Served;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'conductor-install-'));
    v1 = await serve(V1);
  });
  afterAll(async () => {
    await close(v1);
    rmSync(work, { recursive: true, force: true });
  });

  let h: Home;
  beforeEach(() => {
    h = makeHome();
  });
  afterEach(() => {
    rmSync(h.home, { recursive: true, force: true });
  });

  it('--token installs, links current and enrolls with the token in the environment only', async () => {
    const r = await run(h, v1.script, ['--token', TOKEN, '--root', h.root]);
    expect(r.status, r.stderr).toBe(0);
    expectInstalled(h, V1);
    const c = calls(h);
    expect(c).toHaveLength(1);
    expect(c[0]!.argv).toBe(`enroll --url ${v1.url}`);
    expect(c[0]!.argv).not.toContain(TOKEN);
    expect(c[0]!.token).toBe(TOKEN);
    expect(c[0]!.root).toBe(h.root);
    expect(existsSync(join(h.root, 'machine.json'))).toBe(true);
    expect(r.stdout).toContain(`export PATH="${h.root}/bin:$PATH"`);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it('takes the token from CONDUCTOR_ENROLL_TOKEN', async () => {
    const r = await run(h, v1.script, ['--root', h.root], {
      env: { CONDUCTOR_ENROLL_TOKEN: TOKEN },
    });
    expect(r.status, r.stderr).toBe(0);
    expectInstalled(h, V1);
    const c = calls(h);
    expect(c.map((x) => [x.argv, x.token])).toEqual([[`enroll --url ${v1.url}`, TOKEN]]);
  });

  it('defaults the root to ~/.conductor', async () => {
    const r = await run(h, v1.script, ['--token', TOKEN]);
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(join(h.home, '.conductor', 'daemon', 'current'))).toBe(V1);
  });

  it('--token - reads stdin when the script is a file, and is refused under curl | sh', async () => {
    const r = await run(h, v1.script, ['--token', '-', '--root', h.root], {
      fromFile: true,
      stdin: `${TOKEN}\n`,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(calls(h).map((x) => x.token)).toEqual([TOKEN]);

    const h2 = makeHome();
    const piped = await run(h2, v1.script, ['--token', '-', '--root', h2.root]);
    expect(piped.status).not.toBe(0);
    expect(piped.stderr).toContain('CONDUCTOR_ENROLL_TOKEN');
    expect(existsSync(h2.root)).toBe(false);
  });

  it('a wrong SHA-256 aborts with nothing installed', async () => {
    const bad = v1.script.replace(
      /^SHA256_X86_64_UNKNOWN_LINUX_GNU='[0-9a-f]{64}'$/m,
      `SHA256_X86_64_UNKNOWN_LINUX_GNU='${'0'.repeat(64)}'`,
    );
    expect(bad).not.toBe(v1.script);
    const r = await run(h, bad, ['--token', TOKEN, '--root', h.root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SHA-256 mismatch');
    expect(existsSync(h.root)).toBe(false);
    expect(calls(h)).toEqual([]);
  });

  it('needs no node (MR-T15: the daemon is a native binary)', async () => {
    const r = await run(h, v1.script, ['--token', TOKEN, '--root', h.root], {
      env: { PATH: h.path },
    });
    expect(spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: h.path } }).status).not.toBe(
      0,
    );
    expect(r.status, r.stderr).toBe(0);
    expectInstalled(h, V1);
    expect(r.stdout + r.stderr).not.toMatch(/Node\.js|command -v node/);
  });

  it('lists every missing prerequisite at once', async () => {
    const bare = makeHome({ without: ['git', 'claude'] });
    const r = await run(bare, v1.script, ['--root', bare.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('installs none of them');
    expect(r.stderr).toContain('git is required');
    expect(r.stderr).toContain('claude');
    expect(r.stderr).not.toMatch(/Node\.js/);
    expect(existsSync(bare.root)).toBe(false);
  });

  it.each([
    ['Darwin', 'arm64', '0', 'aarch64-apple-darwin'],
    ['Darwin', 'x86_64', '0', 'x86_64-apple-darwin'],
    // A Rosetta shell on Apple silicon: the native build.
    ['Darwin', 'x86_64', '1', 'aarch64-apple-darwin'],
    ['Linux', 'x86_64', '0', 'x86_64-unknown-linux-gnu'],
    ['Linux', 'aarch64', '0', 'aarch64-unknown-linux-gnu'],
    ['Linux', 'arm64', '0', 'aarch64-unknown-linux-gnu'],
  ] as const)('%s %s (rosetta %s) installs %s', async (os, arch, rosetta, target) => {
    const r = await run(h, v1.script, ['--root', h.root], {
      env: { FAKE_UNAME_S: os, FAKE_UNAME_M: arch, FAKE_ROSETTA: rosetta },
    });
    expect(r.status, r.stderr).toBe(0);
    expectInstalled(h, V1, target);
  });

  it('an unsupported platform stops with a message, nothing installed', async () => {
    for (const [os, arch] of [
      ['FreeBSD', 'amd64'],
      ['Linux', 'riscv64'],
      ['MINGW64_NT-10.0', 'x86_64'],
    ]) {
      const r = await run(h, v1.script, ['--token', TOKEN, '--root', h.root], {
        env: { FAKE_UNAME_S: os!, FAKE_UNAME_M: arch! },
      });
      expect(r.status, `${os}/${arch}`).toBe(1);
      expect(r.stderr).toContain(`unsupported platform ${os}/${arch}`);
      expect(r.stderr).toContain('install.ps1');
    }
    expect(existsSync(h.root)).toBe(false);
    expect(calls(h)).toEqual([]);
  });

  it('stops when the orchestrator has no build for this machine', async () => {
    const linuxOnly = await serve(V2, { targets: [HOST] });
    try {
      const r = await run(h, linuxOnly.script, ['--root', h.root], {
        env: { FAKE_UNAME_S: 'Darwin', FAKE_UNAME_M: 'arm64' },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no conductor-daemon build for aarch64-apple-darwin');
      expect(existsSync(h.root)).toBe(false);
    } finally {
      await close(linuxOnly);
    }
  });

  it('a build that does not run here aborts and leaves the old version current', async () => {
    expect((await run(h, v1.script, ['--root', h.root])).status).toBe(0);
    const broken = await serve(V3, { broken: true });
    try {
      const r = await run(h, broken.script, ['--root', h.root]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('does not run on this machine (Linux/x86_64)');
      expectInstalled(h, V1);
      expect(existsSync(join(h.root, 'daemon', V3))).toBe(false);
    } finally {
      await close(broken);
    }
  });

  it('a second run without --token upgrades in place and keeps machine.json', async () => {
    expect((await run(h, v1.script, ['--token', TOKEN, '--root', h.root])).status).toBe(0);
    const credential = readFileSync(join(h.root, 'machine.json'));
    const v2 = await serve(V2);
    try {
      const r = await run(h, v2.script, ['--root', h.root]);
      expect(r.status, r.stderr).toBe(0);
      expectInstalled(h, V2);
      expect(readFileSync(join(h.root, 'machine.json'))).toEqual(credential);
      expect(r.stdout).toContain('enrollment kept');
      // Only the first run's enroll: the upgrade calls nothing (no service unit installed).
      expect(calls(h).map((x) => x.argv)).toEqual([`enroll --url ${v1.url}`]);
    } finally {
      await close(v2);
    }
  });

  it('restarts an installed service after an upgrade, and --service installs one', async () => {
    const unit = join(h.home, '.config', 'systemd', 'user');
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, 'conductor-daemon.service'), '[Unit]\n');
    expect((await run(h, v1.script, ['--root', h.root])).status).toBe(0);
    expect((await run(h, v1.script, ['--service', '--root', h.root])).status).toBe(0);
    expect(calls(h).map((x) => [x.argv, x.token])).toEqual([
      ['service restart', '<unset>'],
      ['service install', '<unset>'],
    ]);
  });

  it('upgrades a TS daemon install in place: current moves, the TS version and the state stay (FR-4)', async () => {
    // <root> as the TS install.sh left it (M2-T14/T18): a Node package version dir, `current`,
    // the bin links, the launcher, machine.json, config.json and the store.
    const TS = '0.0.0+7500ade'; // not V1: a different version dir
    const ts = join(h.root, 'daemon', TS);
    mkdirSync(join(ts, 'bin'), { recursive: true });
    mkdirSync(join(ts, 'dist'));
    mkdirSync(join(ts, 'node_modules', 'ws'), { recursive: true });
    mkdirSync(join(ts, 'assets'));
    writeFileSync(
      join(ts, 'bin', 'conductor-daemon'),
      '#!/bin/sh\nexec "${CONDUCTOR_NODE:-node}" "$here/dist/main.js" "$@"\n',
    );
    chmodSync(join(ts, 'bin', 'conductor-daemon'), 0o755);
    writeFileSync(join(ts, 'dist', 'main.js'), '// the TS daemon\n');
    writeFileSync(join(ts, 'node_modules', 'ws', 'index.js'), '// ws\n');
    writeFileSync(join(ts, 'package.json'), '{"name":"@conductor/daemon"}\n');
    writeFileSync(join(ts, 'assets', 'conductor-launch.sh'), readFileSync(LAUNCHER));
    symlinkSync(TS, join(h.root, 'daemon', 'current'));
    mkdirSync(join(h.root, 'bin'));
    symlinkSync('../daemon/current/bin/conductor-daemon', join(h.root, 'bin', 'conductor-daemon'));
    writeFileSync(join(h.root, 'bin', 'conductor-launch'), readFileSync(LAUNCHER));
    chmodSync(join(h.root, 'bin', 'conductor-launch'), 0o755);
    const state: Record<string, { bytes: string; mode: number }> = {
      'machine.json': {
        bytes: '{"url":"https://c.test","machine_id":"m-ts","credential":"s"}\n',
        mode: 0o600,
      },
      'config.json': { bytes: '{"roots":["/code"]}\n', mode: 0o600 },
      'state/daemon.json': { bytes: '{"version":1,"sessions":{}}\n', mode: 0o600 },
    };
    mkdirSync(join(h.root, 'state'));
    for (const [f, { bytes, mode }] of Object.entries(state)) {
      writeFileSync(join(h.root, f), bytes, { mode });
    }
    const tsFiles = [
      'bin/conductor-daemon',
      'dist/main.js',
      'node_modules/ws/index.js',
      'package.json',
    ];
    const tsBefore = tsFiles.map((f) => readFileSync(join(ts, f), 'utf8'));
    const unit = join(h.home, '.config', 'systemd', 'user');
    mkdirSync(unit, { recursive: true });
    writeFileSync(
      join(unit, 'conductor-daemon.service'),
      '[Service]\nEnvironment=CONDUCTOR_NODE=/usr/bin/node\n',
    );

    const r = await run(h, v1.script, ['--root', h.root]);
    expect(r.status, r.stderr).toBe(0);
    expectInstalled(h, V1);
    expect(r.stdout).toContain('upgraded in place; enrollment kept');
    // The TS version stays on disk, untouched: rolling back is pointing `current` at it.
    expect(tsFiles.map((f) => readFileSync(join(ts, f), 'utf8'))).toEqual(tsBefore);
    for (const [f, { bytes, mode }] of Object.entries(state)) {
      expect(readFileSync(join(h.root, f), 'utf8'), f).toBe(bytes);
      expect(statSync(join(h.root, f)).mode & 0o777, f).toBe(mode);
    }
    expect(lstatSync(join(h.root, 'bin', 'conductor-daemon')).isSymbolicLink()).toBe(true);
    // The installed service is restarted on the new binary; no enroll.
    expect(calls(h).map((x) => [x.argv, x.token, x.root])).toEqual([
      ['service restart', '<unset>', h.root],
    ]);
  });

  it('the installed launcher execs the current daemon with run', async () => {
    expect((await run(h, v1.script, ['--root', h.root])).status).toBe(0);
    const launched = await sh(
      [join(h.root, 'bin', 'conductor-launch'), '--x'],
      {
        PATH: '/usr/bin:/bin',
        CALLS_LOG: h.calls,
      },
      '',
    );
    expect(launched.status, launched.stderr).toBe(0);
    expect(calls(h).map((x) => x.argv)).toEqual(['run --x']);
  });

  it('a tarball without the launcher aborts and leaves the old version current', async () => {
    expect((await run(h, v1.script, ['--root', h.root])).status).toBe(0);
    const bad = await serve(V3, { launcher: false });
    try {
      const r = await run(h, bad.script, ['--root', h.root]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('has no assets/conductor-launch.sh');
      expectInstalled(h, V1);
      expect(existsSync(join(h.root, 'daemon', V3))).toBe(false);
    } finally {
      await close(bad);
    }
  });

  it('rejects an unknown option', async () => {
    const r = await run(h, v1.script, ['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: install.sh');
  });
});

// The real path, no fake daemon: the Rust daemon built and packaged for this machine
// (scripts/build-daemon-dist.sh), installed by the served script, whose real `conductor-daemon
// enroll` posts to a stub enroll endpoint. The token reaches the daemon only through
// CONDUCTOR_ENROLL_TOKEN (TD-117). It costs a cargo build (the dev profile, which `cargo nextest`
// has usually just built), so it runs only where cargo on PATH meets or exceeds the pinned
// toolchain (rust-toolchain.toml): a system cargo older than the pin (e.g. Homebrew's, without
// rustup) can't build the crates, which is a missing toolchain, not a failure of install.sh.
const hasCargo = cargoMeetsPin();

/** `cargo --version` (run in the repo, so rustup applies the pin) is at least the pinned channel. */
function cargoMeetsPin(): boolean {
  const r = spawnSync('cargo', ['--version'], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) return false;
  const have = /cargo (\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
  const pin = /channel\s*=\s*"(\d+)\.(\d+)(?:\.(\d+))?"/.exec(
    readFileSync(join(REPO, 'rust-toolchain.toml'), 'utf8'),
  );
  if (!have || !pin) return have !== null;
  const v = (m: RegExpExecArray) => [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const [a, b] = [v(have), v(pin)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

describe.skipIf(!runnable || !hasCargo)('install.sh with the real daemon tarball', () => {
  const realWork = mkdtempSync(join(tmpdir(), 'conductor-install-real-'));
  const enrolls: { body: string; contentType: string | undefined }[] = [];
  let server: Server;
  let url: string;
  let script: string;

  beforeAll(async () => {
    const downloads = join(realWork, 'downloads');
    const built = spawnSync('bash', [join(REPO, 'scripts', 'build-daemon-dist.sh'), downloads], {
      env: { ...process.env, CONDUCTOR_BUILD_SHA: 'feed123', CARGO_PROFILE: 'dev' },
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
    const dist = findDaemonDist(downloads);
    expect(dist).not.toBeNull();

    // The "API": only the enroll endpoint.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === API_PATHS.machinesEnroll) {
          enrolls.push({ body, contentType: req.headers['content-type'] });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ machine_id: 'm-real', credential: 'cred-real-secret' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serveDistribution(server, {
      db: { query: () => Promise.resolve() },
      publicUrl: url,
      dist,
      version: dist!.version,
    });
    script = await (await fetch(`${url}/install.sh`)).text();
  }, 600_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(realWork, { recursive: true, force: true });
  });

  it('curl | sh -s -- --token installs and the real enroll saves the credential', async () => {
    work = realWork;
    const h = makeHome({ realUname: true });
    const r = await run(h, script, ['--token', TOKEN, '--root', h.root]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const version = `${workspaceVersion()}+feed123`;
    expect(readlinkSync(join(h.root, 'daemon', 'current'))).toBe(version);
    expectLauncher(h.root);

    expect(enrolls).toHaveLength(1);
    const sent = EnrollRequestSchema.parse(JSON.parse(enrolls[0]!.body));
    expect(sent.token).toBe(TOKEN);
    // The sha is baked into the binary: nothing in the environment sets it.
    expect(sent.daemon_version).toBe(version);

    const machine = JSON.parse(readFileSync(join(h.root, 'machine.json'), 'utf8')) as {
      url: string;
      machine_id: string;
      credential: string;
    };
    expect(machine).toMatchObject({ url, machine_id: 'm-real', credential: 'cred-real-secret' });
    expect(r.stdout + r.stderr).toContain('enrolled as m-real');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain('cred-real-secret');
  }, 60_000);
});

/** The Cargo workspace version, the daemon's own (`[workspace.package] version`). */
function workspaceVersion(): string {
  const toml = readFileSync(join(REPO, 'Cargo.toml'), 'utf8');
  return /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/.exec(toml)![1]!;
}
