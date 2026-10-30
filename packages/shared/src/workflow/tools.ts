// Workflow `tools` names → ADR-0005 ToolPolicy fragments (09 §Controls, 10-contracts §Tools).
// The engine passes a state's raw `tools` list in start_session; the daemon (T05) resolves it
// with `resolveToolPolicy` and hands the result to the driver as `DriverStartOptions.tools`.
// The validator (T03) rejects names not in TOOL_ALIAS_NAMES.
//
// Rules from ADR-0005, amended by ADR-0006: `builtin` limits the visible tools; `allow` rules are
// pre-approved on top of the user's own Claude Code settings (their mode decides the rest);
// `deny` holds in every mode. File-writing tools are always path-scoped (`Edit(./**)`, `Write(./**)`): a bare `Edit` escapes
// the worktree. Bash entries are prefix rules. `git push` is denied in the policy; ADR-0027: a
// worker whose prompts reach the board gets it as an `ask` rule instead (PROMPTABLE_DENY_RULES),
// so each push needs a human's click. The conductor MCP outcome tools are added by the driver.

/** Same shape as the daemon's `ToolPolicy` (daemon/src/claude/driver.ts). */
export interface ToolPolicyFragment {
  /** `--tools`: visible built-ins. */
  builtin: readonly string[];
  /** `--allowedTools` rules. */
  allow: readonly string[];
  /** `--disallowedTools` rules. */
  deny: readonly string[];
}

/** Every agent gets read-only access to its worktree, and no unapproved `git push`. */
export const BASE_TOOL_POLICY: ToolPolicyFragment = {
  builtin: ['Read', 'Glob', 'Grep'],
  allow: ['Read(./**)', 'Glob(./**)', 'Grep(./**)'],
  deny: ['Bash(git push:*)'],
};

/**
 * ADR-0027: deny rules that become `ask` rules when a human can answer the session's permission
 * prompts (a worker with `--permission-prompts host`). Ask outranks every allow rule and auto
 * mode's classifier, so the call always reaches the board. Reviewers and the no-prompt fallback
 * keep them as denies. TD-196: any push is promptable, not only to the session's branch.
 */
export const PROMPTABLE_DENY_RULES: readonly string[] = ['Bash(git push:*)'];

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
// `commit` is a prefix rule on purpose: agents write `git commit -q -m …`, `-am`, `-F -`, etc.,
// and a `commit -m:*` prefix denied all of those (found driving a real session). commit has no
// file-writing flag like diff's --output, and hooks live in the shared .git the agent can't edit.
// TD-082: it does match `commit -F <any file>`; narrow it now that auto mode judges the rest.
const GIT_PREFIX = ['add', 'commit', 'restore'];

/**
 * ADR-0009: the git inspection commands a requirements reviewer may run, all exact (TD-082
 * caution: diff/log/show accept `--output=<file>`, so no prefix rules). Enough to see the
 * uncommitted work and the last commits; the review prompt lists them (engine/review.ts).
 * TD-091: no exact rule diffs against the branch base (its sha isn't recorded).
 */
export const REVIEW_GIT_COMMANDS: readonly string[] = [
  'git status',
  'git status --short',
  'git diff',
  'git diff --cached',
  'git diff --stat',
  'git diff HEAD~1',
  'git diff --stat HEAD~1',
  'git log --oneline -n 20',
  'git log --stat -n 10',
  'git log -p -n 5',
  'git show',
  'git show --stat',
  'git rev-parse HEAD',
  'git branch --show-current',
];

/**
 * ADR-0020 §2: fixed diff commands against `qa-base`, the ref the daemon creates at the merge base
 * in a QA checkout (exact, for the same `--output` reason as above).
 */
export const QA_GIT_COMMANDS: readonly string[] = [
  'git diff --stat qa-base...HEAD',
  'git diff qa-base...HEAD',
  'git log --oneline qa-base..HEAD',
];

/** ADR-0020 §2: the test runners a QA session may run (prefixes, then exact commands). */
const QA_TEST_PREFIXES = ['pnpm test', 'pnpm vitest', 'pnpm exec vitest', 'npm test', 'npm run'];
const QA_TEST_EXACT = ['pnpm typecheck', 'pnpm lint'];

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
   * Shell for building and testing the repo's own scripts, with npm or pnpm (M2-T30). No
   * interpreters or general runners (node/npx/`pnpm exec`/`pnpm dlx`/cat): `pnpm exec` is allowed
   * only for vitest, prettier, eslint and `tsc -b`, and the installs are exact (`pnpm install` /
   * `pnpm i`, each also with `--frozen-lockfile`; no `pnpm add`). M2-T30b: the script shorthands
   * agents actually type (`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm format`, exact, as in
   * ADR-0020's `qa` alias) and `pnpm vitest:*`; without them every gate run was silently denied
   * under `--permission-prompts none`. TD-019: `npm run`/`pnpm run`/the installs still execute
   * repo-defined code the agent can edit (scripts, lifecycle hooks, tool config files), and
   * `chmod +x:*` is a prefix rule that can make any file executable, in or outside the worktree
   * (TD-175), so this is not a security boundary; that needs the sandbox (U-004).
   */
  bash: {
    builtin: ['Bash'],
    allow: [
      'Bash(npm run:*)',
      'Bash(npm test:*)',
      'Bash(npm install)',
      'Bash(npm ci)',
      'Bash(pnpm run:*)',
      'Bash(pnpm test:*)',
      'Bash(pnpm install)',
      'Bash(pnpm i)',
      'Bash(pnpm install --frozen-lockfile)',
      'Bash(pnpm i --frozen-lockfile)',
      'Bash(pnpm typecheck)',
      'Bash(pnpm lint)',
      'Bash(pnpm build)',
      'Bash(pnpm format)',
      'Bash(pnpm vitest:*)',
      'Bash(pnpm exec vitest:*)',
      'Bash(pnpm exec prettier:*)',
      'Bash(pnpm exec eslint:*)',
      'Bash(pnpm exec tsc -b)',
      // TD-175: a prefix rule, so it also matches `-R`, absolute paths and `--reference=`.
      'Bash(chmod +x:*)',
    ],
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
   * The requirements reviewer (ADR-0009): the read base plus exact git inspection commands. No
   * edit tools, no staging or committing. The engine gives a reviewer only this alias.
   */
  review: {
    builtin: ['Bash'],
    allow: REVIEW_GIT_COMMANDS.map((c) => `Bash(${c})`),
    deny: [],
  },
  /**
   * A `role: 'qa'` state (ADR-0020 §2), run in forced dontAsk: the read base, the reviewer's git
   * commands plus the `qa-base` diffs, and test runners. No tool can change the PR (U-085): no
   * Edit/Write, no staging or committing, no gh. The test runners execute repository code, so
   * this is not a security boundary (TD-019, U-004).
   */
  qa: {
    builtin: ['Bash'],
    allow: [
      ...[...REVIEW_GIT_COMMANDS, ...QA_GIT_COMMANDS].map((c) => `Bash(${c})`),
      ...QA_TEST_PREFIXES.map((c) => `Bash(${c}:*)`),
      ...QA_TEST_EXACT.map((c) => `Bash(${c})`),
    ],
    deny: ['Edit', 'Write', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(gh:*)'],
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
