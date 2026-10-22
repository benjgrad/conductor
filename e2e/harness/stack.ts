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
  rmSync,
  symlinkSync,
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
    if (!this.opts.realClaude) {
      const bin = join(this.tmp, 'bin');
      mkdirSync(bin);
      symlinkSync(FAKE_CLAUDE, join(bin, 'claude'));
      env.CONDUCTOR_CLAUDE_BIN = join(bin, 'claude');
      env.FAKE_CLAUDE_SCENARIO_DIR = this.scenarioDir;
      env.FAKE_CLAUDE_STATE_DIR = join(this.tmp, 'fake-claude-state');
      env.FAKE_CLAUDE_VERSION = '9.9.9';
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
