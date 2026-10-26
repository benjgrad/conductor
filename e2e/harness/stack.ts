// The E2E stack (M1-T10): a fresh Postgres database (packages/orchestrator/test/db.ts), the real
// `conductor-orchestrator` bin on an ephemeral port, and one real `conductor-daemon` bin, each a
// child process with its log in the run's temp dir. The daemon drives the fake `claude`
// (packages/daemon/test/fixtures/fake-claude.mjs, via a symlink inside the temp dir so leftover
// processes can be found by path) unless the run uses the real CLI.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '../../packages/orchestrator/test/db.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ORCHESTRATOR_BIN = join(REPO_ROOT, 'packages/orchestrator/dist/bin.js');
export const DAEMON_BIN = join(REPO_ROOT, 'packages/daemon/dist/main.js');
export const FAKE_CLAUDE = join(REPO_ROOT, 'packages/daemon/test/fixtures/fake-claude.mjs');

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
    // realpath: macOS tmpdir is a symlink (/var → /private/var); pgrep matches the real path.
    this.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-e2e-')));
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

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Database, then orchestrator (ready when GET /api/board answers), then the daemon. */
  async start(): Promise<void> {
    for (const bin of [ORCHESTRATOR_BIN, DAEMON_BIN]) {
      if (!existsSync(bin)) throw new Error(`${bin} is missing: run \`pnpm exec tsc -b\` first`);
    }
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
    // fakeGhLog.
    const ghBin = join(this.tmp, 'gh-bin');
    mkdirSync(ghBin);
    writeFileSync(join(ghBin, 'gh'), FAKE_GH);
    chmodSync(join(ghBin, 'gh'), 0o755);
    env.PATH = `${ghBin}:${process.env.PATH ?? ''}`;
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
      symlinkSync(FAKE_CLAUDE, join(bin, 'claude'));
      env.CONDUCTOR_CLAUDE_BIN = join(bin, 'claude');
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
    }
    const child = spawn(process.execPath, [bin], {
      cwd: this.tmp,
      env: { ...base, ...env },
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    this.procs.push({ name, child, log, exited });
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
    try {
      return execFileSync('pgrep', ['-f', this.tmp], { encoding: 'utf8' })
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => n > 0 && n !== process.pid);
    } catch {
      return []; // pgrep exits 1 when nothing matches
    }
  }

  /** SIGTERM one child, SIGKILL after `graceMs`. */
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
    for (const pid of this.leftovers()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await this.db?.drop();
    rmSync(this.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
