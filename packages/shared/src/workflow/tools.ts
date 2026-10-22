// Workflow `tools` names → ADR-0005 ToolPolicy fragments (09 §Controls, 10-contracts §Tools).
// The engine passes a state's raw `tools` list in start_session; the daemon (T05) resolves it
// with `resolveToolPolicy` and hands the result to the driver as `DriverStartOptions.tools`.
// The validator (T03) rejects names not in TOOL_ALIAS_NAMES.
//
// Rules from ADR-0005: under `--permission-mode dontAsk`, anything not in `allow` is denied.
// File-writing tools are always path-scoped (`Edit(./**)`, `Write(./**)`): a bare `Edit` escapes
// the worktree. Bash entries are prefix rules. `git push` is always denied for agents (command /
// connector states push). The conductor MCP outcome tools are added by the driver, not here.

/** Same shape as the daemon's `ToolPolicy` (daemon/src/claude/driver.ts). */
export interface ToolPolicyFragment {
  /** `--tools`: visible built-ins. */
  builtin: readonly string[];
  /** `--allowedTools` rules. */
  allow: readonly string[];
  /** `--disallowedTools` rules. */
  deny: readonly string[];
}

/** Every agent gets read-only access to its worktree, and never `git push`. */
export const BASE_TOOL_POLICY: ToolPolicyFragment = {
  builtin: ['Read', 'Glob', 'Grep'],
  allow: ['Read(./**)', 'Glob(./**)', 'Grep(./**)'],
  deny: ['Bash(git push:*)'],
};

// Inspection commands are exact matches: diff/log/show accept `--output=<file>`, so an open
// `git diff:*` prefix would be an arbitrary file write. Global options (`git -c`, `--exec-path`)
// can't match any rule because every rule starts with `git <subcommand>`.
const GIT_EXACT = [
  'status',
  'status --short',
  'diff',
  'diff --cached',
  'diff --stat',
  'log --oneline -n 20',
  'rev-parse HEAD',
  'branch --show-current',
];
const GIT_PREFIX = ['add', 'commit -m', 'restore'];

export const TOOL_ALIASES = {
  /** Read only (the base policy). */
  read: { builtin: [], allow: [], deny: [] },
  /** Edit/write files inside the worktree. */
  edit: {
    builtin: ['Edit', 'Write'],
    allow: ['Edit(./**)', 'Write(./**)'],
    deny: [],
  },
  /**
   * Shell for building and testing the repo's own scripts. No interpreters or general runners
   * (node/npx/pnpm/cat). TD-019: `npm run`/`npm install` still execute repo-defined code the agent
   * can edit, so this is not a security boundary; that needs the sandbox (U-004).
   */
  bash: {
    builtin: ['Bash'],
    allow: ['Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(npm install)', 'Bash(npm ci)'],
    deny: [],
  },
  /** Local git: inspect, stage, commit. Never push. */
  git: {
    builtin: ['Bash'],
    allow: [
      ...GIT_EXACT.map((c) => `Bash(git ${c})`),
      ...GIT_PREFIX.map((c) => `Bash(git ${c}:*)`),
    ],
    deny: [],
  },
  /**
   * The PR skill (pr_flow `open_pr`, M3). `gh pr create` can push the branch, so agents only get
   * the Skill tool and `gh pr view`; pushing and creating the PR belong to a trusted command or
   * connector state (TD-020).
   */
  pr_skill: {
    builtin: ['Skill', 'Bash'],
    allow: ['Skill', 'Bash(gh pr view:*)'],
    deny: ['Bash(gh pr create:*)'],
  },
} as const satisfies Record<string, ToolPolicyFragment>;

export type ToolAlias = keyof typeof TOOL_ALIASES;
export const TOOL_ALIAS_NAMES = Object.keys(TOOL_ALIASES) as ToolAlias[];

export function isToolAlias(name: string): name is ToolAlias {
  return Object.prototype.hasOwnProperty.call(TOOL_ALIASES, name);
}

export class UnknownToolAliasError extends Error {
  constructor(readonly names: string[]) {
    super(`unknown workflow tool name(s): ${names.join(', ')}`);
    this.name = 'UnknownToolAliasError';
  }
}

/**
 * The base policy merged with each alias's fragment, de-duplicated, in a stable order. Deny
 * wins: an `allow` rule that also appears in `deny` is dropped. Throws UnknownToolAliasError.
 */
export function resolveToolPolicy(tools: readonly string[]): {
  builtin: string[];
  allow: string[];
  deny: string[];
} {
  const unknown = tools.filter((t) => !isToolAlias(t));
  if (unknown.length > 0) throw new UnknownToolAliasError(unknown);
  const frags = [BASE_TOOL_POLICY, ...tools.map((t) => TOOL_ALIASES[t as ToolAlias])];
  const uniq = (xs: readonly string[]) => [...new Set(xs)];
  const deny = uniq(frags.flatMap((f) => f.deny));
  return {
    builtin: uniq(frags.flatMap((f) => f.builtin)),
    allow: uniq(frags.flatMap((f) => f.allow)).filter((r) => !deny.includes(r)),
    deny,
  };
}
