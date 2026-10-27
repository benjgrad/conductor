// M2-T14: the rendered /install.sh, run with `sh` the way `curl … | sh -s -- …` runs it, against a
// local orchestrator serving a small fake daemon tarball. HOME and --root are temp dirs; node,
// git and claude are fakes on PATH; the fake conductor-daemon records each call (TD-117: the
// token must arrive in CONDUCTOR_ENROLL_TOKEN, never in argv).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findDaemonBuild, serveDistribution } from '../src/distribution.js';

const hasCmd = (c: string) =>
  spawnSync('sh', ['-c', `command -v ${c}`], { env: { PATH: '/usr/bin:/bin' } }).status === 0;
const runnable =
  ['curl', 'tar', 'mktemp'].every(hasCmd) && (hasCmd('shasum') || hasCmd('sha256sum'));

const TOKEN = 'enroll-tok-3f9a1c2b';
const V1 = '0.0.0+aaaaaaa';
const V2 = '0.0.0+bbbbbbb';

/** The fake daemon: records `argv|token|root` per call; `enroll` writes machine.json. */
const FAKE_DAEMON = `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${CONDUCTOR_ENROLL_TOKEN-<unset>}" "\${CONDUCTOR_ROOT-<unset>}" >>"$CALLS_LOG"
if [ "$1" = enroll ]; then
  printf '{"machine_id":"m-1","credential":"secret"}\\n' >"$CONDUCTOR_ROOT/machine.json"
fi
`;

let work: string;

/** Build a downloads dir with a fake tarball for `version`. */
function buildDownloads(version: string): string {
  const pkg = join(work, `pkg-${version}`);
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'bin', 'conductor-daemon'), FAKE_DAEMON);
  chmodSync(join(pkg, 'bin', 'conductor-daemon'), 0o755);
  writeFileSync(join(pkg, 'VERSION'), version);
  const dir = join(work, `downloads-${version}`);
  mkdirSync(dir, { recursive: true });
  const file = `conductor-daemon-${version}.tgz`;
  const tar = spawnSync('tar', ['-C', pkg, '-czf', join(dir, file), '.']);
  expect(tar.status, tar.stderr.toString()).toBe(0);
  const hex = createHash('sha256')
    .update(readFileSync(join(dir, file)))
    .digest('hex');
  writeFileSync(join(dir, `${file}.sha256`), `${hex}  ${file}\n`);
  return dir;
}

interface Served {
  server: Server;
  url: string;
  script: string;
}

async function serve(version: string): Promise<Served> {
  const build = findDaemonBuild(buildDownloads(version));
  expect(build).not.toBeNull();
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serveDistribution(server, {
    db: { query: () => Promise.resolve() },
    publicUrl: url,
    build,
    version,
  });
  const res = await fetch(`${url}/install.sh`);
  expect(res.status).toBe(200);
  return { server, url, script: await res.text() };
}

const close = (s: Served) => new Promise<void>((r) => s.server.close(() => r()));

/** A temp HOME with fake node/git/claude; `node` prints `nodeVersion`. */
function makeHome(opts: { nodeVersion?: string; without?: string[] } = {}) {
  const home = mkdtempSync(join(work, 'home-'));
  const bin = join(home, 'fakebin');
  mkdirSync(bin);
  const fakes: Record<string, string> = {
    node: `#!/bin/sh\necho ${opts.nodeVersion ?? 'v22.4.0'}\n`,
    git: '#!/bin/sh\necho git version 2.45.0\n',
    claude: '#!/bin/sh\necho 2.1.308\n',
  };
  for (const [name, body] of Object.entries(fakes)) {
    if (opts.without?.includes(name)) continue;
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return { home, bin, root: join(home, 'croot'), calls: join(home, 'calls.log') };
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
    PATH: `${h.bin}:/usr/bin:/bin`,
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

function expectInstalled(h: Home, version: string) {
  expect(existsSync(join(h.root, 'daemon', version, 'bin', 'conductor-daemon'))).toBe(true);
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
    const bad = v1.script.replace(/^SHA256='[0-9a-f]{64}'$/m, `SHA256='${'0'.repeat(64)}'`);
    expect(bad).not.toBe(v1.script);
    const r = await run(h, bad, ['--token', TOKEN, '--root', h.root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SHA-256 mismatch');
    expect(existsSync(h.root)).toBe(false);
    expect(calls(h)).toEqual([]);
  });

  it('node 20 aborts with the message, nothing installed', async () => {
    const old = makeHome({ nodeVersion: 'v20.11.1' });
    const r = await run(old, v1.script, ['--token', TOKEN, '--root', old.root]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Node.js 22 or newer is required (found v20.11.1)');
    expect(existsSync(old.root)).toBe(false);
  });

  it('lists every missing prerequisite at once', async () => {
    const bare = makeHome({ without: ['node', 'claude'] });
    const r = await run(bare, v1.script, ['--root', bare.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('installs none of them');
    expect(r.stderr).toContain('Node.js 22 or newer is required (node is not on PATH)');
    expect(r.stderr).toContain('claude');
    expect(existsSync(bare.root)).toBe(false);
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

  it('rejects an unknown option', async () => {
    const r = await run(h, v1.script, ['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: install.sh');
  });
});
