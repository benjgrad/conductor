import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findGitBash, gitBashCandidates, workflowShell, type FindGitBashDeps } from './shell.js';
import { spawnCli } from './spawn.js';

const isWin = process.platform === 'win32';

function deps(over: Partial<FindGitBashDeps> & { files?: string[] } = {}): FindGitBashDeps {
  const files = new Set(over.files ?? []);
  return {
    env: over.env ?? {},
    isFile: over.isFile ?? ((p) => files.has(p)),
    gitExecPath: over.gitExecPath ?? (() => undefined),
  };
}

describe('workflowShell', () => {
  it('POSIX: /bin/sh -c', () => {
    const sh = workflowShell('linux');
    expect(sh.file).toBe('/bin/sh');
    expect(sh.args('echo hi')).toEqual(['-c', 'echo hi']);
    expect(workflowShell('darwin').file).toBe('/bin/sh');
  });

  it('runs a POSIX command line with quotes, $ and && on this OS', async () => {
    const sh = workflowShell();
    if (isWin) console.log(`MW-T03: workflowShell() on this runner = ${sh.file}`);
    expect(existsSync(sh.file)).toBe(true);
    const child = spawnCli(sh.file, sh.args(`echo "a  b" 'c$d' && echo $((1+2))`), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
    const code = await new Promise((r) => child.once('close', r));
    expect(code).toBe(0);
    expect(out.replace(/\r\n/g, '\n')).toBe('a  b c$d\n3\n');
  });

  it.runIf(isWin)('win32: finds Git Bash on the runner (not WSL bash)', () => {
    const file = workflowShell().file;
    expect(file.toLowerCase()).toMatch(/bash\.exe$/);
    expect(file.toLowerCase()).not.toContain('system32');
  });
});

describe('findGitBash', () => {
  const PF_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

  it('CONDUCTOR_SHELL wins, and must exist', () => {
    const d = deps({ env: { CONDUCTOR_SHELL: 'D:\\sh.exe' }, files: ['D:\\sh.exe', PF_BASH] });
    expect(findGitBash(d)).toBe('D:\\sh.exe');
    expect(() => findGitBash(deps({ env: { CONDUCTOR_SHELL: 'D:\\nope.exe' } }))).toThrow(
      /CONDUCTOR_SHELL=D:\\nope.exe does not exist/,
    );
  });

  it('then CLAUDE_CODE_GIT_BASH_PATH', () => {
    const env = {
      CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\bin\\bash.exe',
      ProgramFiles: 'C:\\Program Files',
    };
    expect(findGitBash(deps({ env, files: ['E:\\Git\\bin\\bash.exe', PF_BASH] }))).toBe(
      'E:\\Git\\bin\\bash.exe',
    );
    // Set but missing: fall through to the next candidates.
    expect(findGitBash(deps({ env, files: [PF_BASH] }))).toBe(PF_BASH);
  });

  it('then relative to git --exec-path (forward slashes, any MSYS prefix)', () => {
    const gitExecPath = (): string => 'D:/Tools/Git/mingw64/libexec/git-core\n';
    expect(findGitBash(deps({ gitExecPath, files: ['D:\\Tools\\Git\\bin\\bash.exe'] }))).toBe(
      'D:\\Tools\\Git\\bin\\bash.exe',
    );
    expect(findGitBash(deps({ gitExecPath, files: ['D:\\Tools\\Git\\usr\\bin\\bash.exe'] }))).toBe(
      'D:\\Tools\\Git\\usr\\bin\\bash.exe',
    );
    const arm = (): string => 'C:\\Git\\clangarm64\\libexec\\git-core';
    expect(gitBashCandidates(deps({ gitExecPath: arm }))[0]).toBe('C:\\Git\\bin\\bash.exe');
    // An exec-path we don't recognise adds nothing.
    expect(gitBashCandidates(deps({ gitExecPath: () => 'C:\\weird' }))).toEqual([]);
  });

  it('then the default install dirs, in order', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local',
    };
    expect(gitBashCandidates(deps({ env }))).toEqual([
      PF_BASH,
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
      'C:\\Users\\b\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
      'C:\\Users\\b\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe',
    ]);
    const local = 'C:\\Users\\b\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    expect(findGitBash(deps({ env, files: [local] }))).toBe(local);
  });

  it('throws with the places it looked when there is no Git Bash', () => {
    expect(() => findGitBash(deps({ env: { ProgramFiles: 'C:\\PF' } }))).toThrow(
      /Git Bash not found .*C:\\PF\\Git\\bin\\bash\.exe/,
    );
    expect(() => findGitBash(deps())).toThrow(/looked in: \(nothing\)/);
  });
});
