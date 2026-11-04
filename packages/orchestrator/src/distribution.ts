import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_PATHS,
  DAEMON_TARBALL_MAX_BYTES,
  DAEMON_TARBALL_RE,
  DAEMON_VERSION_RE,
  daemonTarballMatches,
} from '@conductor/shared';
import { SECURITY_HEADERS } from './api/security.js';

// M2-T14 (ADR-0017 §Daemon distribution), per target since MR-T15 (ADR-0026 §4): the orchestrator
// serves the Rust daemon builds it was built with. CI (.github/workflows/daemon-dist.yml, through
// scripts/package-daemon.sh) writes conductor-daemon-<version>-<target>.tgz + .sha256 for each
// DAEMON_TARGETS entry into the downloads dir; this module finds them and serves, in front of the
// API's listeners (like web-static), four public read-only routes:
//   GET /install.sh        assets/install.sh.tmpl filled with the public URL, the version and every
//                          target's file and SHA-256; it picks one by `uname`
//   GET /install.ps1       the same for Windows PowerShell, assets/install.ps1.tmpl (MW-T11)
//   GET /downloads/:file   exactly the served tarballs and their .sha256 files, nothing else
//   GET /healthz           {ok, db, version}; 503 when the DB ping fails
// They skip Fastify's hooks (rate limit, Host check): they are public by design, and nginx's
// general limit_req still applies. `isOutdated` is the pure version check T16/T17 use;
// `targetFor` maps a machine's `register.os`/`arch` to its build (ADR-0021 `update_available`).

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL('../assets/install.sh.tmpl', import.meta.url));
const WINDOWS_TEMPLATE_PATH = fileURLToPath(new URL('../assets/install.ps1.tmpl', import.meta.url));

export const DOWNLOADS_DIR_ENV = 'CONDUCTOR_DOWNLOADS_DIR';
const DB_PING_TIMEOUT_MS = 2_000;

const SHA256_RE = /^[0-9a-f]{64}$/;
/** WHATWG URL accepts `'` and `$` in a host; the script quotes it, so allow only these. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

/** The Rust targets the daemon ships for (ADR-0026: macOS arm64/x64, Linux x64/arm64, Windows x64). */
export const DAEMON_TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
] as const;
export type DaemonTarget = (typeof DAEMON_TARGETS)[number];
/** The build install.ps1 installs. */
export const WINDOWS_TARGET: DaemonTarget = 'x86_64-pc-windows-msvc';

const TARGET_BY_PLATFORM: Record<string, DaemonTarget> = {
  'darwin/arm64': 'aarch64-apple-darwin',
  'darwin/x64': 'x86_64-apple-darwin',
  'linux/x64': 'x86_64-unknown-linux-gnu',
  'linux/arm64': 'aarch64-unknown-linux-gnu',
  'win32/x64': 'x86_64-pc-windows-msvc',
};

/**
 * The build for a machine's `register.os` / `register.arch` (Node names, which both daemons
 * send: `darwin`/`linux`/`win32`, `x64`/`arm64`); null for a platform no build is made for.
 */
export function targetFor(os: string, arch: string): DaemonTarget | null {
  return TARGET_BY_PLATFORM[`${os}/${arch}`] ?? null;
}

/** `@@FILE_<T>@@` / `@@SHA256_<T>@@`: the target upper-cased, `-` → `_`. */
export function targetPlaceholderKey(target: DaemonTarget): string {
  return target.toUpperCase().replaceAll('-', '_');
}

/** The usable build sha: CONDUCTOR_BUILD_SHA, else CONDUCTOR_GIT_SHA, first 7 chars; or null. */
function buildSha(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.CONDUCTOR_BUILD_SHA || env.CONDUCTOR_GIT_SHA || '').trim();
  if (raw === '' || raw === 'unknown' || !/^[0-9A-Za-z]+$/.test(raw)) return null;
  return raw.slice(0, 7);
}

/** `/healthz`'s version: the orchestrator package version, plus `+<short sha>` when known. */
export function orchestratorVersion(env: NodeJS.ProcessEnv = process.env): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    version: string;
  };
  const sha = buildSha(env);
  return sha === null ? pkg.version : `${pkg.version}+${sha}`;
}

export interface DaemonBuild {
  /** `<workspace version>[+<sha>]`, the daemon's own `--version`. */
  version: string;
  target: DaemonTarget;
  /** `conductor-daemon-<version>-<target>.tgz` */
  file: string;
  sha256: string;
  /** Bytes (`update_available.size`). */
  size: number;
  /** Absolute path of the tarball. */
  path: string;
}

/** Every build of one version, by target; a target may be missing. */
export interface DaemonDist {
  version: string;
  builds: Partial<Record<DaemonTarget, DaemonBuild>>;
}

/**
 * CONDUCTOR_DOWNLOADS_DIR, else the first that exists of `<package>/downloads` (the image:
 * /app/downloads) and `<package>/dist/downloads` (scripts/build-daemon-dist.sh's default output).
 */
export function defaultDownloadsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DOWNLOADS_DIR_ENV]?.trim();
  if (fromEnv) return resolve(fromEnv);
  const candidates = [join(PACKAGE_DIR, 'downloads'), join(PACKAGE_DIR, 'dist', 'downloads')];
  return candidates.find(isDir) ?? candidates[1]!;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * `{version, target}` of a served tarball name, or null. Parsed by the target suffix, because a
 * version may contain `-` (`0.1.0-rc.1+abc1234`).
 */
export function parseTarballName(file: string): { version: string; target: DaemonTarget } | null {
  if (!DAEMON_TARBALL_RE.test(file)) return null;
  for (const target of DAEMON_TARGETS) {
    const suffix = `-${target}.tgz`;
    if (!file.endsWith(suffix)) continue;
    const version = file.slice('conductor-daemon-'.length, -suffix.length);
    if (!DAEMON_VERSION_RE.test(version) || !daemonTarballMatches(file, version)) return null;
    return { version, target };
  }
  return null;
}

/**
 * The daemon builds in `dir`: every `conductor-daemon-<version>-<target>.tgz` whose `.sha256`
 * file matches its content, of one version, the newest tarball's (by mtime). Null when there is
 * none (dev without a build). Logs what it skips and the targets it has no build for.
 */
export function findDaemonDist(
  dir: string,
  log: (msg: string) => void = () => {},
): DaemonDist | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const builds: { build: DaemonBuild; mtime: number }[] = [];
  for (const file of names.sort()) {
    if (!file.startsWith('conductor-daemon-') || !file.endsWith('.tgz')) continue;
    const parsed = parseTarballName(file);
    if (parsed === null) {
      log(`${file}: not conductor-daemon-<version>-<target>.tgz for a known target; not served`);
      continue;
    }
    const path = join(dir, file);
    let expected: string;
    try {
      expected = readFileSync(`${path}.sha256`, 'utf8').trim().split(/\s+/)[0] ?? '';
    } catch {
      log(`${file}: no .sha256 next to it; not served`);
      continue;
    }
    const st = statSync(path);
    if (st.size > DAEMON_TARBALL_MAX_BYTES) {
      log(`${file}: ${st.size} bytes, over the ${DAEMON_TARBALL_MAX_BYTES}-byte cap; not served`);
      continue;
    }
    const actual = sha256File(path);
    if (!SHA256_RE.test(expected) || actual !== expected) {
      log(`${file}: SHA-256 does not match ${file}.sha256; not served`);
      continue;
    }
    builds.push({
      build: { ...parsed, file, sha256: actual, size: st.size, path },
      mtime: st.mtimeMs,
    });
  }
  if (builds.length === 0) return null;
  builds.sort((a, b) => b.mtime - a.mtime);
  const version = builds[0]!.build.version;
  const dist: DaemonDist = { version, builds: {} };
  for (const { build } of builds) {
    if (build.version !== version) {
      log(`${build.file}: not the newest version (${version}); not served`);
      continue;
    }
    if (dist.builds[build.target] === undefined) dist.builds[build.target] = build;
  }
  const missing = DAEMON_TARGETS.filter((t) => dist.builds[t] === undefined);
  if (missing.length > 0) log(`daemon ${version}: no build for ${missing.join(', ')}`);
  return dist;
}

/** One target's build in `dir` (see `findDaemonDist`), or null. */
export function findDaemonBuild(
  dir: string,
  target: DaemonTarget,
  log: (msg: string) => void = () => {},
): DaemonBuild | null {
  return findDaemonDist(dir, log)?.builds[target] ?? null;
}

/** The daemon version this orchestrator serves (what `isOutdated` compares against). */
export function servedVersion(dist: DaemonDist | null): string | null {
  return dist?.version ?? null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Whether a machine's `daemon_version` is behind the served build. Pure; versions are
 * `<semver>[+<sha>]` (the daemon's `daemonVersion()`).
 *
 * | served          | daemon          | outdated |
 * |-----------------|-----------------|----------|
 * | null            | anything        | false (nothing to upgrade to) |
 * | v               | v               | false    |
 * | v               | null / ''       | true     |
 * | 0.2.0+abc       | 0.1.0+abc       | true (lower base) |
 * | 0.1.0+abc       | 0.2.0+def       | false (a newer daemon, e.g. dev) |
 * | 0.1.0+abc       | 0.1.0+def       | true (same base, another build) |
 * | 0.1.0+abc       | 0.1.0           | true (not the served build) |
 * | 0.1.0           | 0.1.0+abc       | false    |
 * | unparseable     | different       | true     |
 */
export function isOutdated(daemon: string | null | undefined, served: string | null): boolean {
  if (served === null || daemon === served) return false;
  if (daemon === null || daemon === undefined || daemon === '') return true;
  const s = SEMVER_RE.exec(served);
  const d = SEMVER_RE.exec(daemon);
  if (!s || !d) return true;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(d[i]) - Number(s[i]);
    if (diff !== 0) return diff < 0;
  }
  const servedSha = s[4];
  const daemonSha = d[4];
  if (servedSha === undefined) return false;
  return daemonSha !== servedSha;
}

/**
 * Fill an install script template: `@@PUBLIC_URL@@`, `@@VERSION@@`, and per target
 * `@@FILE_<T>@@` / `@@SHA256_<T>@@` (`targetPlaceholderKey`), empty for a target with no build.
 * Throws on a value that could break out of its quotes, and on an unknown placeholder.
 */
export function renderInstallScript(
  template: string,
  opts: { publicUrl: string; dist: DaemonDist },
): string {
  const { publicUrl, dist } = opts;
  if (
    !ORIGIN_RE.test(publicUrl) ||
    !URL.canParse(publicUrl) ||
    new URL(publicUrl).origin !== publicUrl
  ) {
    throw new Error(`public URL ${publicUrl} must be an origin (scheme://host[:port])`);
  }
  if (!DAEMON_VERSION_RE.test(dist.version)) throw new Error(`bad daemon version ${dist.version}`);
  let out = template
    .replaceAll('@@PUBLIC_URL@@', publicUrl)
    .replaceAll('@@VERSION@@', dist.version);
  for (const target of DAEMON_TARGETS) {
    const build = dist.builds[target];
    if (build !== undefined) {
      const parsed = parseTarballName(build.file);
      if (parsed === null || parsed.target !== target || parsed.version !== dist.version) {
        throw new Error(`bad daemon tarball name ${build.file}`);
      }
      if (!SHA256_RE.test(build.sha256)) throw new Error(`bad SHA-256 ${build.sha256}`);
    }
    const key = targetPlaceholderKey(target);
    out = out
      .replaceAll(`@@FILE_${key}@@`, build?.file ?? '')
      .replaceAll(`@@SHA256_${key}@@`, build?.sha256 ?? '');
  }
  const left = /@@[A-Z0-9_]+@@/.exec(out);
  if (left) throw new Error(`install script template: unknown placeholder ${left[0]}`);
  return out;
}

export interface DistributionOptions {
  /** The DB ping for /healthz (a pg.Pool). */
  db: { query(sql: string): Promise<unknown> };
  /** The public origin daemons enroll against (no trailing slash). */
  publicUrl: string;
  dist: DaemonDist | null;
  /** `/healthz`'s version (`orchestratorVersion()`). */
  version: string;
  /** Default `assets/install.sh.tmpl`. */
  templatePath?: string;
  /** Default `assets/install.ps1.tmpl`. */
  windowsTemplatePath?: string;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

const DOWNLOADS_PREFIX = API_PATHS.daemonDownload('');

const NO_BUILD_HINT =
  'no daemon tarball is built: run scripts/build-daemon-dist.sh ' +
  '(the Docker image gets every target from CI)\n';
const NO_WINDOWS_BUILD_HINT = `this orchestrator serves no Windows daemon build (${WINDOWS_TARGET})\n`;

async function pingDb(db: DistributionOptions['db']): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.query('select 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), DB_PING_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serve /install.sh, /install.ps1, /downloads/* and /healthz on `server` in front of its existing
 * request listeners (Fastify's). Call once, after the API server is created and before it listens.
 */
export function serveDistribution(server: Server, opts: DistributionOptions): void {
  const { dist } = opts;
  const render = (path: string, required?: DaemonTarget) =>
    dist === null || (required !== undefined && dist.builds[required] === undefined)
      ? null
      : renderInstallScript(readFileSync(path, 'utf8'), { publicUrl: opts.publicUrl, dist });
  // `irm` returns a string for text/plain; PowerShell has no script media type of its own.
  const scripts = new Map<string, { body: string | null; hint: string; type: string }>([
    [
      API_PATHS.installScript,
      {
        body: render(opts.templatePath ?? TEMPLATE_PATH),
        hint: NO_BUILD_HINT,
        type: 'text/x-shellscript',
      },
    ],
    [
      API_PATHS.installScriptWindows,
      {
        body: render(opts.windowsTemplatePath ?? WINDOWS_TEMPLATE_PATH, WINDOWS_TARGET),
        hint: dist === null ? NO_BUILD_HINT : NO_WINDOWS_BUILD_HINT,
        type: 'text/plain',
      },
    ],
  ]);
  const files = new Map<string, { path: string; type: string }>();
  for (const build of Object.values(dist?.builds ?? {})) {
    files.set(build.file, { path: build.path, type: 'application/gzip' });
    files.set(`${build.file}.sha256`, {
      path: `${build.path}.sha256`,
      type: 'text/plain; charset=utf-8',
    });
  }

  const inner = server.listeners('request') as RequestListener[];
  server.removeAllListeners('request');
  const delegate: RequestListener = (req, res) => {
    for (const l of inner) l.call(server, req, res);
  };

  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: Record<string, string | number>,
    body: string,
  ) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'content-length': Buffer.byteLength(body),
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const notFound = (req: IncomingMessage, res: ServerResponse) =>
    send(
      req,
      res,
      404,
      { 'content-type': 'application/json; charset=utf-8' },
      JSON.stringify({ code: 'not_found', message: 'not found' }),
    );

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const rawPath = (req.url ?? '/').split('?')[0]!;
    if (method !== 'GET' && method !== 'HEAD') {
      delegate(req, res);
      return;
    }
    if (rawPath === API_PATHS.healthz) {
      void pingDb(opts.db).then((ok) =>
        send(
          req,
          res,
          ok ? 200 : 503,
          { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          JSON.stringify({ ok, db: ok, version: opts.version }),
        ),
      );
      return;
    }
    const script = scripts.get(rawPath);
    if (script !== undefined) {
      if (script.body === null) {
        send(
          req,
          res,
          503,
          { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          script.hint,
        );
      } else {
        send(
          req,
          res,
          200,
          { 'content-type': `${script.type}; charset=utf-8`, 'cache-control': 'no-store' },
          script.body,
        );
      }
      return;
    }
    if (rawPath.startsWith(DOWNLOADS_PREFIX) || rawPath.startsWith('/downloads%2')) {
      // Never joined into a path: the decoded name must be one of the served files.
      let name: string | null;
      try {
        name = decodeURIComponent(rawPath.slice(DOWNLOADS_PREFIX.length));
      } catch {
        name = null;
      }
      const file = name === null ? undefined : files.get(name);
      if (file === undefined) {
        notFound(req, res);
        return;
      }
      let size: number;
      try {
        size = statSync(file.path).size;
      } catch {
        notFound(req, res);
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': file.type,
        'content-length': size,
        // The name carries the version, so the content never changes.
        'cache-control': 'public, max-age=31536000, immutable',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(file.path)
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }
    delegate(req, res);
  });
}
