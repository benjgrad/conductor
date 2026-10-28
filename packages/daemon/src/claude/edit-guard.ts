// ADR-0006: agents inherit the user's Claude Code settings (permission mode, rules, hooks), so a
// permission rule can no longer keep file edits inside the worktree: `Edit(./**)` only
// pre-approves, and a deny rule cannot carve the worktree out of "everywhere". This PreToolUse
// hook can: it runs before permission rules in every mode (bypassPermissions included) and
// exit code 2 blocks the call. Bash is not covered (U-004).
import { join } from 'node:path';
import { hookCommand, writePrivateFile } from '../platform/index.js';

/** The file tools the hook checks. */
export const EDIT_GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/**
 * The hook script. argv[2] = the worktree. Reads the PreToolUse JSON on stdin and exits 2 (block,
 * reason on stderr) unless every target path is inside the worktree. Fails closed: any error,
 * a missing or relative path, or unreadable input blocks. `~`/`~/` expand to the home directory
 * as Claude Code does. Paths are resolved component by component with lstat/readlink, so a
 * symlink (a dangling one too) and a `..` after it go where the kernel would, not where the
 * text says.
 *
 * win32 (ADR-0024 §6), in the same script: `.`/`..` are normalised textually first, as the Win32
 * layer does before the file system sees the path. A path must start with a drive letter (`C:\` or
 * `C:/`);
 * UNC and device paths (`\\host\`, `//host/`, `\\?\`, `\\.\`, `\??\`), root- and drive-relative
 * paths and any `:` after the drive (alternate data streams) are refused. Each existing component
 * is canonicalised with `realpathSync.native`, which expands 8.3 short names (`PROGRA~1`) and
 * follows junctions (lstat reports them as links, U-105); the comparison is per drive and
 * case-insensitive. `~\` expands like `~/`.
 */
export const EDIT_GUARD_SCRIPT = String.raw`import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';
const deny = (why) => {
  process.stderr.write('conductor: ' + why + '\n');
  process.exit(2);
};
const posixCanon = (p, depth = 0) => {
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
    cur = link ? posixCanon(resolve(cur, readlinkSync(next)), depth + 1) : next;
  }
  return cur;
};
const winCanon = (raw, depth = 0) => {
  if (depth > 40) deny('too many levels of symlinks: ' + raw);
  if (/^[\\/][\\/]/.test(raw)) deny('UNC and device paths are refused: ' + raw);
  if (/^[\\/]\?\?[\\/]/.test(raw)) deny('NT object paths are refused: ' + raw);
  if (!/^[A-Za-z]:[\\/]/.test(raw)) {
    deny('file paths must start with a drive letter (C:\\...); refused ' + raw);
  }
  // Win32 normalises '.' and '..' textually before the file system follows any link, so do the
  // same first: C:\wt\link\..\..\x is C:\x whatever 'link' points at.
  const p = resolve(raw);
  let cur = p.slice(0, 2).toUpperCase() + '\\';
  for (const part of p.slice(3).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part.includes(':')) deny('alternate data streams are refused: ' + p);
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let st = null;
    try {
      st = lstatSync(next);
    } catch {
      // does not exist (yet): the rest of the path is literal
    }
    if (st === null) {
      cur = next;
    } else if (st.isSymbolicLink()) {
      let real = null;
      try {
        real = realpathSync.native(next);
      } catch {
        // dangling: follow the link text
      }
      cur = winCanon(real !== null ? real : resolve(cur, readlinkSync(next)), depth + 1);
    } else {
      cur = realpathSync.native(next);
    }
  }
  return cur;
};
const canon = WIN ? winCanon : posixCanon;
const outside = (root, p) => {
  const rel = WIN ? relative(root.toLowerCase(), p.toLowerCase()) : relative(root, p);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
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
    const tilde = target.startsWith('~/') || (WIN && target.startsWith('~\\'));
    const p = target === '~' ? home : tilde ? join(home, target.slice(2)) : target;
    if (!isAbsolute(p)) deny('file paths must be absolute; refused ' + target);
    if (outside(root, canon(p))) {
      deny('file edits are limited to the session worktree (' + root + '); refused ' + target);
    }
  }
} catch (err) {
  deny('edit guard failed, so the edit is blocked: ' + (err && err.message));
}
`;

/**
 * The `--settings` JSON that registers the hook for `worktree`. `disableAllHooks: false` is
 * pinned: the flag scope outranks user settings, so the user's own `disableAllHooks` can't switch
 * the guard off (QA, verified against claude 2.1.309). `CLAUDE_CODE_SAFE_MODE=1` (process env or
 * the user settings' `env`) also drops non-policy hooks, so the flag-scope `env` pins it to "0"
 * (QA, verified). `|| exit 2` makes a missing node or script block instead of passing (only exit
 * 2 blocks). The command is quoted for sh (POSIX) or for cmd.exe and Git Bash alike (win32,
 * platform/hook.ts; throws for a path it can't carry).
 */
export function editGuardSettings(scriptPath: string, worktree: string, nodeBin: string): object {
  return {
    disableAllHooks: false,
    env: { CLAUDE_CODE_SAFE_MODE: '0' },
    hooks: {
      PreToolUse: [
        {
          matcher: EDIT_GUARD_MATCHER,
          hooks: [
            {
              type: 'command',
              command: hookCommand([nodeBin, scriptPath, worktree]),
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
  const settings = join(dir, 'settings.json');
  // Built first: a path the hook can't carry (win32) fails before anything is written.
  const json = JSON.stringify(editGuardSettings(script, worktree, nodeBin));
  writePrivateFile(script, EDIT_GUARD_SCRIPT);
  writePrivateFile(settings, json);
  return settings;
}
