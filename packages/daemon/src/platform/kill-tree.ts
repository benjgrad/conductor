import { execFile, type ChildProcess } from 'node:child_process';
import { system32 } from './spawn.js';

// ADR-0024 §1–§2 (kill-tree.ts): end a child and everything it started.
//
// POSIX: the child was spawned `detached`, so it leads its own process group. Signal the group
// (`kill(-pid)`); with a grace period, escalate to SIGKILL afterwards. When the target is a
// ChildProcess and the group signal fails, fall back to `child.kill(sig)` (as cli-driver does;
// Node makes that a no-op once the child is reaped). A bare pid gets no per-pid fallback, as in
// process-runner: after the shell is reaped its pid may already belong to someone else. This is
// the logic of `claude/cli-driver.ts` `kill()`/`signal()` and `commands/process-runner.ts`
// `killGroup()`, copied here; MW-T05 switches those call sites over and deletes the originals.
//
// win32: there are no process groups or signals. `taskkill /T /F /PID <pid>` walks the
// parent-pid tree and terminates it forcefully, so there is no grace step and `signal` is
// ignored. A ChildProcess that has already exited is skipped: its pid may be reused, and its
// tree can't be walked any more anyway (its children were reparented).
// TD: taskkill /T misses a grandchild whose parent already exited (reparented); the orphan
// sweep is the backstop. ADR-0024 §2 records this as TD-187 (Job Objects are the payoff path).

export interface KillTreeOptions {
  /** First signal (POSIX). Default SIGTERM. */
  signal?: NodeJS.Signals;
  /** POSIX: send SIGKILL after this many ms unless cancelled. Omit for no escalation. */
  graceMs?: number;
  /** Injected for tests. */
  platform?: NodeJS.Platform;
}

export interface KillTreeHandle {
  /** Stop a pending SIGKILL escalation (call it when the child has exited). */
  cancel(): void;
  /**
   * Resolves once the last kill was issued or the escalation was cancelled. On win32 that is
   * when `taskkill` has exited, so the tree is gone (modulo TD-187) when it resolves.
   */
  readonly settled: Promise<void>;
}

/** Signal a POSIX process group, then (for a ChildProcess) the child alone. */
export function signalGroup(pid: number, sig: NodeJS.Signals, child?: ChildProcess): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    if (child === undefined) return false; // ESRCH: the group is already gone
    try {
      return child.kill(sig);
    } catch {
      return false; // already gone
    }
  }
}

/** The `taskkill` invocation for a tree kill. Pure. */
export function taskkillArgs(pid: number): string[] {
  return ['/T', '/F', '/PID', String(pid)];
}

const NOOP: KillTreeHandle = { cancel: () => undefined, settled: Promise.resolve() };

/** Kill `target` (a pid, or a ChildProcess) and its descendants. See the header. */
export function killTree(
  target: number | ChildProcess,
  opts: KillTreeOptions = {},
): KillTreeHandle {
  const child = typeof target === 'number' ? undefined : target;
  const pid = typeof target === 'number' ? target : target.pid;
  if (pid === undefined) return NOOP; // never spawned
  if (!Number.isInteger(pid) || pid <= 0) throw new RangeError(`killTree: bad pid ${pid}`);
  const platform = opts.platform ?? process.platform;

  if (platform === 'win32') {
    if (child && (child.exitCode !== null || child.signalCode !== null)) return NOOP;
    const settled = new Promise<void>((resolve) => {
      // Exit 128 = "not found" (already gone); any failure leaves it to the orphan sweep.
      execFile(system32('taskkill.exe'), taskkillArgs(pid), { windowsHide: true }, () => resolve());
    });
    return { cancel: () => undefined, settled };
  }

  const sig = opts.signal ?? 'SIGTERM';
  signalGroup(pid, sig, child);
  if (sig === 'SIGKILL' || opts.graceMs === undefined) return NOOP;
  let timer: NodeJS.Timeout | undefined;
  let done!: () => void;
  const settled = new Promise<void>((resolve) => (done = resolve));
  timer = setTimeout(() => {
    timer = undefined;
    signalGroup(pid, 'SIGKILL', child);
    done();
  }, opts.graceMs);
  timer.unref();
  return {
    cancel: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      done();
    },
    settled,
  };
}
