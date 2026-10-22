import type { CommandResult, CommandRunner, RunCommandOptions } from './runner.js';

// Scripted CommandRunner for T05 tests (no processes). Results are scripted per `cmd` (default:
// exit 0). Honours the build semaphore (`maxConcurrent`), calling onWaitingForSlot(true/false)
// only when a run actually waits, streams the scripted output, and resolves a run with signal
// SIGTERM when its AbortSignal fires. Runs finish when `release(cmd)` / `releaseAll()` is called,
// or at once with `autoRelease: true`.

export interface FakeCommandScript {
  exitCode?: number | null;
  timedOut?: boolean;
  output?: string;
}

interface Pending {
  opts: RunCommandOptions;
  started: boolean;
  finish: (r: CommandResult) => void;
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: RunCommandOptions[] = [];
  private readonly scripts = new Map<string, FakeCommandScript>();
  private readonly queue: Pending[] = [];
  private readonly running = new Set<Pending>();

  constructor(
    readonly maxConcurrent = 2,
    private readonly autoRelease = false,
  ) {}

  script(cmd: string, s: FakeCommandScript): this {
    this.scripts.set(cmd, s);
    return this;
  }

  get runningCount(): number {
    return this.running.size;
  }

  run(opts: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(opts);
    return new Promise<CommandResult>((resolve) => {
      const p: Pending = { opts, started: false, finish: resolve };
      opts.signal?.addEventListener('abort', () => this.end(p, { abort: true }), { once: true });
      if (this.running.size < this.maxConcurrent) this.begin(p);
      else {
        opts.onWaitingForSlot?.(true);
        this.queue.push(p);
      }
    });
  }

  /** Finish the oldest running command whose cmd matches. Returns false if none. */
  release(cmd: string): boolean {
    const p = [...this.running].find((r) => r.opts.cmd === cmd);
    if (!p) return false;
    this.end(p, {});
    return true;
  }

  releaseAll(): void {
    for (const p of [...this.running]) this.end(p, {});
  }

  private begin(p: Pending): void {
    p.started = true;
    this.running.add(p);
    const out = this.scripts.get(p.opts.cmd)?.output;
    if (out) p.opts.onOutput?.({ stream: 'stdout', text: out });
    if (this.autoRelease) queueMicrotask(() => this.end(p, {}));
  }

  private end(p: Pending, how: { abort?: boolean }): void {
    const wasQueued = !p.started && this.queue.includes(p);
    if (!this.running.delete(p) && !wasQueued) return;
    if (wasQueued) this.queue.splice(this.queue.indexOf(p), 1);
    const s = this.scripts.get(p.opts.cmd) ?? {};
    const timedOut = !how.abort && (s.timedOut ?? false);
    p.finish({
      exitCode: how.abort || timedOut ? null : (s.exitCode ?? 0),
      signal: how.abort || timedOut ? 'SIGTERM' : null,
      timedOut,
      durationMs: 0,
      outputTail: s.output ?? '',
    });
    const next = this.queue.shift();
    if (next && this.running.size < this.maxConcurrent) {
      next.opts.onWaitingForSlot?.(false);
      this.begin(next);
    }
  }
}
