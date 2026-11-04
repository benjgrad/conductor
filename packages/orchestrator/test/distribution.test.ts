// M2-T14: /install.sh, /downloads/:file, /healthz and the version helpers (ADR-0017 §Daemon
// distribution); per target since MR-T15 (ADR-0026 §4).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../src/api/security.js';
import {
  DAEMON_TARGETS,
  findDaemonBuild,
  findDaemonDist,
  isOutdated,
  orchestratorVersion,
  parseTarballName,
  renderInstallScript,
  serveDistribution,
  servedVersion,
  targetFor,
  targetPlaceholderKey,
  type DaemonDist,
  type DaemonTarget,
  type DistributionOptions,
} from '../src/distribution.js';
import { useTestDatabase } from './db.js';

const PUBLIC_URL = 'https://conductor.example.test';
const VERSION = '0.0.0+abc1234';
const LINUX: DaemonTarget = 'x86_64-unknown-linux-gnu';
const WINDOWS: DaemonTarget = 'x86_64-pc-windows-msvc';
const fileFor = (target: DaemonTarget, version = VERSION) =>
  `conductor-daemon-${version}-${target}.tgz`;
const FILE = fileFor(LINUX);

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Write one fake build of `target` into `dir`; returns its file name and SHA-256. */
function writeBuild(dir: string, target: DaemonTarget, version = VERSION) {
  const file = fileFor(target, version);
  const content = `tarball ${version} ${target}`;
  writeFileSync(join(dir, file), content);
  writeFileSync(join(dir, `${file}.sha256`), `${sha256(content)}  ${file}\n`);
  return { file, sha: sha256(content), content };
}

/** A downloads dir holding a fake build of each of `targets` (default: all). */
function fakeDownloads(version = VERSION, targets: readonly DaemonTarget[] = DAEMON_TARGETS) {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-downloads-'));
  const builds = Object.fromEntries(targets.map((t) => [t, writeBuild(dir, t, version)]));
  return { dir, builds: builds as Record<DaemonTarget, ReturnType<typeof writeBuild>> };
}

const PKG_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

interface Started {
  server: Server;
  port: number;
}

async function start(opts: DistributionOptions): Promise<Started> {
  const server = createServer((_req, res) => {
    res.writeHead(418, { 'content-type': 'text/plain' });
    res.end('api');
  });
  serveDistribution(server, opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

const stop = (s: Started) => new Promise<void>((r) => s.server.close(() => r()));

/** A raw request: the path goes on the wire as written (no `..` normalisation). */
const get = (port: number, path: string, method = 'GET') =>
  new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      request({ host: '127.0.0.1', port, path, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          }),
        );
      })
        .on('error', reject)
        .end();
    },
  );

const okDb: DistributionOptions['db'] = { query: () => Promise.resolve({ rows: [] }) };

describe('isOutdated', () => {
  it.each([
    ['0.1.0+abc', null, false],
    [null, null, false],
    ['0.1.0+abc', '0.1.0+abc', false],
    [null, '0.1.0+abc', true],
    ['', '0.1.0+abc', true],
    [undefined, '0.1.0+abc', true],
    ['0.1.0+abc', '0.2.0+abc', true],
    ['0.1.9+abc', '0.2.0+abc', true],
    ['0.2.0+def', '0.1.0+abc', false],
    ['1.0.0+def', '0.9.9+abc', false],
    ['0.1.0+def', '0.1.0+abc', true],
    ['0.1.0', '0.1.0+abc', true],
    ['0.1.0+abc', '0.1.0', false],
    ['garbage', '0.1.0+abc', true],
  ] as const)('daemon %s, served %s → %s', (daemon, served, want) => {
    expect(isOutdated(daemon, served)).toBe(want);
  });
});

describe('orchestratorVersion', () => {
  it('is the package version, plus the short sha when known', () => {
    expect(orchestratorVersion({})).toBe(PKG_VERSION);
    expect(orchestratorVersion({ CONDUCTOR_GIT_SHA: 'unknown' })).toBe(PKG_VERSION);
    expect(orchestratorVersion({ CONDUCTOR_GIT_SHA: '32e6bb8d0f1e2a3b4c5d' })).toBe(
      `${PKG_VERSION}+32e6bb8`,
    );
    expect(
      orchestratorVersion({ CONDUCTOR_BUILD_SHA: 'abc1234', CONDUCTOR_GIT_SHA: 'def5678' }),
    ).toBe(`${PKG_VERSION}+abc1234`);
  });
});

describe('targetFor', () => {
  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    ['win32', 'arm64', null],
    ['linux', 'ia32', null],
    ['freebsd', 'x64', null],
    ['', '', null],
  ])('%s/%s → %s', (os, arch, want) => {
    expect(targetFor(os, arch)).toBe(want);
  });

  it('maps onto every served target exactly once', () => {
    const mapped = ['darwin/arm64', 'darwin/x64', 'linux/x64', 'linux/arm64', 'win32/x64'].map(
      (p) => targetFor(p.split('/')[0]!, p.split('/')[1]!),
    );
    expect([...mapped].sort()).toEqual([...DAEMON_TARGETS].sort());
  });
});

describe('parseTarballName', () => {
  it('splits by the target suffix, so a version may contain -', () => {
    expect(parseTarballName(FILE)).toEqual({ version: VERSION, target: LINUX });
    expect(parseTarballName(fileFor('aarch64-apple-darwin', '0.1.0-rc.1+abc1234'))).toEqual({
      version: '0.1.0-rc.1+abc1234',
      target: 'aarch64-apple-darwin',
    });
  });

  it('is null for the legacy TS name, an unknown target or a bad name', () => {
    expect(parseTarballName(`conductor-daemon-${VERSION}.tgz`)).toBeNull();
    expect(
      parseTarballName(`conductor-daemon-${VERSION}-riscv64gc-unknown-linux-gnu.tgz`),
    ).toBeNull();
    expect(parseTarballName(`conductor-daemon--${LINUX}.tgz`)).toBeNull();
    expect(parseTarballName(`conductor-daemon-a/b-${LINUX}.tgz`)).toBeNull();
    expect(parseTarballName(`${FILE}.sha256`)).toBeNull();
  });
});

describe('findDaemonDist', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('finds every target and its SHA-256, size and path', () => {
    const f = fakeDownloads();
    dirs.push(f.dir);
    const logs: string[] = [];
    const dist = findDaemonDist(f.dir, (m) => logs.push(m));
    expect(dist?.version).toBe(VERSION);
    expect(Object.keys(dist!.builds).sort()).toEqual([...DAEMON_TARGETS].sort());
    expect(dist!.builds[LINUX]).toEqual({
      version: VERSION,
      target: LINUX,
      file: FILE,
      sha256: f.builds[LINUX].sha,
      size: f.builds[LINUX].content.length,
      path: join(f.dir, FILE),
    });
    expect(servedVersion(dist)).toBe(VERSION);
    expect(logs).toEqual([]);
    expect(findDaemonBuild(f.dir, WINDOWS)?.file).toBe(fileFor(WINDOWS));
  });

  it('is null without a build; logs the targets it has no build for', () => {
    const empty = mkdtempSync(join(tmpdir(), 'conductor-downloads-'));
    dirs.push(empty);
    expect(findDaemonDist(empty)).toBeNull();
    expect(findDaemonDist(join(empty, 'missing'))).toBeNull();
    expect(findDaemonBuild(empty, LINUX)).toBeNull();
    expect(servedVersion(null)).toBeNull();

    const f = fakeDownloads(VERSION, [LINUX]);
    dirs.push(f.dir);
    const logs: string[] = [];
    const dist = findDaemonDist(f.dir, (m) => logs.push(m));
    expect(Object.keys(dist!.builds)).toEqual([LINUX]);
    expect(logs.join('\n')).toContain('no build for aarch64-apple-darwin');
    expect(findDaemonBuild(f.dir, WINDOWS)).toBeNull();
  });

  it('drops only the target whose .sha256 does not match, or is missing', () => {
    const f = fakeDownloads();
    dirs.push(f.dir);
    writeFileSync(join(f.dir, fileFor(WINDOWS)), 'tampered');
    rmSync(join(f.dir, `${fileFor('aarch64-apple-darwin')}.sha256`));
    const logs: string[] = [];
    const dist = findDaemonDist(f.dir, (m) => logs.push(m));
    expect(dist!.builds[WINDOWS]).toBeUndefined();
    expect(dist!.builds['aarch64-apple-darwin']).toBeUndefined();
    expect(dist!.builds[LINUX]?.file).toBe(FILE);
    expect(logs.join('\n')).toContain('does not match');
    expect(logs.join('\n')).toContain('no .sha256');
  });

  it('serves the newest version only, and ignores the legacy TS tarball', () => {
    const f = fakeDownloads('0.0.0+aaaaaaa');
    dirs.push(f.dir);
    for (const b of Object.values(f.builds)) {
      utimesSync(join(f.dir, b.file), new Date(1_000_000), new Date(1_000_000));
    }
    const newer = writeBuild(f.dir, LINUX, '0.0.0+bbbbbbb');
    const legacy = 'conductor-daemon-0.0.0+ccccccc.tgz';
    writeFileSync(join(f.dir, legacy), 'node');
    writeFileSync(join(f.dir, `${legacy}.sha256`), `${sha256('node')}  ${legacy}\n`);
    const logs: string[] = [];
    const dist = findDaemonDist(f.dir, (m) => logs.push(m));
    expect(dist?.version).toBe('0.0.0+bbbbbbb');
    expect(Object.keys(dist!.builds)).toEqual([LINUX]);
    expect(dist!.builds[LINUX]?.file).toBe(newer.file);
    expect(logs.join('\n')).toContain('not the newest version');
    expect(logs.join('\n')).toContain(`${legacy}: not conductor-daemon-<version>-<target>.tgz`);
  });
});

describe('renderInstallScript', () => {
  const build = (target: DaemonTarget, sha = 'a'.repeat(64)) => ({
    version: VERSION,
    target,
    file: fileFor(target),
    sha256: sha,
    size: 1,
    path: '/x',
  });
  const dist: DaemonDist = {
    version: VERSION,
    builds: { [LINUX]: build(LINUX), [WINDOWS]: build(WINDOWS, 'b'.repeat(64)) },
  };
  const tmpl =
    "U='@@PUBLIC_URL@@' V='@@VERSION@@' " +
    DAEMON_TARGETS.map((t) => {
      const k = targetPlaceholderKey(t);
      return `F_${k}='@@FILE_${k}@@' S_${k}='@@SHA256_${k}@@'`;
    }).join(' ');

  it('fills every placeholder; a target with no build is empty', () => {
    const out = renderInstallScript(tmpl, { publicUrl: PUBLIC_URL, dist });
    expect(out).toContain(`U='${PUBLIC_URL}' V='${VERSION}' `);
    expect(out).toContain(
      `F_X86_64_UNKNOWN_LINUX_GNU='${FILE}' S_X86_64_UNKNOWN_LINUX_GNU='${'a'.repeat(64)}'`,
    );
    expect(out).toContain(
      `F_X86_64_PC_WINDOWS_MSVC='${fileFor(WINDOWS)}' S_X86_64_PC_WINDOWS_MSVC='${'b'.repeat(64)}'`,
    );
    expect(out).toContain(`F_AARCH64_APPLE_DARWIN='' S_AARCH64_APPLE_DARWIN=''`);
    expect(out).not.toMatch(/@@/);
  });

  it('refuses values that could break out of their quotes, and unknown placeholders', () => {
    const r =
      (publicUrl: string, d: Partial<DaemonDist>, t = tmpl) =>
      () =>
        renderInstallScript(t, { publicUrl, dist: { ...dist, ...d } });
    const linux = (b: Partial<ReturnType<typeof build>>) => ({
      [LINUX]: { ...build(LINUX), ...b },
    });
    expect(r(`${PUBLIC_URL}/`, {})).toThrow(/origin/);
    expect(r("https://x.test'$(id)", {})).toThrow();
    expect(r(PUBLIC_URL, { version: "1'; rm -rf ~; '" })).toThrow(/version/);
    expect(r(PUBLIC_URL, { builds: linux({ sha256: 'xyz' }) })).toThrow(/SHA-256/);
    expect(r(PUBLIC_URL, { builds: linux({ file: 'evil.tgz' }) })).toThrow(/tarball/);
    expect(r(PUBLIC_URL, { builds: linux({ file: fileFor(WINDOWS) }) })).toThrow(/tarball/);
    expect(r(PUBLIC_URL, { builds: linux({ file: fileFor(LINUX, '9.9.9') }) })).toThrow(/tarball/);
    expect(r(PUBLIC_URL, {}, `${tmpl} @@NOPE@@`)).toThrow(/NOPE/);
  });
});

describe('serveDistribution with a build', () => {
  let f: ReturnType<typeof fakeDownloads>;
  let s: Started;

  beforeAll(async () => {
    f = fakeDownloads();
    s = await start({
      db: okDb,
      publicUrl: PUBLIC_URL,
      dist: findDaemonDist(f.dir),
      version: '0.0.0+abc1234',
    });
  });
  afterAll(async () => {
    await stop(s);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it("/install.sh embeds the public URL, the version and every target's file and SHA-256", async () => {
    const r = await get(s.port, '/install.sh');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers[k], k).toBe(v);
    const body = r.body.toString('utf8');
    expect(body.startsWith('#!/bin/sh')).toBe(true);
    expect(body).toContain(`PUBLIC_URL='${PUBLIC_URL}'`);
    expect(body).toContain(`VERSION='${VERSION}'`);
    for (const t of DAEMON_TARGETS.filter((x) => x !== WINDOWS)) {
      const k = targetPlaceholderKey(t);
      expect(body, t).toContain(`FILE_${k}='${fileFor(t)}'`);
      expect(body, t).toContain(`SHA256_${k}='${f.builds[t].sha}'`);
    }
    expect(body).not.toMatch(/@@[A-Z0-9_]+@@/);
    // The native daemon needs no Node (MR-T15).
    expect(body).not.toMatch(/command -v node|FindApp 'node'|Node\.js 22/);
  });

  it('/install.ps1 is the PowerShell installer, filled in the same way (MW-T11)', async () => {
    const r = await get(s.port, '/install.ps1');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers[k], k).toBe(v);
    const body = r.body.toString('utf8');
    expect(body).toContain(`$PublicUrl = '${PUBLIC_URL}'`);
    expect(body).toContain(`$Version = '${VERSION}'`);
    expect(body).toContain(`$File = '${fileFor(WINDOWS)}'`);
    expect(body).toContain(`$Sha256 = '${f.builds[WINDOWS].sha}'`);
    expect(body).not.toMatch(/command -v node|FindApp 'node'|Node\.js 22/);
    expect(body).not.toMatch(/@@[A-Z0-9_]+@@/);
    // Windows PowerShell 5.1 decodes by the charset; keep the script ASCII anyway.
    expect(/[^\t\n\r -~]/.test(body)).toBe(false);
    // irm | iex runs it in the caller's session: `exit` would close their window.
    expect(body).not.toMatch(/^\s*exit\b/m);
  });

  it('/downloads serves exactly the tarballs and their .sha256 files', async () => {
    for (const t of DAEMON_TARGETS) {
      const r = await get(s.port, `/downloads/${fileFor(t)}`);
      expect(r.status, t).toBe(200);
      expect(r.body.toString(), t).toBe(f.builds[t].content);
      expect((await get(s.port, `/downloads/${fileFor(t)}.sha256`)).status, t).toBe(200);
    }
    const tgz = await get(s.port, `/downloads/${FILE}`);
    expect(tgz.status).toBe(200);
    expect(tgz.body.toString()).toBe(f.builds[LINUX].content);
    expect(tgz.headers['content-type']).toBe('application/gzip');
    const enc = await get(s.port, `/downloads/${encodeURIComponent(FILE)}`);
    expect(enc.status).toBe(200);
    const sum = await get(s.port, `/downloads/${FILE}.sha256`);
    expect(sum.status).toBe(200);
    expect(sum.body.toString()).toBe(`${f.builds[LINUX].sha}  ${FILE}\n`);
    const head = await get(s.port, `/downloads/${FILE}`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(f.builds[LINUX].content.length));
  });

  it('/downloads answers 404 for anything else, traversal included', async () => {
    for (const path of [
      '/downloads/../../etc/passwd',
      '/downloads/..%2f..%2fetc%2fpasswd',
      '/downloads/%2e%2e/%2e%2e/etc/passwd',
      '/downloads%2f..%2f..%2fetc%2fpasswd',
      '/downloads/other.tgz',
      '/downloads/',
      `/downloads/${FILE}/x`,
      '/downloads/%E0%A4%A',
    ]) {
      const r = await get(s.port, path);
      expect(r.status, path).toBe(404);
      expect(r.body.toString(), path).not.toContain('root:');
    }
  });

  it('leaves everything else to the API', async () => {
    expect((await get(s.port, '/api/board')).status).toBe(418);
    expect((await get(s.port, '/install.sh', 'POST')).status).toBe(418);
    expect((await get(s.port, '/install.ps1', 'POST')).status).toBe(418);
  });
});

describe('serveDistribution without a build (dev)', () => {
  it('/install.sh and /install.ps1 are 503 with a hint; /downloads is 404', async () => {
    const s = await start({ db: okDb, publicUrl: PUBLIC_URL, dist: null, version: '0.0.0' });
    try {
      for (const path of ['/install.sh', '/install.ps1']) {
        const r = await get(s.port, path);
        expect(r.status, path).toBe(503);
        expect(r.body.toString(), path).toContain('scripts/build-daemon-dist.sh');
      }
      expect((await get(s.port, `/downloads/${FILE}`)).status).toBe(404);
    } finally {
      await stop(s);
    }
  });

  it('without a Windows build, only /install.ps1 is 503, naming the missing target', async () => {
    const f = fakeDownloads(VERSION, [LINUX]);
    const s = await start({
      db: okDb,
      publicUrl: PUBLIC_URL,
      dist: findDaemonDist(f.dir),
      version: '0.0.0',
    });
    try {
      expect((await get(s.port, '/install.sh')).status).toBe(200);
      const ps1 = await get(s.port, '/install.ps1');
      expect(ps1.status).toBe(503);
      expect(ps1.body.toString()).toContain(WINDOWS);
      expect((await get(s.port, `/downloads/${fileFor(WINDOWS)}`)).status).toBe(404);
    } finally {
      await stop(s);
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('/healthz', () => {
  const db = useTestDatabase();

  it('is 200 {ok, db, version} with a database', async () => {
    const s = await start({
      db: db.pool,
      publicUrl: PUBLIC_URL,
      dist: null,
      version: '0.0.0+abc1234',
    });
    try {
      const r = await get(s.port, '/healthz');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(r.body.toString())).toEqual({
        ok: true,
        db: true,
        version: '0.0.0+abc1234',
      });
    } finally {
      await stop(s);
    }
  });

  it('is 503 when the database is unreachable', async () => {
    // Port 1: nothing listens there, the connection is refused.
    const down = new pg.Pool({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      connectionTimeoutMillis: 1_000,
    });
    down.on('error', () => {});
    const s = await start({ db: down, publicUrl: PUBLIC_URL, dist: null, version: '0.0.0+x' });
    try {
      const r = await get(s.port, '/healthz');
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body.toString())).toEqual({ ok: false, db: false, version: '0.0.0+x' });
    } finally {
      await stop(s);
      await down.end();
    }
  });
});
