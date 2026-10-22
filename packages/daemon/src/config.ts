import { cpus, homedir, hostname, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { API_PATHS, conductorPort } from '@conductor/shared';

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
  /** Full WS URL, `ws://<host>:<CONDUCTOR_PORT>` + `API_PATHS.daemonWs`. */
  orchestratorUrl: string;
  /** Root dir: shared clones (`repos/`), worktrees (`wt/`), daemon state (`state/`). */
  rootDir: string;
  machineId: string;
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

/**
 * Build the config from env. Variables (all optional):
 * CONDUCTOR_ORCHESTRATOR_URL (else ws://CONDUCTOR_HOST:CONDUCTOR_PORT/ws/daemon),
 * CONDUCTOR_ROOT (~/.conductor), CONDUCTOR_MACHINE_ID (hostname), CONDUCTOR_TAGS (comma list),
 * CONDUCTOR_BUDGET_CPU, CONDUCTOR_BUDGET_MEM_MB, CONDUCTOR_MAX_SESSIONS,
 * CONDUCTOR_MAX_CONCURRENT_BUILDS (2), CONDUCTOR_PORT_POOL ("41000-48999"),
 * CONDUCTOR_PORT_RANGE_SIZE (10), CONDUCTOR_MIN_FREE_MEM_MB (512), CONDUCTOR_WORK_POLL_MS (5000),
 * CONDUCTOR_GIT_NAME, CONDUCTOR_GIT_EMAIL.
 */
export function loadConfig(
  env: Env = process.env,
  facts: MachineFacts = machineFacts(),
): DaemonConfig {
  const host = str(env, 'CONDUCTOR_HOST', '127.0.0.1');
  const orchestratorUrl = str(
    env,
    'CONDUCTOR_ORCHESTRATOR_URL',
    `ws://${host}:${conductorPort(env)}${API_PATHS.daemonWs}`,
  );
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
  const tags = str(env, 'CONDUCTOR_TAGS', '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return {
    orchestratorUrl,
    rootDir: resolve(str(env, 'CONDUCTOR_ROOT', join(facts.home, '.conductor'))),
    machineId: str(env, 'CONDUCTOR_MACHINE_ID', facts.hostname),
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
  };
}
