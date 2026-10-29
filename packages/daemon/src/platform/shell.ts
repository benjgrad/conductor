import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { envGet, execFileCliSync } from './spawn.js';

// ADR-0024 §1 + §4 (shell.ts): the shell that runs workflow JSON commands. Workflow commands are
// POSIX `sh`, so one workflow runs on every OS: `/bin/sh -c <cmd>` on POSIX, Git Bash
// `bash.exe -c <cmd>` on Windows (Claude Code on Windows already requires Git for Windows).
//
// Git Bash is looked up in this order:
//   1. CONDUCTOR_SHELL (an explicit override; must exist);
//   2. CLAUDE_CODE_GIT_BASH_PATH (what Claude Code itself is told to use);
//   3. relative to `git --exec-path` (`<git>\mingw64\libexec\git-core` → `<git>\bin\bash.exe`);
//   4. the default install dirs: %ProgramFiles%\Git, %ProgramFiles(x86)%\Git,
//      %LOCALAPPDATA%\Programs\Git.
// `bin\bash.exe` is preferred over `usr\bin\bash.exe`: it is Git's launcher, which puts the
// MSYS tools (`usr\bin`, `mingw64\bin`) on PATH. A bare `bash` from PATH is never used:
// `C:\Windows\System32\bash.exe` is WSL, not Git Bash.

export interface WorkflowShell {
  file: string;
  args: (cmd: string) => string[];
}

export interface FindGitBashDeps {
  env: NodeJS.ProcessEnv;
  isFile: (p: string) => boolean;
  /** `git --exec-path`, or undefined when git isn't runnable. */
  gitExecPath: () => string | undefined;
}

const GIT_EXEC_SUFFIX = /[\\/](?:mingw64|mingw32|clangarm64|usr)[\\/]libexec[\\/]git-core[\\/]?$/i;

function bashUnder(root: string): string[] {
  return [win32.join(root, 'bin', 'bash.exe'), win32.join(root, 'usr', 'bin', 'bash.exe')];
}

/** Git Bash candidates in lookup order (before checking they exist). Pure given `deps`. */
export function gitBashCandidates(deps: FindGitBashDeps): string[] {
  const out: string[] = [];
  const claude = envGet(deps.env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (claude) out.push(claude);
  const exec = deps.gitExecPath()?.trim();
  if (exec && GIT_EXEC_SUFFIX.test(exec)) {
    out.push(...bashUnder(win32.normalize(exec.replace(GIT_EXEC_SUFFIX, ''))));
  }
  for (const [name, sub] of [
    ['ProgramFiles', 'Git'],
    ['ProgramW6432', 'Git'],
    ['ProgramFiles(x86)', 'Git'],
    ['LOCALAPPDATA', 'Programs\\Git'],
  ] as const) {
    const base = envGet(deps.env, name);
    if (base) out.push(...bashUnder(win32.join(base, sub)));
  }
  return out;
}

/** Find Git Bash (see the header). Throws with the places it looked if there is none. */
export function findGitBash(deps: FindGitBashDeps): string {
  const override = envGet(deps.env, 'CONDUCTOR_SHELL');
  if (override) {
    if (deps.isFile(override)) return override;
    throw new Error(`CONDUCTOR_SHELL=${override} does not exist`);
  }
  const candidates = gitBashCandidates(deps);
  const hit = candidates.find((c) => win32.isAbsolute(c) && deps.isFile(c));
  if (hit !== undefined) return hit;
  throw new Error(
    `Git Bash not found (install Git for Windows, or set CONDUCTOR_SHELL); looked in: ${candidates.join(', ') || '(nothing)'}`,
  );
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function gitExecPath(): string | undefined {
  try {
    return execFileCliSync('git', ['--exec-path'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
}

let cached: WorkflowShell | undefined;

/**
 * The workflow shell for this OS. On win32 the Git Bash lookup runs once per process (a miss
 * throws and is retried next call).
 */
export function workflowShell(platform: NodeJS.Platform = process.platform): WorkflowShell {
  if (platform !== 'win32') return { file: '/bin/sh', args: (cmd) => ['-c', cmd] };
  cached ??= {
    file: findGitBash({ env: process.env, isFile, gitExecPath }),
    args: (cmd) => ['-c', cmd],
  };
  return cached;
}
