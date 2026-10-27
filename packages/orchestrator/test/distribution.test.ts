// M2-T14: /install.sh, /downloads/:file, /healthz and the version helpers (ADR-0017 §Daemon
// distribution).
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
  findDaemonBuild,
  isOutdated,
  orchestratorVersion,
  renderInstallScript,
  serveDistribution,
  servedVersion,
  type DaemonBuild,
  type DistributionOptions,
} from '../src/distribution.js';
import { useTestDatabase } from './db.js';

const PUBLIC_URL = 'https://conductor.example.test';
const VERSION = '0.0.0+abc1234';
const FILE = `conductor-daemon-${VERSION}.tgz`;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A downloads dir holding one fake build; returns the dir and the build. */
function fakeDownloads(version = VERSION, content = `tarball ${version}`) {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-downloads-'));
  const file = `conductor-daemon-${version}.tgz`;
  writeFileSync(join(dir, file), content);
  writeFileSync(join(dir, `${file}.sha256`), `${sha256(content)}  ${file}\n`);
  return { dir, file, sha: sha256(content), content };
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

describe('findDaemonBuild', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('finds the build and its SHA-256', () => {
    const f = fakeDownloads();
    dirs.push(f.dir);
    const build = findDaemonBuild(f.dir);
    expect(build).toEqual({
      version: VERSION,
      file: FILE,
      sha256: f.sha,
      path: join(f.dir, FILE),
    });
    expect(servedVersion(build)).toBe(VERSION);
  });

  it('is null without a build, or when the .sha256 does not match', () => {
    const empty = mkdtempSync(join(tmpdir(), 'conductor-downloads-'));
    dirs.push(empty);
    expect(findDaemonBuild(empty)).toBeNull();
    expect(findDaemonBuild(join(empty, 'missing'))).toBeNull();
    expect(servedVersion(null)).toBeNull();

    const f = fakeDownloads();
    dirs.push(f.dir);
    writeFileSync(join(f.dir, FILE), 'tampered');
    const logs: string[] = [];
    expect(findDaemonBuild(f.dir, (m) => logs.push(m))).toBeNull();
    expect(logs.join('\n')).toContain('does not match');
  });

  it('serves the newest of several builds', () => {
    const f = fakeDownloads('0.0.0+aaaaaaa');
    dirs.push(f.dir);
    const newer = 'conductor-daemon-0.0.0+bbbbbbb.tgz';
    writeFileSync(join(f.dir, newer), 'newer');
    writeFileSync(join(f.dir, `${newer}.sha256`), `${sha256('newer')}  ${newer}\n`);
    utimesSync(join(f.dir, f.file), new Date(1_000_000), new Date(1_000_000));
    expect(findDaemonBuild(f.dir)?.file).toBe(newer);
  });
});

describe('renderInstallScript', () => {
  const build: DaemonBuild = {
    version: VERSION,
    file: FILE,
    sha256: 'a'.repeat(64),
    path: '/x',
  };
  const tmpl = "U='@@PUBLIC_URL@@' V='@@VERSION@@' F='@@FILE@@' S='@@SHA256@@'";

  it('fills every placeholder', () => {
    expect(renderInstallScript(tmpl, { publicUrl: PUBLIC_URL, build })).toBe(
      `U='${PUBLIC_URL}' V='${VERSION}' F='${FILE}' S='${'a'.repeat(64)}'`,
    );
  });

  it('refuses values that could break out of their quotes, and unknown placeholders', () => {
    const r =
      (publicUrl: string, b: Partial<DaemonBuild>, t = tmpl) =>
      () =>
        renderInstallScript(t, { publicUrl, build: { ...build, ...b } });
    expect(r(`${PUBLIC_URL}/`, {})).toThrow(/origin/);
    expect(r("https://x.test'$(id)", {})).toThrow();
    expect(r(PUBLIC_URL, { version: "1'; rm -rf ~; '" })).toThrow(/version/);
    expect(r(PUBLIC_URL, { sha256: 'xyz' })).toThrow(/SHA-256/);
    expect(r(PUBLIC_URL, { file: 'evil.tgz' })).toThrow(/tarball/);
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
      build: findDaemonBuild(f.dir),
      version: '0.0.0+abc1234',
    });
  });
  afterAll(async () => {
    await stop(s);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('/install.sh embeds the public URL, the version and the right SHA-256', async () => {
    const r = await get(s.port, '/install.sh');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers[k], k).toBe(v);
    const body = r.body.toString('utf8');
    expect(body.startsWith('#!/bin/sh')).toBe(true);
    expect(body).toContain(`PUBLIC_URL='${PUBLIC_URL}'`);
    expect(body).toContain(`VERSION='${VERSION}'`);
    expect(body).toContain(`FILE='${FILE}'`);
    expect(body).toContain(`SHA256='${f.sha}'`);
    expect(body).not.toMatch(/@@[A-Z0-9_]+@@/);
  });

  it('/downloads serves exactly the tarball and its .sha256', async () => {
    const tgz = await get(s.port, `/downloads/${FILE}`);
    expect(tgz.status).toBe(200);
    expect(tgz.body.toString()).toBe(f.content);
    expect(tgz.headers['content-type']).toBe('application/gzip');
    const enc = await get(s.port, `/downloads/${encodeURIComponent(FILE)}`);
    expect(enc.status).toBe(200);
    const sum = await get(s.port, `/downloads/${FILE}.sha256`);
    expect(sum.status).toBe(200);
    expect(sum.body.toString()).toBe(`${f.sha}  ${FILE}\n`);
    const head = await get(s.port, `/downloads/${FILE}`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(f.content.length));
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
  });
});

describe('serveDistribution without a build (dev)', () => {
  it('/install.sh is 503 with a hint; /downloads is 404', async () => {
    const s = await start({ db: okDb, publicUrl: PUBLIC_URL, build: null, version: '0.0.0' });
    try {
      const r = await get(s.port, '/install.sh');
      expect(r.status).toBe(503);
      expect(r.body.toString()).toContain('build-daemon-tarball.sh');
      expect((await get(s.port, `/downloads/${FILE}`)).status).toBe(404);
    } finally {
      await stop(s);
    }
  });
});

describe('/healthz', () => {
  const db = useTestDatabase();

  it('is 200 {ok, db, version} with a database', async () => {
    const s = await start({
      db: db.pool,
      publicUrl: PUBLIC_URL,
      build: null,
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
    const s = await start({ db: down, publicUrl: PUBLIC_URL, build: null, version: '0.0.0+x' });
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
