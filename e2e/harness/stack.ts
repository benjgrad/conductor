// The E2E stack (M1-T10): a fresh Postgres database (packages/orchestrator/test/db.ts), the real
// `conductor-orchestrator` bin on an ephemeral port, and one real `conductor-daemon` bin, each a
// child process with its log in the run's temp dir. The daemon is the Rust release binary
// (MR-T16, ADR-0026) unless CONDUCTOR_E2E_DAEMON_BIN names another one (the TS build,
// packages/daemon/dist/main.js, until MR-T18b). The daemon drives the fake `claude`
// (packages/daemon/test/fixtures/fake-claude.mjs, via a symlink inside the temp dir so leftover
// processes can be found by path) unless the run uses the real CLI.
//
// Windows (MR-T16b): the daemon runs only a native claude.exe (U-110) and a `.cmd` can't carry
// `gh pr create`'s multi-line --body, so both fakes are copies of the native launcher
// (crates/conductor-e2e-launcher) in the temp dir, each with a `<name>.launch` sidecar naming
// node and the fake's script. Teardown uses taskkill and a Win32_Process listing (harness/procs.ts)
// instead of pgrep. Stopping a child there is TerminateProcess, so the daemon gets no graceful
// shutdown: its Job Objects (KILL_ON_JOB_CLOSE) take its Claude processes down with it.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '../../packages/orchestrator/test/db.js';
import { findProcesses, killTree } from './procs.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ORCHESTRATOR_BIN = join(REPO_ROOT, 'packages/orchestrator/dist/bin.js');
/** The Rust daemon `e2e/run.sh` builds (`cargo build --release -p conductor-daemon`). */
export const RUST_DAEMON_BIN = join(
  REPO_ROOT,
  'target/release',
  process.platform === 'win32' ? 'conductor-daemon.exe' : 'conductor-daemon',
);
/**
 * The daemon the stack runs: CONDUCTOR_E2E_DAEMON_BIN (relative to the repo root unless absolute)
 * or the Rust release binary. Read here, at load: `spawn` strips every CONDUCTOR_* from the
 * children's env, so the daemon never sees it.
 */
export const DAEMON_BIN = daemonBin(process.env.CONDUCTOR_E2E_DAEMON_BIN);

/** CONDUCTOR_E2E_DAEMON_BIN → the daemon path; unset or empty → the Rust release binary. */
export function daemonBin(override: string | undefined): string {
  if (!override) return RUST_DAEMON_BIN;
  return isAbsolute(override) ? override : resolve(REPO_ROOT, override);
}

/** A `.js`/`.mjs` bin runs under this Node; anything else (the Rust daemon) is started directly. */
export function isNodeScript(bin: string): boolean {
  return /\.m?js$/.test(bin);
}

/** Which daemon the stack runs: 'ts' for a Node script, 'rust' for a native binary. */
export const DAEMON_KIND: 'rust' | 'ts' = isNodeScript(DAEMON_BIN) ? 'ts' : 'rust';
export const FAKE_CLAUDE = join(REPO_ROOT, 'packages/daemon/test/fixtures/fake-claude.mjs');
const WIN = process.platform === 'win32';
/** Windows only: the native launcher the fakes run through (`pnpm test:e2e` builds it, MR-T16b). */
export const E2E_LAUNCHER_BIN = join(REPO_ROOT, 'target/release/conductor-e2e-launcher.exe');

/**
 * How long the daemon gets to register. Before it connects, it probes claude twice (`--help`,
 * `--version`, up to 10 s each); on Windows each probe is the launcher plus a cold node + MCP SDK
 * start, on a runner whose Defender scans the freshly copied exe, so it gets longer there.
 */
export const REGISTER_TIMEOUT_MS = WIN ? 90_000 : 20_000;
/** A suite's beforeAll budget: the stack start plus REGISTER_TIMEOUT_MS. */
export const SETUP_TIMEOUT_MS = WIN ? 180_000 : 60_000;

/** `name`'s value in `env`, matched case-insensitively (Windows has `Path`). */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Windows: `dir/<name>.exe`, a copy of the launcher that runs `node <script>`. Returns its path.
 */
function nativeFake(dir: string, name: string, script: string): string {
  const exe = join(dir, `${name}.exe`);
  copyFileSync(E2E_LAUNCHER_BIN, exe);
  writeFileSync(join(dir, `${name}.launch`), `${process.execPath}\n${script}\n`);
  return exe;
}

/** The first PR the E2E fake `gh` opens in a run (ADR-0010 open_pr); later ones count up. */
export const FAKE_GH_URL = 'https://github.com/benjgrad/fixture-app/pull/42';
export const FAKE_GH_URL_RE = /^https:\/\/github\.com\/benjgrad\/fixture-app\/pull\/\d+$/;
/** The login the fake reports as every PR's author (its own approval never counts). */
export const FAKE_GH_AUTHOR = 'conductor-e2e';

/** What the fake `gh` reports for a PR's conditions (ADR-0011), set per ticket title. */
export interface FakePrState {
  /** Eligible (MEMBER) approvals on the PR's current head. Default 0. */
  approvals?: number;
  /** The PR's one CI check. Default 'green'. */
  checks?: 'green' | 'pending' | 'red';
}

/**
 * The E2E fake `gh`: no network, ever. Its state lives in FAKE_GH_STATE:
 * - `--version` → 2.103.3 (open_pr's GH_MIN_VERSION check, the inventory probe); `auth status` → 0;
 * - `repo view` → main;
 * - `pr create --head <b> --title <t>` → a new PR (`pr-<hex(b)>.json`: url, number, head, title),
 *   numbered from 42 (FAKE_GH_URL);
 * - `pr view <branch> --json url` (open_pr's reuse check) → that branch's PR URL, else exit 1;
 * - `pr view <url> --json …` (ADR-0011 evaluate_conditions) → the PR as gh's JSON, unprojected
 *   (the daemon's `--jq` is ignored; its parser takes both). `headRefOid` is the branch tip
 *   conductor pushed to the fixture repo (FAKE_GH_REPO), so head pinning holds. The conditions
 *   come from `review-<hex(title)>.json` (FakePrState, rewritten by a test between polls): one CI
 *   check, N MEMBER approvals on the head, plus two approvals that must never count (the PR
 *   author's own, and a drive-by with association NONE).
 * Every call is logged to FAKE_GH_LOG.
 */
const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
const dir = process.env.FAKE_GH_STATE;
fs.mkdirSync(dir, { recursive: true });
const hex = (s) => Buffer.from(String(s)).toString('hex');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const prFile = (head) => dir + '/pr-' + hex(head) + '.json';
const prs = () => fs.readdirSync(dir).filter((f) => f.startsWith('pr-')).map((f) => read(dir + '/' + f));
const opt = (name) => argv[argv.indexOf(name) + 1];
if (argv[0] === '--version') { console.log('gh version 2.103.3 (2025-01-01)'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') process.exit(0);
if (argv[0] === 'repo' && argv[1] === 'view') { console.log('main'); process.exit(0); }
if (argv[0] === 'pr' && argv[1] === 'view' && /^https:/.test(argv[2])) {
  const pr = prs().find((p) => p.url === argv[2]);
  if (!pr) { console.error('no pull requests found'); process.exit(1); }
  let head = null;
  try {
    head = execFileSync('git', ['-C', process.env.FAKE_GH_REPO, 'rev-parse', '--verify', 'refs/heads/' + pr.head], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {}
  const sf = dir + '/review-' + hex(pr.title) + '.json';
  const st = fs.existsSync(sf) ? read(sf) : {};
  const checks = st.checks || 'green';
  const review = (login, assoc) => ({ author: { login }, authorAssociation: assoc, state: 'APPROVED', commit: { oid: head } });
  const reviews = [review('${FAKE_GH_AUTHOR}', 'OWNER'), review('drive-by', 'NONE')];
  for (let i = 0; i < (st.approvals || 0); i++) reviews.push(review('reviewer-' + (i + 1), 'MEMBER'));
  console.log(JSON.stringify({
    state: 'OPEN', mergedAt: null, reviewDecision: '', headRefOid: head,
    author: { login: '${FAKE_GH_AUTHOR}' },
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci',
      status: checks === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: checks === 'green' ? 'SUCCESS' : checks === 'red' ? 'FAILURE' : null }],
    reviews,
  }));
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'view') {
  if (fs.existsSync(prFile(argv[2]))) { console.log(read(prFile(argv[2])).url); process.exit(0); }
  console.error('no pull requests found'); process.exit(1);
}
if (argv[0] === 'pr' && argv[1] === 'create') {
  const head = opt('--head');
  const number = 42 + prs().length;
  const url = 'https://github.com/benjgrad/fixture-app/pull/' + number;
  fs.writeFileSync(prFile(head), JSON.stringify({ url, number, head, title: opt('--title') }));
  console.log(url);
  process.exit(0);
}
process.exit(2);
`;

export interface StackOptions {
  /** Use the installed `claude` instead of the fake (E2E_REAL_CLAUDE=1). */
  realClaude?: boolean;
  /** Extra daemon env. */
  daemonEnv?: Record<string, string>;
}

interface Proc {
  name: string;
  child: ChildProcess;
  log: string;
  exited: Promise<void>;
}

export class Stack {
  readonly tmp: string;
  readonly machineId = `e2e-${randomBytes(4).toString('hex')}`;
  db!: TestDatabase;
  port = 0;
  private readonly procs: Proc[] = [];

  constructor(private readonly opts: StackOptions = {}) {
    // realpath: macOS tmpdir is a symlink (/var → /private/var); pgrep matches the real path. On
    // Windows the native one expands 8.3 names (C:\Users\RUNNER~1), as the daemon sees them.
    const dir = mkdtempSync(join(tmpdir(), 'conductor-e2e-'));
    this.tmp = WIN ? realpathSync.native(dir) : realpathSync(dir);
  }

  /** Fake Claude scenarios, `<name>.json`, picked per ticket by `fake-scenario: <name>`. */
  get scenarioDir(): string {
    return join(this.tmp, 'scenarios');
  }

  /** JSONL of every fake Claude process start: `{argv, cwd, env}` (fake mode only). */
  get fakeArgvLog(): string {
    return join(this.tmp, 'fake-claude-argv.jsonl');
  }

  /**
   * ADR-0010 open_pr: JSONL of every fake `gh` call (`{argv, cwd}`). The daemon always gets the
   * fake first on PATH, so no run (not even E2E_REAL_CLAUDE) ever reaches GitHub.
   */
  get fakeGhLog(): string {
    return join(this.tmp, 'fake-gh.jsonl');
  }

  /** Where createFixtureRepo goes: the fake gh reads the pushed heads from it. */
  get fixtureRepo(): string {
    return join(this.tmp, 'fixture-repo');
  }

  /** ADR-0011: what the fake gh reports for the PR titled `title`, from its next call on. */
  setFakePr(title: string, state: FakePrState): void {
    const dir = join(this.tmp, 'fake-gh-prs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `review-${Buffer.from(title).toString('hex')}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(state));
    renameSync(`${file}.tmp`, file); // atomic: a poll never reads half a file
  }

  /** CLAUDE_CONFIG_DIR of the daemon and the fake (fake mode): transcripts land under it. */
  get claudeConfigDir(): string {
    return join(this.tmp, 'claude-config');
  }

  /** Which daemon this stack runs (DAEMON_BIN): the Rust binary or the TS build. */
  get daemonKind(): 'rust' | 'ts' {
    return DAEMON_KIND;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Database, then orchestrator (ready when GET /api/board answers), then the daemon. */
  async start(): Promise<void> {
    const bins = [ORCHESTRATOR_BIN, DAEMON_BIN, ...(WIN ? [E2E_LAUNCHER_BIN] : [])];
    for (const bin of bins) {
      if (existsSync(bin)) continue;
      const hint = isNodeScript(bin)
        ? 'run `pnpm exec tsc -b` first'
        : bin === E2E_LAUNCHER_BIN
          ? 'run `pnpm test:e2e` (it builds the launcher) first'
          : bin === RUST_DAEMON_BIN
            ? 'run `cargo build --release -p conductor-daemon` (or `pnpm test:e2e`) first'
            : 'build it first (target/debug/conductor-daemon: `cargo nextest run --workspace --no-run`)';
      throw new Error(`${bin} is missing: ${hint}`);
    }
    console.log(`e2e: ${this.daemonKind} daemon ${DAEMON_BIN}`);
    this.db = await createTestDatabase();
    this.port = await freePort();
    this.spawn('orchestrator', ORCHESTRATOR_BIN, {
      DATABASE_URL: this.db.url,
      CONDUCTOR_PORT: String(this.port),
      CONDUCTOR_WEB_DIR: join(this.tmp, 'no-web'), // API only
    });
    await waitFor('orchestrator /api/board', async () => {
      const res = await fetch(`${this.baseUrl}/api/board`).catch(() => null);
      return res?.ok === true;
    });

    const env: Record<string, string> = {
      CONDUCTOR_ORCHESTRATOR_URL: `ws://127.0.0.1:${this.port}/ws/daemon`,
      CONDUCTOR_ROOT: join(this.tmp, 'daemon-root'),
      CONDUCTOR_MACHINE_ID: this.machineId,
      CONDUCTOR_TAGS: 'e2e',
      CONDUCTOR_MAX_SESSIONS: '4',
      CONDUCTOR_MIN_FREE_MEM_MB: '0',
      CONDUCTOR_WORK_POLL_MS: '100',
      CONDUCTOR_ALLOW_LOCAL_REPOS: '1', // the fixture repo is a local path (M1-T14)
      CONDUCTOR_GIT_NAME: 'conductor-e2e',
      CONDUCTOR_GIT_EMAIL: 'e2e@localhost',
      ...this.opts.daemonEnv,
    };
    // ADR-0010 / ADR-0011: the fake `gh` (FAKE_GH above, no network). Every call is logged to
    // fakeGhLog. Windows: gh.exe (the launcher) runs node gh.cjs (the script uses require).
    const ghBin = join(this.tmp, 'gh-bin');
    mkdirSync(ghBin);
    if (WIN) {
      const script = join(ghBin, 'gh.cjs');
      writeFileSync(script, FAKE_GH.replace(/^#!.*\n/, ''));
      nativeFake(ghBin, 'gh', script);
    } else {
      writeFileSync(join(ghBin, 'gh'), FAKE_GH);
      chmodSync(join(ghBin, 'gh'), 0o755);
    }
    env.PATH = `${ghBin}${delimiter}${envGet(process.env, 'PATH') ?? ''}`;
    env.FAKE_GH_LOG = this.fakeGhLog;
    // ADR-0010 fresh checkouts auto-detect `npm install` as their setup: never touch the network.
    env.npm_config_offline = 'true';
    env.npm_config_audit = 'false';
    env.npm_config_fund = 'false';
    env.npm_config_update_notifier = 'false';
    env.FAKE_GH_STATE = join(this.tmp, 'fake-gh-prs');
    env.FAKE_GH_REPO = this.fixtureRepo;
    if (!this.opts.realClaude) {
      const bin = join(this.tmp, 'bin');
      mkdirSync(bin);
      if (WIN) {
        env.CONDUCTOR_CLAUDE_BIN = nativeFake(bin, 'claude', FAKE_CLAUDE);
      } else {
        symlinkSync(FAKE_CLAUDE, join(bin, 'claude'));
        env.CONDUCTOR_CLAUDE_BIN = join(bin, 'claude');
      }
      env.FAKE_CLAUDE_SCENARIO_DIR = this.scenarioDir;
      env.FAKE_CLAUDE_STATE_DIR = join(this.tmp, 'fake-claude-state');
      env.FAKE_CLAUDE_ARGV_LOG = this.fakeArgvLog; // one line per process start (live vs --resume)
      env.FAKE_CLAUDE_VERSION = '9.9.9';
      // ADR-0008: the fake writes transcripts here, and the daemon reads them from here.
      env.CLAUDE_CONFIG_DIR = this.claudeConfigDir;
    }
    this.spawn('daemon', DAEMON_BIN, env);
  }

  private spawn(name: string, bin: string, env: Record<string, string>) {
    const log = join(this.tmp, `${name}.log`);
    const fd = openSync(log, 'a');
    const base: NodeJS.ProcessEnv = { ...process.env };
    // Never leak the caller's scenario, claude binary or conductor settings into the stack.
    for (const k of Object.keys(base)) {
      if (k.startsWith('FAKE_CLAUDE_') || k.startsWith('CONDUCTOR_')) delete base[k];
      // Windows env names are case-insensitive: drop `Path` when `env` sets PATH, so the child
      // gets one (Node would pick either).
      if (WIN && Object.keys(env).some((e) => e.toUpperCase() === k.toUpperCase())) delete base[k];
    }
    const [file, args]: [string, string[]] = isNodeScript(bin)
      ? [process.execPath, [bin]]
      : [bin, []];
    const child = spawn(file, args, {
      cwd: this.tmp,
      env: { ...base, ...env },
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    this.procs.push({ name, child, log, exited });
  }

  /**
   * Wait (REGISTER_TIMEOUT_MS) until `online` says the daemon registered; on a timeout print every
   * process log first, so CI shows why.
   */
  async waitForDaemon(online: () => Promise<unknown>): Promise<void> {
    try {
      await waitFor('the daemon to register', online, REGISTER_TIMEOUT_MS);
    } catch (err) {
      console.error(`daemon alive: ${this.alive('daemon')}\n${this.logs()}`);
      throw err;
    }
  }

  /** Whether a child has exited (e.g. a startup crash). */
  alive(name: string): boolean {
    const p = this.procs.find((x) => x.name === name);
    return !!p && p.child.exitCode === null && p.child.signalCode === null;
  }

  /** The last `lines` lines of each process log (printed when a test fails). */
  logs(lines = 60): string {
    return this.procs
      .map((p) => {
        const text = existsSync(p.log) ? readFileSync(p.log, 'utf8') : '';
        return `----- ${p.name} (${p.log})\n${text.split('\n').slice(-lines).join('\n')}`;
      })
      .join('\n');
  }

  /** Processes still running from this run's temp dir (fake claude, fixture commands). */
  leftovers(): number[] {
    return findProcesses(this.tmp);
  }

  /** SIGTERM one child, SIGKILL after `graceMs` (Windows: both are TerminateProcess). */
  async stopProc(name: string, graceMs = 8000): Promise<void> {
    const p = this.procs.find((x) => x.name === name);
    if (!p || p.child.exitCode !== null || p.child.signalCode !== null) return;
    p.child.kill('SIGTERM');
    const t = setTimeout(() => p.child.kill('SIGKILL'), graceMs);
    await p.exited;
    clearTimeout(t);
  }

  /**
   * Daemon first (it kills its Claude processes), then the orchestrator, then anything left in
   * the temp dir, the database and the temp dir. Idempotent.
   */
  async stop(): Promise<void> {
    await this.stopProc('daemon');
    await this.stopProc('orchestrator');
    for (const pid of this.leftovers()) killTree(pid);
    await this.db?.drop();
    // Windows: a just-killed launcher can hold its exe for a moment (EBUSY): retry longer.
    rmSync(this.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: WIN ? 500 : 100 });
  }
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

/** Poll `fn` every 50 ms until it returns a truthy value. */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
