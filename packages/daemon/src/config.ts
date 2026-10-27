import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, hostname, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  API_PATHS,
  conductorPort,
  isCanonicalRemote,
  WorkingCopyModeSchema,
} from '@conductor/shared';
import {
  credentialPath,
  daemonWsUrl,
  isSecureOrLoopback,
  loadCredential,
  type MachineCredential,
} from './credential.js';

// Daemon configuration (M1-T05; 07 §Compute, §Ports). Everything comes from env vars with
// defaults that work for a single laptop talking to an orchestrator on localhost.

export interface PortPoolConfig {
  /** First port of the pool (inclusive). */
  start: number;
  /** Last port of the pool (inclusive). */
  end: number;
  /** Ports per session range (07: default 10). */
  rangeSize: number;
}

export interface BackoffConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export interface DaemonConfig {
  /**
   * Full WS URL: CONDUCTOR_ORCHESTRATOR_URL, else the enrolled `url` (https → wss) + daemonWs, else
   * `ws://<host>:<CONDUCTOR_PORT>` + `API_PATHS.daemonWs`.
   */
  orchestratorUrl: string;
  /** Root dir: shared clones (`repos/`), worktrees (`wt/`), daemon state (`state/`), `machine.json`. */
  rootDir: string;
  /** The enrolled `machine_id`, else (local mode) CONDUCTOR_MACHINE_ID or the hostname. */
  machineId: string;
  /** The machine credential sent on the WS upgrade (M2-T04); null in local mode. Never logged. */
  credential: string | null;
  /** `register.daemon_version`: the package version, `+<CONDUCTOR_BUILD_SHA>` when set. */
  daemonVersion: string;
  tags: string[];
  /** Advertised CPU budget (cores) after the owner reserve (07). */
  budgetCpu: number;
  /** Advertised memory budget (MB) after the owner reserve (07). */
  budgetMemMb: number;
  maxSessions: number;
  maxConcurrentBuilds: number;
  portPool: PortPoolConfig;
  /** Refuse start_session / run_cmd with `memory_pressure` below this much free memory. */
  minFreeMemMb: number;
  /** Delay before the next request_work after `no_work`. */
  workPollMs: number;
  /** A `work_assignment` holds a slot until its start_session arrives, at most this long. */
  assignmentHoldMs: number;
  /** Heartbeat interval until `registered` says otherwise. */
  heartbeatIntervalMs: number;
  reconnect: BackoffConfig;
  /** After `complete_state` + `turn_end` the daemon calls end(); kill() if still alive after this. */
  endGraceMs: number;
  /** Grace passed to DriverSession.kill (SIGTERM → SIGKILL). */
  killGraceMs: number;
  gitName: string;
  gitEmail: string;
  /** Clone absolute paths / `file://` repos (M1-T14). Default false; the E2E sets it. */
  allowLocalRepos: boolean;
  /** When non-empty, only these remote repo hosts are cloned (M1-T14). Default: any host. */
  allowedRepoHosts: string[];
  /**
   * Claude Code's config dir, where it writes session transcripts (`projects/<cwd-slug>/<id>.jsonl`,
   * ADR-0008). Default: `CLAUDE_CONFIG_DIR`, else `~/.claude` (the agents inherit the daemon's env,
   * so this is the dir they write to).
   */
  claudeConfigDir?: string;
  /**
   * M2-T10: CONDUCTOR_ROOTS (`:`-separated, PATH-like), absolute; null = use `config.json`'s
   * `roots`, which every scan re-reads (so `config roots …` + SIGHUP needs no restart).
   */
  rootsOverride?: string[] | null;
  /**
   * Tests only: CONDUCTOR_TEST_REMOTE_ALIASES (`<path>=<host/org/repo>,…`) gives local test repos
   * a canonical remote in the inventory. Parsed only with allowLocalRepos, else empty.
   */
  testRemoteAliases?: Record<string, string>;
  /** The inventory rescan interval (ADR-0013: 10 minutes). */
  inventoryIntervalMs?: number;
}

type Env = Record<string, string | undefined>;

/** Defaults: 1 core / 2 GB reserved per session (07), 25 % owner reserve on the machine. */
export const OWNER_RESERVE = 0.25;
export const SESSION_CPU = 1;
export const SESSION_MEM_MB = 2048;

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${name}=${raw} is not an integer >= ${min}`);
  return n;
}

function str(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function list(env: Env, name: string): string[] {
  return str(env, name, '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name}=${raw} is not a boolean (1/0, true/false)`);
}

/**
 * `<root>/config.json` (M2-T10, `conductor-daemon config`): the repo roots the inventory scans and
 * the per-repo working-copy mode (U-060; default `reference`). Written 0600.
 */
export const DaemonFileConfigSchema = z.object({
  roots: z.array(z.string().min(1)).default([]),
  repos: z.record(z.string(), z.object({ mode: WorkingCopyModeSchema })).default({}),
});
export type DaemonFileConfig = z.infer<typeof DaemonFileConfigSchema>;

export function fileConfigPath(rootDir: string): string {
  return join(rootDir, 'config.json');
}

/** `<root>/config.json`, or the defaults when it doesn't exist. Throws (naming the file) if invalid. */
export function readFileConfig(rootDir: string): DaemonFileConfig {
  const path = fileConfigPath(rootDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DaemonFileConfigSchema.parse({});
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = DaemonFileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path} is invalid: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
  }
  return parsed.data;
}

/** Write `<root>/config.json` atomically, mode 0600. Returns its path. */
export function writeFileConfig(rootDir: string, cfg: DaemonFileConfig): string {
  const data = DaemonFileConfigSchema.parse(cfg);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const path = fileConfigPath(rootDir);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
}

/** CONDUCTOR_ROOTS (`:`-separated), resolved; null when unset. */
export function rootsFromEnv(env: Env): string[] | null {
  const raw = env.CONDUCTOR_ROOTS;
  if (raw === undefined || raw.trim() === '') return null;
  return raw
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => resolve(p));
}

/** CONDUCTOR_TEST_REMOTE_ALIASES `<path>=<host/org/repo>,…`; throws on a bad entry. */
export function parseRemoteAliases(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    const eq = item.lastIndexOf('=');
    const path = eq > 0 ? item.slice(0, eq) : '';
    const remote = eq > 0 ? item.slice(eq + 1) : '';
    if (path === '' || !isCanonicalRemote(remote)) {
      throw new Error(
        `CONDUCTOR_TEST_REMOTE_ALIASES entry ${JSON.stringify(item)} is not <path>=<host/org/repo>`,
      );
    }
    out[resolve(path)] = remote;
  }
  return out;
}

export interface MachineFacts {
  cpuTotal: number;
  memTotalMb: number;
  hostname: string;
  home: string;
}

export function machineFacts(): MachineFacts {
  return {
    cpuTotal: cpus().length,
    memTotalMb: Math.floor(totalmem() / (1024 * 1024)),
    hostname: hostname(),
    home: homedir(),
  };
}

/** `<root>`: CONDUCTOR_ROOT, default `~/.conductor`. */
export function rootDirFrom(env: Env, facts: Pick<MachineFacts, 'home'>): string {
  return resolve(str(env, 'CONDUCTOR_ROOT', join(facts.home, '.conductor')));
}

let packageVersion: string | undefined;

/**
 * The daemon version: package.json's version, plus `+<CONDUCTOR_BUILD_SHA>` when set. Read at
 * runtime: `src/` (vitest) and `dist/` (the bin) are both one level under the package root.
 */
export function daemonVersion(env: Env = process.env): string {
  packageVersion ??= (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  const sha = str(env, 'CONDUCTOR_BUILD_SHA', '');
  return sha === '' ? packageVersion : `${packageVersion}+${sha}`;
}

/**
 * Build the config from env. Variables (all optional):
 * CONDUCTOR_ORCHESTRATOR_URL (else ws://CONDUCTOR_HOST:CONDUCTOR_PORT/ws/daemon),
 * CONDUCTOR_ROOT (~/.conductor), CONDUCTOR_MACHINE_ID (hostname), CONDUCTOR_TAGS (comma list),
 * CONDUCTOR_BUDGET_CPU, CONDUCTOR_BUDGET_MEM_MB, CONDUCTOR_MAX_SESSIONS,
 * CONDUCTOR_MAX_CONCURRENT_BUILDS (2), CONDUCTOR_PORT_POOL ("41000-48999"),
 * CONDUCTOR_PORT_RANGE_SIZE (10), CONDUCTOR_MIN_FREE_MEM_MB (512), CONDUCTOR_WORK_POLL_MS (5000),
 * CONDUCTOR_GIT_NAME, CONDUCTOR_GIT_EMAIL, CONDUCTOR_ALLOW_LOCAL_REPOS (1/true; default off),
 * CONDUCTOR_ALLOWED_REPO_HOSTS (comma list; default any host), CLAUDE_CONFIG_DIR (~/.claude;
 * where Claude Code writes transcripts, ADR-0008), CONDUCTOR_BUILD_SHA (appended to daemon_version),
 * CONDUCTOR_ROOTS (`:`-separated repo roots for the inventory; overrides `<root>/config.json`),
 * CONDUCTOR_TEST_REMOTE_ALIASES (tests only, with CONDUCTOR_ALLOW_LOCAL_REPOS; ignored without).
 * When `<root>/machine.json` exists (M2-T04 `enroll`), its `machine_id` replaces
 * CONDUCTOR_MACHINE_ID, its `url` is the default orchestrator URL, and its credential is sent on
 * the WS upgrade; the orchestrator URL must then be wss:// (plain ws:// only to a loopback host).
 */
export function loadConfig(
  env: Env = process.env,
  facts: MachineFacts = machineFacts(),
  readCredential: (rootDir: string) => MachineCredential | null = loadCredential,
): DaemonConfig {
  const rootDir = rootDirFrom(env, facts);
  const cred = readCredential(rootDir);
  const host = str(env, 'CONDUCTOR_HOST', '127.0.0.1');
  const orchestratorUrl = str(
    env,
    'CONDUCTOR_ORCHESTRATOR_URL',
    cred ? daemonWsUrl(cred.url) : `ws://${host}:${conductorPort(env)}${API_PATHS.daemonWs}`,
  );
  // An enrolled daemon never sends its credential in cleartext off this machine.
  if (cred) {
    const source =
      env.CONDUCTOR_ORCHESTRATOR_URL !== undefined && env.CONDUCTOR_ORCHESTRATOR_URL !== ''
        ? 'CONDUCTOR_ORCHESTRATOR_URL'
        : `the url in ${credentialPath(rootDir)}`;
    if (!URL.canParse(orchestratorUrl) || !isSecureOrLoopback(new URL(orchestratorUrl))) {
      throw new Error(
        `${source} (${orchestratorUrl}) is not wss://: refusing to send the machine ` +
          'credential in cleartext (plain ws:// is allowed only to a loopback host)',
      );
    }
  }
  const budgetCpu = int(
    env,
    'CONDUCTOR_BUDGET_CPU',
    Math.max(1, Math.floor(facts.cpuTotal * (1 - OWNER_RESERVE))),
  );
  const budgetMemMb = int(
    env,
    'CONDUCTOR_BUDGET_MEM_MB',
    Math.max(SESSION_MEM_MB, Math.floor(facts.memTotalMb * (1 - OWNER_RESERVE))),
  );
  const maxSessions = int(
    env,
    'CONDUCTOR_MAX_SESSIONS',
    Math.max(
      1,
      Math.min(Math.floor(budgetCpu / SESSION_CPU), Math.floor(budgetMemMb / SESSION_MEM_MB)),
    ),
  );
  const pool = str(env, 'CONDUCTOR_PORT_POOL', '41000-48999');
  const m = /^(\d+)-(\d+)$/.exec(pool);
  if (!m) throw new Error(`CONDUCTOR_PORT_POOL=${pool} is not "<start>-<end>"`);
  const portPool: PortPoolConfig = {
    start: Number(m[1]),
    end: Number(m[2]),
    rangeSize: int(env, 'CONDUCTOR_PORT_RANGE_SIZE', 10, 1),
  };
  if (
    portPool.start < 1 ||
    portPool.end > 65535 ||
    portPool.end - portPool.start + 1 < portPool.rangeSize
  ) {
    throw new Error(`CONDUCTOR_PORT_POOL=${pool} cannot hold one range of ${portPool.rangeSize}`);
  }
  const tags = list(env, 'CONDUCTOR_TAGS');
  const allowLocalRepos = bool(env, 'CONDUCTOR_ALLOW_LOCAL_REPOS', false);
  return {
    orchestratorUrl,
    rootDir,
    machineId: cred ? cred.machine_id : str(env, 'CONDUCTOR_MACHINE_ID', facts.hostname),
    credential: cred?.credential ?? null,
    daemonVersion: daemonVersion(env),
    tags,
    budgetCpu,
    budgetMemMb,
    maxSessions,
    maxConcurrentBuilds: int(env, 'CONDUCTOR_MAX_CONCURRENT_BUILDS', 2, 1),
    portPool,
    minFreeMemMb: int(env, 'CONDUCTOR_MIN_FREE_MEM_MB', 512),
    workPollMs: int(env, 'CONDUCTOR_WORK_POLL_MS', 5000, 1),
    assignmentHoldMs: 60_000,
    heartbeatIntervalMs: 10_000,
    reconnect: { initialMs: 500, maxMs: 30_000, factor: 2 },
    endGraceMs: 10_000,
    killGraceMs: 5_000,
    gitName: str(env, 'CONDUCTOR_GIT_NAME', 'conductor'),
    gitEmail: str(env, 'CONDUCTOR_GIT_EMAIL', 'conductor@localhost'),
    allowLocalRepos,
    allowedRepoHosts: list(env, 'CONDUCTOR_ALLOWED_REPO_HOSTS').map((h) => h.toLowerCase()),
    claudeConfigDir: resolve(str(env, 'CLAUDE_CONFIG_DIR', join(facts.home, '.claude'))),
    rootsOverride: rootsFromEnv(env),
    testRemoteAliases: allowLocalRepos
      ? parseRemoteAliases(str(env, 'CONDUCTOR_TEST_REMOTE_ALIASES', ''))
      : {},
    inventoryIntervalMs: 10 * 60_000,
  };
}
