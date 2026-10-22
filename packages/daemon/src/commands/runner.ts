// Command-state runner contract (M1-T12). Implemented by M1-T06; the daemon core (T05) calls it
// for WS `run_cmd` and turns the result into session_event `cmd_exit` (+ `build_slot` while
// queued, + `output` chunks). Interface + factory type here; T06 implements `createCommandRunner`
// in commands/index.ts (placeholder until then); `FakeCommandRunner` (fake-runner.ts) for T05.

export interface CommandOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface RunCommandOptions {
  /** The outbox command_id from `run_cmd`; echoed in `cmd_exit`. */
  commandId: string;
  sessionId: string;
  /** Shell command line, run with `sh -c` (07: through the build semaphore). */
  cmd: string;
  /** Absolute cwd: the session worktree, joined with `run_cmd.cwd` if set. */
  cwd: string;
  /** null = no timeout. On expiry: SIGTERM, then SIGKILL; result `timedOut: true`. */
  timeoutMs: number | null;
  /** Merged over the daemon env (session ports, etc.). */
  env: Record<string, string>;
  /** Bytes of combined output kept for `outputTail`. Default OUTPUT_TAIL_BYTES (16 KB). */
  tailBytes?: number;
  /** Live output, forwarded as WS `output` (stream stdout/stderr). */
  onOutput?: (chunk: CommandOutputChunk) => void;
  /**
   * Called with `true` when the command must wait for a build slot and `false` when it gets one
   * (only called with `true` if it actually waits). Forwarded as session_event `build_slot`.
   */
  onWaitingForSlot?: (waiting: boolean) => void;
  /** Abort (e.g. WS `kill` for the session): kills the command; it resolves with a signal. */
  signal?: AbortSignal;
}

export interface CommandResult {
  /** null when killed by a signal (including timeout). */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** From slot acquisition to exit (queue time excluded). */
  durationMs: number;
  /** Last `tailBytes` of stdout+stderr interleaved; `cmd_exit.output_tail`. */
  outputTail: string;
}

export interface CommandRunner {
  /** Size of the build semaphore (`machine.max_concurrent_builds`, default 2). */
  readonly maxConcurrent: number;
  /** Never rejects for a failing command; rejects only if the process could not be spawned. */
  run(opts: RunCommandOptions): Promise<CommandResult>;
}

/** M1-T06 implements it (commands/index.ts); T05 calls it once with the registered budget. */
export type CreateCommandRunner = (opts: {
  /** `machine.max_concurrent_builds` (the build semaphore size). */
  maxConcurrent: number;
}) => CommandRunner;
