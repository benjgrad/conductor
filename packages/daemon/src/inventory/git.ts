import { cleanEnv, NO_HOOKS } from '../actions/open-pr.js';
import { execFileCli } from '../platform/index.js';

// Read-only git for the inventory scanner (M2-T10, ADR-0013 §Inventory: it runs no repo code).
// Hooks and fsmonitor off, no system config and no inherited GIT_* overrides (`cleanEnv`).

export interface GitRead {
  code: number | null;
  stdout: string;
}

export const GIT_READ_TIMEOUT_MS = 10_000;

export function gitRead(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitRead> {
  return new Promise((resolve) => {
    execFileCli(
      'git',
      [...NO_HOOKS, '-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        env: cleanEnv(env),
        timeout: GIT_READ_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        const e = err as (Error & { code?: unknown }) | null;
        const code = e === null ? 0 : typeof e.code === 'number' ? e.code : null;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });
}
