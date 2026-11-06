import {
  DEFAULT_CHECK_TIMEOUT,
  parseDuration,
  type Condition,
  type ConditionResult,
} from '@conductor/shared';
import {
  detectSetup,
  fetchBudget,
  freshCheckout,
  managedCommand,
  missingManager,
  removeCheckout,
  type FreshCheckout,
  type FreshCheckoutInput,
} from './checkout.js';
import { resolveHead, tail } from './open-pr.js';

// ADR-0037 P2 `cmd` conditions: met when the command exits 0, failed otherwise, run in a fresh,
// conductor-owned checkout of the PR head (ADR-0030, the one `requires.checks` uses), never in
// the agent's worktree. One checkout per evaluation, shared by its `cmd` conditions; the repo
// setup runs once, and only when a `cmd` with `needs: setup` (the default) is reached. Anything
// that keeps the command from running (no worktree on this machine, the branch moved, the setup
// failed) is `pending`: a condition never fails on missing evidence.

type CmdCondition = Extract<Condition, { type: 'cmd' }>;

export interface CmdExecResult {
  /** null: killed by a signal (the timeout included). */
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}

/** Runs `cmd` with `sh -c` in `cwd` (the daemon: its command runner, through the build slots). */
export type CmdExec = (cmd: string, cwd: string, timeoutMs: number) => Promise<CmdExecResult>;

export interface CmdConditionContext {
  root: string;
  /** The session's worktree and branch, from this daemon's own records; null: not held here. */
  worktree: { path: string; branch: string } | null;
  /** The setup for `needs: setup`: a command, '' (none), null / undefined (auto-detect). */
  setup?: string | null | undefined;
  exec: CmdExec;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Tests: the checkout and the worktree head (default freshCheckout / resolveHead). */
  checkout?: (i: FreshCheckoutInput) => Promise<FreshCheckout>;
  resolveHead?: (worktree: string) => Promise<string | null>;
  /** Tests: the PATH used to look for a package manager (default the daemon's). */
  path?: string;
}

/** Detail size cap for a failed command's output tail. */
const OUTPUT_DETAIL_CHARS = 600;

const pending = (detail: string): ConditionResult => ({
  type: 'cmd',
  status: 'pending',
  value: null,
  detail,
});

/** The `cmd` conditions of one evaluation. `close()` removes the checkout (call it in a finally). */
export class CmdConditionRunner {
  private dir: string | null = null;
  /** Why the checkout can't be used (sticky for this evaluation). */
  private broken: string | null = null;
  private setupDone = false;
  /** Why the setup failed (then every `needs: setup` command stays pending). */
  private setupFailed: string | null = null;

  constructor(private readonly ctx: CmdConditionContext) {}

  /**
   * Run `c` on `sha` (the commit conductor pushed, else the PR head gh reported; null: the
   * worktree's HEAD).
   */
  async run(c: CmdCondition, sha: string | null): Promise<ConditionResult> {
    const timeout = c.timeout ?? DEFAULT_CHECK_TIMEOUT;
    const dir = await this.prepare(sha, parseDuration(timeout));
    if (dir === null) return pending(this.broken ?? 'no checkout');
    if (c.needs !== 'checkout') {
      if (this.setupFailed !== null) return pending(this.setupFailed);
      if (!this.setupDone) {
        const failed = await this.runSetup(dir);
        if (failed !== null) {
          this.setupFailed = failed;
          return pending(failed);
        }
        this.setupDone = true;
      }
    }
    const cmd = managedCommand(dir, c.cmd);
    const missing = missingManager(cmd, this.ctx.path);
    if (missing !== null) return pending(missing);
    const r = await this.ctx.exec(cmd, dir, parseDuration(timeout));
    if (r.timedOut) {
      return {
        type: 'cmd',
        status: 'failed',
        value: 'timed out',
        detail: `timed out after ${timeout}`,
      };
    }
    if (r.exitCode === 0) return { type: 'cmd', status: 'met', value: 'exit 0', detail: null };
    const value = r.exitCode === null ? 'killed' : `exit ${r.exitCode}`;
    const out = tail(r.outputTail, OUTPUT_DETAIL_CHARS);
    return {
      type: 'cmd',
      status: 'failed',
      value,
      detail: out === '' ? value : `${value}: ${out}`,
    };
  }

  close(): void {
    if (this.dir !== null) removeCheckout(this.dir);
    this.dir = null;
  }

  private async prepare(sha: string | null, timeoutMs: number): Promise<string | null> {
    if (this.dir !== null) return this.dir;
    if (this.broken !== null) return null;
    const wt = this.ctx.worktree;
    if (wt === null) {
      this.broken =
        "this machine doesn't hold the ticket's worktree, so the command can't run here";
      return null;
    }
    const want = sha ?? (await (this.ctx.resolveHead ?? ((w) => resolveHead(w)))(wt.path));
    if (want === null) {
      this.broken = 'could not resolve the commit to check';
      return null;
    }
    const co = await (this.ctx.checkout ?? freshCheckout)({
      root: this.ctx.root,
      worktree: wt.path,
      branch: wt.branch,
      sha: want,
      timeoutMs: fetchBudget(timeoutMs),
      ...(this.ctx.env ? { env: this.ctx.env } : {}),
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
    });
    if (!co.ok) {
      this.broken = `fresh checkout: ${co.error}`;
      return null;
    }
    this.dir = co.dir;
    return co.dir;
  }

  /** The repo setup; null when it ran (or there is none), else why it failed. */
  private async runSetup(dir: string): Promise<string | null> {
    const setup = detectSetup(dir, this.ctx.setup ?? null);
    if (setup === null) return null;
    const missing = missingManager(setup, this.ctx.path);
    if (missing !== null) return missing;
    const r = await this.ctx.exec(setup, dir, parseDuration(DEFAULT_CHECK_TIMEOUT));
    if (r.exitCode === 0 && !r.timedOut) return null;
    const why = r.timedOut ? 'timed out' : r.exitCode === null ? 'killed' : `exit ${r.exitCode}`;
    return `the setup \`${setup}\` failed in a fresh checkout (${why}): ${tail(r.outputTail, 300)}`;
  }
}
