import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { OUTPUT_TAIL_BYTES } from '@conductor/shared';
import type { CommandResult, CommandRunner, RunCommandOptions } from './runner.js';
import { Semaphore } from './semaphore.js';
import { TailBuffer } from './tail.js';

// The real CommandRunner (M1-T06, 07 §Compute). Each `run` takes a slot on the per-machine build
// semaphore (FIFO; `onWaitingForSlot(true/false)` only when it actually waits), then runs
// `sh -c <cmd>` in its own process group in `cwd` with the daemon env + `opts.env`. Timeout and
// abort send SIGTERM to the whole group, then SIGKILL after `killGraceMs`. When the shell exits,
// anything it left in its group is SIGKILLed so no build escapes the semaphore. Output streams to
// `onOutput` and the last `tailBytes` of stdout+stderr (interleaved) become `outputTail`.

export interface ProcessCommandRunnerOptions {
  /** Build semaphore size (`machine.max_concurrent_builds`). */
  maxConcurrent: number;
  /** SIGTERM → SIGKILL grace on timeout/abort. Default 5 s (the daemon's kill grace). */
  killGraceMs?: number;
  /** Shell used as `<shell> -c <cmd>`. Default `/bin/sh`. */
  shell?: string;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

export class ProcessCommandRunner implements CommandRunner {
  readonly maxConcurrent: number;
  private readonly slots: Semaphore;
  private readonly killGraceMs: number;
  private readonly shell: string;

  constructor(opts: ProcessCommandRunnerOptions) {
    this.maxConcurrent = opts.maxConcurrent;
    this.slots = new Semaphore(opts.maxConcurrent);
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.shell = opts.shell ?? '/bin/sh';
  }

  /** Commands currently holding a build slot. */
  get runningCount(): number {
    return this.slots.inUse;
  }

  /** Commands queued for a build slot. */
  get waitingCount(): number {
    return this.slots.waiting;
  }

  async run(opts: RunCommandOptions): Promise<CommandResult> {
    if (opts.signal?.aborted) return abortedBeforeStart();
    if (!this.slots.tryAcquire()) {
      opts.onWaitingForSlot?.(true);
      const got = await this.slots.acquire(opts.signal);
      if (!got) return abortedBeforeStart();
      opts.onWaitingForSlot?.(false);
    }
    try {
      return await this.exec(opts);
    } finally {
      this.slots.release();
    }
  }

  private exec(opts: RunCommandOptions): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const started = performance.now();
      const tail = new TailBuffer(opts.tailBytes ?? OUTPUT_TAIL_BYTES);
      const child = spawn(this.shell, ['-c', opts.cmd], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        detached: true, // own process group, so kills reach the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let spawned = false;
      let settled = false;
      let timedOut = false;
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const killGroup = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          // ESRCH: the group is already gone.
        }
      };
      const terminate = (): void => {
        if (exit || killTimer) return;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), this.killGraceMs);
        killTimer.unref();
      };
      const onAbort = (): void => terminate();
      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        opts.signal?.removeEventListener('abort', onAbort);
      };

      const pipe = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr'): void => {
        const decoder = new StringDecoder('utf8');
        stream.on('data', (b: Buffer) => {
          tail.push(b);
          const text = decoder.write(b);
          if (text) opts.onOutput?.({ stream: name, text });
        });
        stream.on('end', () => {
          const text = decoder.end();
          if (text) opts.onOutput?.({ stream: name, text });
        });
      };
      pipe(child.stdout, 'stdout');
      pipe(child.stderr, 'stderr');

      child.once('spawn', () => {
        spawned = true;
        if (opts.timeoutMs !== null) {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs);
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        if (opts.signal?.aborted) terminate();
      });

      child.once('error', (err) => {
        if (settled) return;
        if (!spawned) {
          settled = true;
          cleanup();
          reject(err);
        }
        // After spawn, 'error' means a failed kill; the 'exit'/'close' path still settles.
      });

      child.once('exit', (code, signal) => {
        exit = { code, signal };
        // Reap anything the shell left behind in its group (it would hold the pipes open and
        // keep running outside the semaphore).
        killGroup('SIGKILL');
      });

      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        const e = exit ?? { code, signal };
        resolve({
          exitCode: e.signal ? null : e.code,
          signal: e.signal,
          timedOut,
          durationMs: performance.now() - started,
          outputTail: tail.toString(),
        });
      });
    });
  }
}

function abortedBeforeStart(): CommandResult {
  return { exitCode: null, signal: 'SIGTERM', timedOut: false, durationMs: 0, outputTail: '' };
}
