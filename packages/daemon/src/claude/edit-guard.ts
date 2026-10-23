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
 * reason on stderr) unless the target path resolves inside the worktree. Symlinks are followed
 * through the deepest existing ancestor, so a link inside the worktree can't point out of it.
 */
export const EDIT_GUARD_SCRIPT = `import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const deny = (why) => {
  process.stderr.write('conductor: ' + why + '\\n');
  process.exit(2);
};
const real = (p) => {
  const tail = [];
  for (let cur = p; ; ) {
    try {
      return resolve(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
};

const root = real(resolve(process.argv[2]));
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
} catch {
  deny('unreadable hook input');
}
const ti = (input && input.tool_input) || {};
const target = ti.file_path ?? ti.notebook_path;
if (typeof target !== 'string' || target === '') deny('no file path to check');
const rel = relative(root, real(resolve(input.cwd || root, target)));
if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
  deny('file edits are limited to the session worktree (' + root + '); refused ' + target);
}
`;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `--settings` JSON that registers the hook for `worktree`. */
export function editGuardSettings(scriptPath: string, worktree: string, nodeBin: string): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: EDIT_GUARD_MATCHER,
          hooks: [
            {
              type: 'command',
              command: [nodeBin, scriptPath, worktree].map(shellQuote).join(' '),
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
