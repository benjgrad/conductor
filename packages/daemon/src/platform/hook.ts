// ADR-0024 §6: a Claude Code hook `command` string that runs `argv` the same way whichever shell
// Claude uses for hooks (U-104: Git Bash or cmd.exe on Windows), and blocks when it can't run.
//
// POSIX: each word single-quoted for sh, then `|| exit 2` (a missing node or script blocks: only
// exit 2 blocks a tool call).
// win32: each word in double quotes with forward slashes, then `|| exit 2`. Inside double quotes
// both cmd.exe and bash keep spaces, `'`, `&`, `(` literal, and both read `||` and `exit 2` the
// same way (a missing program is 9009 in cmd, 127 in bash, so `|| exit 2` blocks). What the two
// shells would still interpret inside double quotes is refused: `"` (ends the quote), `%` (cmd
// expansion), `!` and `^` (cmd with delayed expansion), `$` and a backtick (bash expansion).

const isWin32 = (): boolean => process.platform === 'win32';

/** Characters a win32 hook word can't carry (see the header). */
export const WIN_HOOK_UNSAFE = /["%!^$`]/;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The hook command for `argv`. Throws on win32 when a word holds a character it can't carry, with
 * a message naming it (the session start fails instead of the guard failing open or shut).
 */
export function hookCommand(argv: readonly string[]): string {
  if (!isWin32()) return `${argv.map(shellQuote).join(' ')} || exit 2`;
  for (const word of argv) {
    const bad = WIN_HOOK_UNSAFE.exec(word);
    if (bad) {
      throw new Error(
        `cannot build the edit-guard hook: ${word} contains ${JSON.stringify(bad[0])}, which ` +
          `cmd.exe or Git Bash would reinterpret; set CONDUCTOR_ROOT to a path without "%!^$\``,
      );
    }
  }
  return `${argv.map((w) => `"${w.replace(/\\/g, '/')}"`).join(' ')} || exit 2`;
}
