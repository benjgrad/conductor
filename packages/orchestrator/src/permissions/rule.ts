import { PERMISSION_RULE_MAX, type JsonObject } from '@conductor/shared';

// ADR-0023 §2, U-100 (Ben, 2026-10-28): the exact allow rule "Allow always" records, computed
// from the request's `tool` + `input` (`PermissionRequestDto.always_rule`). Pure. null = no exact
// rule for this call, and the UI offers only Allow once / Deny. Grammar in 10-contracts
// §Permission prompts ("always_rule grammar").

/** Claude Code's file-edit tools; their rules are written `Edit(<path>)` (one rule covers all). */
const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * Characters that would make a rule match more than this one call: `)` ends the rule, a newline
 * can't be in one, and `*` is a wildcard in Claude Code's Bash rules and its path patterns. For
 * paths also gitignore's `?`, `[`, `]` and `\`.
 */
const BASH_UNSAFE = /[)\r\n*]/;
/**
 * ADR-0027: a push reaches the board through an `ask` rule, and ask outranks allow, so an allow
 * rule for it would never take effect. Every push is Allow once or Deny.
 */
const GIT_PUSH = /\bgit\s+push\b/;
const PATH_UNSAFE = /[)\r\n*?[\]\\]/;

function str(input: JsonObject, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function bounded(rule: string): string | null {
  return rule.length <= PERMISSION_RULE_MAX ? rule : null;
}

function pathRule(name: 'Edit' | 'Write', path: string | null): string | null {
  if (path === null || !path.startsWith('/') || PATH_UNSAFE.test(path)) return null;
  // Claude Code path rules: `/p` is relative to the settings source, `//p` is absolute.
  return bounded(`${name}(/${path})`);
}

/**
 * - `Bash`: `Bash(<exact command>)`; null if the command contains `)`, a newline or `*`, or ends
 *   in `:*` (a prefix rule), and for any command with `git push` in it (ADR-0027: once only).
 * - `mcp__*`: the bare tool name.
 * - `Edit` / `MultiEdit` / `NotebookEdit`: `Edit(//<absolute path>)`; `Write`: `Write(//<absolute
 *   path>)`; null if the path isn't absolute or contains `)`, a newline or a glob character.
 * - `WebFetch`: `WebFetch(domain:<host>)` from the URL; null if it doesn't parse or has no host.
 * - Anything else: null. Any rule longer than PERMISSION_RULE_MAX: null.
 */
export function alwaysRuleFor(tool: string, input: JsonObject): string | null {
  if (tool === 'Bash') {
    const command = str(input, 'command');
    if (command === null || BASH_UNSAFE.test(command) || command.endsWith(':*')) return null;
    if (GIT_PUSH.test(command)) return null;
    return bounded(`Bash(${command})`);
  }
  if (tool.startsWith('mcp__') && tool.length > 'mcp__'.length && !/[()\s*]/.test(tool)) {
    return bounded(tool);
  }
  const editKey = EDIT_TOOLS[tool];
  if (editKey !== undefined) return pathRule('Edit', str(input, editKey));
  if (tool === 'Write') return pathRule('Write', str(input, 'file_path'));
  if (tool === 'WebFetch') {
    const url = str(input, 'url');
    if (url === null) return null;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    if (host === '' || /[()\s*]/.test(host)) return null;
    return bounded(`WebFetch(domain:${host})`);
  }
  return null;
}
