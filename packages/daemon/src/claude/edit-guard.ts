// ADR-0006: agents inherit the user's Claude Code settings (permission mode, rules, hooks), so a
// permission rule can no longer keep file edits inside the worktree: `Edit(./**)` only
// pre-approves, and a deny rule cannot carve the worktree out of "everywhere". This PreToolUse
// hook can: it runs before permission rules in every mode (bypassPermissions included) and
// exit code 2 blocks the call. Bash is not covered (U-004).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file tools the hook checks. */
export const EDIT_GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/**
 * The hook script. argv[2] = the worktree. Reads the PreToolUse JSON on stdin and exits 2 (block,
 * reason on stderr) unless every target path is inside the worktree. Fails closed: any error,
 * a missing or relative path, or unreadable input blocks. `~`/`~/` expand to the home directory
 * as Claude Code does. Paths are resolved component by component with lstat/readlink, so a
 * symlink (a dangling one too) and a `..` after it go where the kernel would, not where the
 * text says.
 */
export const EDIT_GUARD_SCRIPT = `import { lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const deny = (why) => {
  process.stderr.write('conductor: ' + why + '\\n');
  process.exit(2);
};
const canon = (p, depth = 0) => {
  if (depth > 40) deny('too many levels of symlinks: ' + p);
  let cur = resolve('/');
  for (const part of p.split(sep)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      // does not exist (yet): the rest of the path is literal
    }
    cur = link ? canon(resolve(cur, readlinkSync(next)), depth + 1) : next;
  }
  return cur;
};

try {
  const root = canon(resolve(process.argv[2]));
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const ti = input && typeof input.tool_input === 'object' && input.tool_input ? input.tool_input : {};
  const targets = ['file_path', 'notebook_path'].filter((k) => k in ti).map((k) => ti[k]);
  if (targets.length === 0) deny('no file path to check');
  for (const target of targets) {
    if (typeof target !== 'string' || target === '') deny('empty file path');
    const home = homedir();
    const p = target === '~' ? home : target.startsWith('~/') ? join(home, target.slice(2)) : target;
    if (!isAbsolute(p)) deny('file paths must be absolute; refused ' + target);
    const rel = relative(root, canon(p));
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      deny('file edits are limited to the session worktree (' + root + '); refused ' + target);
    }
  }
} catch (err) {
  deny('edit guard failed, so the edit is blocked: ' + (err && err.message));
}
`;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `--settings` JSON that registers the hook for `worktree`. `disableAllHooks: false` is
 * pinned: the flag scope outranks user settings, so the user's own `disableAllHooks` can't switch
 * the guard off (QA, verified against claude 2.1.309). `|| exit 2` makes a missing node or
 * script block instead of passing (only exit 2 blocks).
 */
export function editGuardSettings(scriptPath: string, worktree: string, nodeBin: string): object {
  return {
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        {
          matcher: EDIT_GUARD_MATCHER,
          hooks: [
            {
              type: 'command',
              command: `${[nodeBin, scriptPath, worktree].map(shellQuote).join(' ')} || exit 2`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write the hook script and its settings file into `dir` (the session's private 0700 directory
 * from `writeMcpConfigFile`, removed with it). Returns the settings path for `--settings`.
 * TD-083: same uid as the agent, so its Bash could rewrite the script.
 */
export function writeEditGuard(dir: string, worktree: string, nodeBin = process.execPath): string {
  const script = join(dir, 'edit-guard.mjs');
  writeFileSync(script, EDIT_GUARD_SCRIPT, { mode: 0o600, flag: 'wx' });
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify(editGuardSettings(script, worktree, nodeBin)), {
    mode: 0o600,
    flag: 'wx',
  });
  return settings;
}
