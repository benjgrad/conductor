import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PATHS } from '@conductor/shared';
import { SECURITY_HEADERS } from './api/security.js';

// M2-T14 (ADR-0017 §Daemon distribution): the orchestrator serves the daemon it was built with.
// `scripts/build-daemon-tarball.sh` writes conductor-daemon-<version>.tgz + .sha256 into the
// downloads dir; this module finds that build and serves, in front of the API's listeners (like
// web-static), four public read-only routes:
//   GET /install.sh        assets/install.sh.tmpl filled with the public URL, version, SHA-256
//   GET /install.ps1       the same for Windows PowerShell, assets/install.ps1.tmpl (MW-T11)
//   GET /downloads/:file   exactly the built tarball and its .sha256, nothing else
//   GET /healthz           {ok, db, version}; 503 when the DB ping fails
// They skip Fastify's hooks (rate limit, Host check): they are public by design, and nginx's
// general limit_req still applies. `isOutdated` is the pure version check T16/T17 use.

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL('../assets/install.sh.tmpl', import.meta.url));
const WINDOWS_TEMPLATE_PATH = fileURLToPath(new URL('../assets/install.ps1.tmpl', import.meta.url));

export const DOWNLOADS_DIR_ENV = 'CONDUCTOR_DOWNLOADS_DIR';
const DB_PING_TIMEOUT_MS = 2_000;

const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** WHATWG URL accepts `'` and `$` in a host; the script quotes it, so allow only these. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;
const TARBALL_RE = /^conductor-daemon-([0-9A-Za-z.+-]{1,64})\.tgz$/;

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
  /** `<package version>[+<sha>]`, the daemon's own `daemonVersion()` form. */
  version: string;
  /** `conductor-daemon-<version>.tgz` */
  file: string;
  sha256: string;
  /** Absolute path of the tarball. */
  path: string;
}

/**
 * CONDUCTOR_DOWNLOADS_DIR, else the first that exists of `<package>/downloads` (the image:
 * /app/downloads) and `<package>/dist/downloads` (the build script's default output).
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
 * The daemon build in `dir`: a `conductor-daemon-<version>.tgz` whose `.sha256` file matches its
 * content. Null when there is none (dev without a build). With several, the newest by mtime.
 */
export function findDaemonBuild(
  dir: string,
  log: (msg: string) => void = () => {},
): DaemonBuild | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const builds: { build: DaemonBuild; mtime: number }[] = [];
  for (const file of names) {
    const m = TARBALL_RE.exec(file);
    if (!m) continue;
    const path = join(dir, file);
    let expected: string;
    try {
      expected = readFileSync(`${path}.sha256`, 'utf8').trim().split(/\s+/)[0] ?? '';
    } catch {
      log(`${file}: no .sha256 next to it; not served`);
      continue;
    }
    const actual = sha256File(path);
    if (!SHA256_RE.test(expected) || actual !== expected) {
      log(`${file}: SHA-256 does not match ${file}.sha256; not served`);
      continue;
    }
    builds.push({
      build: { version: m[1]!, file, sha256: actual, path },
      mtime: statSync(path).mtimeMs,
    });
  }
  builds.sort((a, b) => b.mtime - a.mtime);
  if (builds.length > 1)
    log(`${builds.length} daemon builds in ${dir}; serving ${builds[0]!.build.file}`);
  const newest = builds[0];
  if (!newest) return null;
  return newest.build;
}

/** The daemon version this orchestrator serves (what `isOutdated` compares against). */
export function servedVersion(build: DaemonBuild | null): string | null {
  return build?.version ?? null;
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

/** Fill the install script template; throws on a value that could break out of its quotes. */
export function renderInstallScript(
  template: string,
  opts: { publicUrl: string; build: DaemonBuild },
): string {
  const { publicUrl, build } = opts;
  if (
    !ORIGIN_RE.test(publicUrl) ||
    !URL.canParse(publicUrl) ||
    new URL(publicUrl).origin !== publicUrl
  ) {
    throw new Error(`public URL ${publicUrl} must be an origin (scheme://host[:port])`);
  }
  if (!VERSION_RE.test(build.version)) throw new Error(`bad daemon version ${build.version}`);
  if (!TARBALL_RE.test(build.file)) throw new Error(`bad daemon tarball name ${build.file}`);
  if (!SHA256_RE.test(build.sha256)) throw new Error(`bad SHA-256 ${build.sha256}`);
  const out = template
    .replaceAll('@@PUBLIC_URL@@', publicUrl)
    .replaceAll('@@VERSION@@', build.version)
    .replaceAll('@@FILE@@', build.file)
    .replaceAll('@@SHA256@@', build.sha256);
  const left = /@@[A-Z0-9_]+@@/.exec(out);
  if (left) throw new Error(`install script template: unknown placeholder ${left[0]}`);
  return out;
}

export interface DistributionOptions {
  /** The DB ping for /healthz (a pg.Pool). */
  db: { query(sql: string): Promise<unknown> };
  /** The public origin daemons enroll against (no trailing slash). */
  publicUrl: string;
  build: DaemonBuild | null;
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
  'no daemon tarball is built: run packages/orchestrator/scripts/build-daemon-tarball.sh ' +
  '(the Docker image builds it)\n';

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
  const { build } = opts;
  const render = (path: string) =>
    build === null
      ? null
      : renderInstallScript(readFileSync(path, 'utf8'), { publicUrl: opts.publicUrl, build });
  // `irm` returns a string for text/plain; PowerShell has no script media type of its own.
  const scripts = new Map<string, { body: string | null; type: string }>([
    [
      API_PATHS.installScript,
      { body: render(opts.templatePath ?? TEMPLATE_PATH), type: 'text/x-shellscript' },
    ],
    [
      API_PATHS.installScriptWindows,
      { body: render(opts.windowsTemplatePath ?? WINDOWS_TEMPLATE_PATH), type: 'text/plain' },
    ],
  ]);
  const files = new Map<string, { path: string; type: string }>();
  if (build !== null) {
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
          NO_BUILD_HINT,
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
      // Never joined into a path: the decoded name must be one of the two built files.
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
