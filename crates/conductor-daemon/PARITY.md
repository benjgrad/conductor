# PARITY: TS daemon tests → Rust tests

The ledger of ADR-0026 §3. Every test case of the frozen TS daemon (`packages/daemon/src/**/*.test.ts`, tag
`daemon-ts-freeze`) has one row here. `node scripts/test-parity.js` checks it in `scripts/ci.sh`;
`--write` regenerates this file and keeps every Rust cell and tick.

- **Key:** `<file> › <describe…> › <title>`, with the file relative to `packages/daemon/src`. An `it.each` is one
  row (its title template). A repeated key gets ` [2]`. A `|` in a title is written `\|`.
- **Rust cell:** `todo`, or `dropped: <reason>` (needs Ben's OK in review), or one or more comma-separated
  `<repo path>.rs::…::<fn>`, e.g. `crates/conductor-daemon/tests/seam.rs::no_os_cfg_outside_platform`. The file
  and the `fn` must exist.
- **Ported:** tick your files in the list below (`[x]`) when your ticket ports them; extra `- [x] <glob>` lines
  are allowed. A ported file may have no `todo` row. Edit only your own lines: the blank lines between entries
  and the per-file sections keep parallel tickets from conflicting.

## Ported

<!-- parity:ported:start -->
- [ ] `actions/checkout.test.ts`

- [ ] `actions/conditions.test.ts`

- [ ] `actions/open-pr.gh-version.test.ts`

- [ ] `actions/open-pr.test.ts`

- [ ] `claude/cli-driver.real.test.ts`

- [ ] `claude/cli-driver.test.ts`

- [ ] `claude/edit-guard.test.ts`

- [ ] `claude/fake-driver.test.ts`

- [ ] `claude/outcome-server.test.ts`

- [ ] `claude/stream-parser.test.ts`

- [ ] `claude/transcript.test.ts`

- [ ] `commands/config.test.ts`

- [ ] `commands/enroll.test.ts`

- [ ] `commands/fake-runner.test.ts`

- [ ] `commands/process-runner.test.ts`

- [ ] `credential.test.ts`

- [ ] `daemon.kill.test.ts`

- [ ] `daemon.test.ts`

- [ ] `index.test.ts`

- [ ] `inventory/capabilities.test.ts`

- [ ] `inventory/report.test.ts`

- [ ] `inventory/repos.test.ts`

- [ ] `inventory/version.test.ts`

- [ ] `orphan.test.ts`

- [ ] `platform/acl.test.ts`

- [ ] `platform/index.test.ts`

- [ ] `platform/kill-tree.test.ts`

- [ ] `platform/procinfo.test.ts`

- [x] `platform/seam.test.ts`

- [ ] `platform/shell.test.ts`

- [ ] `platform/spawn.test.ts`

- [ ] `platform/sysres.test.ts`

- [ ] `reopen-transcript.test.ts`

- [ ] `sysinfo.test.ts`

- [ ] `test-support/fake-bin.test.ts`

- [ ] `units.test.ts`

- [ ] `workspace.fresh-base.test.ts`

- [ ] `workspace.test.ts`

- [ ] `ws-client.test.ts`
<!-- parity:ported:end -->

## Cases

### actions/checkout.test.ts

| TS case | Rust |
|---|---|
| actions/checkout.test.ts › freshCheckout › checks out exactly the commit in a 0700 dir under <root>/private, not the worktree | todo |
| actions/checkout.test.ts › freshCheckout › a filter driver / hooks planted in the shared clone do not execute | todo |
| actions/checkout.test.ts › freshCheckout › refuses when the branch tip is not the commit to check (reports the tip), leaving nothing | todo |
| actions/checkout.test.ts › freshCheckout › setup: configured, "" = none, else auto-detect (lockfile → npm ci, package.json → npm install) | todo |
| actions/checkout.test.ts › freshCheckout › sweepPrivate does not follow a symlinked <root>/private | todo |
| actions/checkout.test.ts › freshCheckout › sweepPrivate removes leftovers of a previous daemon | todo |
| actions/checkout.test.ts › package manager from the lockfile › %s → %s, setup `%s` | todo |
| actions/checkout.test.ts › package manager from the lockfile › no lockfile: package.json → npm install; neither → no setup | todo |
| actions/checkout.test.ts › package manager from the lockfile › pnpm wins over the other lockfiles, yarn over package-lock.json | todo |
| actions/checkout.test.ts › package manager from the lockfile › runs npm-style checks with the repo’s manager; npm and non-Node repos unchanged | todo |
| actions/checkout.test.ts › package manager from the lockfile › names a package manager missing from PATH; present ones and other commands pass | todo |

### actions/conditions.test.ts

| TS case | Rust |
|---|---|
| actions/conditions.test.ts › evaluate_conditions with a fake gh › runs one gh pr view with the --json fields, outside any repo, with the hardened env | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › checks: all success → met; a failure → failed; in progress → pending | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › approvals: 0/1 → pending, 1/1 → met, changes requested → failed | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › only owners, members and collaborators count; never the PR author (security review) | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › reviewDecision: REVIEW_REQUIRED → pending, CHANGES_REQUESTED → failed, empty → the count | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › an approval on an older commit is stale; changes requested blocks on any commit | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › head_sha: a moved PR head fails every PR condition; absent = no head check | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › approvals count the latest verdict per reviewer | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › merged → met, open → pending, closed → failed | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › results follow the conditions by position; M5 types are unsupported | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › only unsupported conditions: gh is not run | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › gh missing → every gh condition pending with "gh not available" | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › gh not logged in → pending with "gh not available" | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › another gh failure → pending with its stderr | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › output over 16 KB is truncated and the conditions stay pending | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › a gh that hangs is killed at the timeout → pending | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › no PR yet, or a URL that is not a GitHub PR → pending without running gh | todo |
| actions/conditions.test.ts › evaluate_conditions with a fake gh › unparseable output → pending | todo |
| actions/conditions.test.ts › condition mapping (pure) › parsePrView reads the unprojected gh shape too | todo |
| actions/conditions.test.ts › condition mapping (pure) › a failing check names its https link so the agent can read the log; others are dropped | todo |
| actions/conditions.test.ts › condition mapping (pure) › no checks at all reports NO_PR_CHECKS_VALUE, which the engine keys no_checks_after on | todo |
| actions/conditions.test.ts › pr_screenshots (M2-T35a) › asks gh for the files and the pair count only when a pr_screenshots condition is there | todo |
| actions/conditions.test.ts › pr_screenshots (M2-T35a) › no UI file changed → met, whatever the body | todo |
| actions/conditions.test.ts › pr_screenshots (M2-T35a) › a UI file changed: enough pairs in the body → met; fewer → failed, telling the agent what to do | todo |
| actions/conditions.test.ts › pr_screenshots (M2-T35a) › more files than gh lists counts as touching the UI; many UI files are summarised | todo |
| actions/conditions.test.ts › pr_screenshots (M2-T35a) › a moved head fails it like every PR condition; no file list keeps it pending | todo |

### actions/open-pr.gh-version.test.ts

| TS case | Rust |
|---|---|
| actions/open-pr.gh-version.test.ts › open_pr gh version floor (M2-T10) › gh 2.14.0 → refused with the upgrade message; nothing is pushed | todo |
| actions/open-pr.gh-version.test.ts › open_pr gh version floor (M2-T10) › an unparsable version is refused too; nothing is pushed | todo |
| actions/open-pr.gh-version.test.ts › open_pr gh version floor (M2-T10) › gh %s proceeds: pushed and the PR opened | todo |

### actions/open-pr.test.ts

| TS case | Rust |
|---|---|
| actions/open-pr.test.ts › open_pr (ADR-0010) › pushes the branch to the ticket repo and opens the PR with gh --repo/--head/--base | todo |
| actions/open-pr.test.ts › open_pr (ADR-0010) › reuses the existing PR for the branch (idempotent repeat) | todo |
| actions/open-pr.test.ts › open_pr (ADR-0010) › a missing gh is a clear error | todo |
| actions/open-pr.test.ts › open_pr (ADR-0010) › a failed gh pr create reports the error | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › an agent-planted pre-push hook in the shared clone does not run | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › a rewritten remote.origin.url does not redirect the push (explicit trusted URL) | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › the push never reads the shared clone's config: planted redirects and hooks are ignored | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › a config change racing between the fetch and the push can't matter | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › the push repo is a fresh 0700 dir under <root>/private with git's minimal config, deleted after | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › a symlinked <root>/private is refused (nothing followed, nothing pushed) | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › a commit made after the checks makes the action refuse; nothing is pushed | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › a gh URL that is not a GitHub PR URL is not reported | todo |
| actions/open-pr.test.ts › open_pr hardening (security review 2026-10-23) › resolveHead reports the worktree HEAD | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › a clean tree reports its HEAD | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › modified, staged and untracked files are dirty (the status lines); no HEAD | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › .gitignore'd files (build outputs) do not count | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › assume-unchanged hides nothing: dirty | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › skip-worktree hides nothing: dirty | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › an untracked file listed in .git/info/exclude (shared clone) is dirty | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › QA 1a: an uncommitted .gitignore that ignores itself (and a file) is dirty | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › QA 1a: a nested self-ignoring .gitignore is dirty too | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › QA 1b: submodule changes hidden by submodule.<name>.ignore=all are dirty | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › an untracked file matched by a repo-config core.excludesFile is dirty | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › a planted core.fsmonitor / hooks in the shared clone do not run | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › a non-allowlisted repo (local path, another host) is a clear error, nothing pushed | todo |
| actions/open-pr.test.ts › checkClean (ADR-0010: only committed changes are checked) › pushTarget: GitHub over https / ssh only, owner/name for gh | todo |

### claude/cli-driver.real.test.ts

| TS case | Rust |
|---|---|
| claude/cli-driver.real.test.ts › real claude CLI: flags › accepts the exact ADR-0005 argv and exits 0 on stdin EOF | todo |
| claude/cli-driver.real.test.ts › real claude CLI: ask_user round trip (spends money) › asks, takes the live answer, completes | todo |
| claude/cli-driver.real.test.ts › real claude CLI: permission prompt round trip (spends money) › auto mode: git push reaches the prompt tool through its ask rule, is allowed, and pushes | todo |

### claude/cli-driver.test.ts

| TS case | Rust |
|---|---|
| claude/cli-driver.test.ts › buildClaudeArgs › emits exactly the ADR-0005/ADR-0006 flags for a new session | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0009: a reviewer always runs in dontAsk and never prompts; ADR-0023: a worker runs in auto | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0023 fallback (old CLI): the pre-ADR-0023 flags, the user mode or the bypass cap, prompts denied | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0027: a host worker gets git push as an ask rule, not a deny; nobody pre-approves it | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0027: a reviewer and the no-prompt fallback keep git push denied (nobody could answer) | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0023: detects auto mode and --permission-prompts in claude --help | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › uses --resume for resume, omits unset optionals and an empty deny list | todo |
| claude/cli-driver.test.ts › buildClaudeArgs › writes stream-json user messages | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0011: an unknown transition is nudged once, then the named one is forwarded with its reason | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ask_user → park → sendInput → complete_state → end() → exit 0 | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0007: sendMessage is folded into the running turn (a slash command passes through) | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0007: sendMessage is not an answer: a pending ask_user question stays pending | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: --settings is the edit-guard hook for the worktree, beside mcp.json, removed on exit | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: agentEnv passes only allowlisted state keys and pins connectors and safe mode off | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: logs the state env keys it dropped | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: caps the user defaultMode bypassPermissions to auto; leaves others alone | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › M1-T14: the MCP URL token never appears in argv; it is in a 0600 file, removed on exit | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › resume continues the script and the cumulative spend (TD-001) | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › resume of an unknown session exits non-zero, like the real CLI | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › kill(): SIGTERM first; SIGKILL after the grace period when SIGTERM is ignored (TD-003) | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › kill() of a cooperative process exits on SIGTERM and never escalates | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › end() escalates to kill when the process ignores stdin EOF | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › parses leniently: raw lines and stderr pass through, a crash still reports exit | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › reports error turns and permission denials; refuses a guarded complete_state | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › a missing binary yields stderr output and an exit event | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › U-110: a claude.cmd is refused with the install hint, before anything is registered | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a held call resolves on allow: Claude gets the input back | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a held call resolves on deny with the default text | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a held call is denied at the timeout | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › kill while held: the call is denied and the process exits | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a worker announces auto mode; an old CLI falls back to the old flags with a warning | todo |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › defaults claudeBin to $CONDUCTOR_CLAUDE_BIN | todo |

### claude/edit-guard.test.ts

| TS case | Rust |
|---|---|
| claude/edit-guard.test.ts › edit guard settings › matches the file tools and pins the hook kill switches off (disableAllHooks, safe mode) | todo |
| claude/edit-guard.test.ts › edit guard settings › ADR-0027: ask rules go in permissions.ask | todo |
| claude/edit-guard.test.ts › edit guard settings › writes the script and settings 0600 (win32: owner-only DACL) | todo |
| claude/edit-guard.test.ts › edit guard settings › a path cmd.exe or Git Bash would reinterpret is refused at setup | todo |
| claude/edit-guard.test.ts › edit guard › allows absolute paths inside the worktree, including new files in new directories | todo |
| claude/edit-guard.test.ts › edit guard › blocks paths outside the worktree with exit 2 and a reason | todo |
| claude/edit-guard.test.ts › edit guard › expands ~ like Claude Code and blocks home paths; refuses relative paths | todo |
| claude/edit-guard.test.ts › edit guard › follows symlinks: to an existing dir, to a missing target, and `..` after a link | todo |
| claude/edit-guard.test.ts › edit guard › checks every path field, not just the first | todo |
| claude/edit-guard.test.ts › edit guard › fails closed: bad input, odd types, a guard crash, a missing script | todo |
| claude/edit-guard.test.ts › edit guard › fails closed when node itself is missing (only exit 2 blocks) | todo |
| claude/edit-guard.test.ts › edit guard path forms (win32) › allows and blocks the right path forms | todo |

### claude/fake-driver.test.ts

| TS case | Rust |
|---|---|
| claude/fake-driver.test.ts › FakeClaudeDriver › runs ask_user → live answer → complete_state, then exits 0 on end() | todo |
| claude/fake-driver.test.ts › FakeClaudeDriver › continues the script and cumulative spend on resume | todo |
| claude/fake-driver.test.ts › FakeClaudeDriver › refuses complete_state while a question is pending, and a second one | todo |
| claude/fake-driver.test.ts › FakeClaudeDriver › models a crash mid-turn | todo |

### claude/outcome-server.test.ts

| TS case | Rust |
|---|---|
| claude/outcome-server.test.ts › outcome server › binds 127.0.0.1 and issues a 128-bit path token per session | todo |
| claude/outcome-server.test.ts › outcome server › lists exactly complete_state, ask_user and (ADR-0023) permission | todo |
| claude/outcome-server.test.ts › outcome server › ask_user returns at once with the ADR text; complete_state after the answer records | todo |
| claude/outcome-server.test.ts › outcome server › attributes calls to the session that owns the token | todo |
| claude/outcome-server.test.ts › outcome server › rejects invalid arguments without emitting | todo |
| claude/outcome-server.test.ts › outcome server › 404s unknown and unregistered tokens, 405s non-POST, 403s foreign Host headers | todo |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › emits a valid name with its reason | todo |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › refuses an unknown name once with the allowed list, then emits the next one as is | todo |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › a missing transition means done: nudged when done is not allowed | todo |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › no list (old workflows, reviewers): any name passes | todo |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › the tool description lists the transitions | todo |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › caps transition and reason at the tool call | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › holds the call until allow once: Claude gets the input back | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › allow always with a rule adds a session rule so this process does not ask again | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › deny: the human note, or the default text | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › denies itself at the timeout; a later decision is unknown | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › U-101: input over 64 KiB is denied at once and never sent | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › passes suggestions within bounds, drops them over the bounds | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › denyPermission (an old server) denies the held call at once | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › unregister (process gone) denies every held call; later prompts too | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › close (daemon shutdown) denies every held call | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › no handler: denied at once | todo |
| claude/outcome-server.test.ts › ADR-0023 permission tool › parses exact rules into toolName / ruleContent | todo |

### claude/stream-parser.test.ts

| TS case | Rust |
|---|---|
| claude/stream-parser.test.ts › parseStreamLine › reads session id and CLI version from system/init | todo |
| claude/stream-parser.test.ts › parseStreamLine › maps result to spend (cumulative total, per-turn usage) then turn_end | todo |
| claude/stream-parser.test.ts › parseStreamLine › result without a cost still ends the turn; error results are flagged | todo |
| claude/stream-parser.test.ts › parseStreamLine › maps assistant text and tool_use blocks, drops thinking | todo |
| claude/stream-parser.test.ts › parseStreamLine › maps user tool_result content (string or blocks) | todo |
| claude/stream-parser.test.ts › parseStreamLine › is lenient: garbage, non-objects and unknown types become debug output | todo |
| claude/stream-parser.test.ts › parseStreamLine › drops system/thinking_tokens progress estimates | todo |

### claude/transcript.test.ts

| TS case | Rust |
|---|---|
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › maps a real-shaped transcript to the live parser streams, skipping everything else | todo |
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › renders assistant and tool lines exactly like the live stream parser | todo |
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › cuts each tool result at TRANSCRIPT_RESULT_CHARS with a marker | todo |
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › keeps the most recent chunks within TRANSCRIPT_MAX_BYTES | todo |
| claude/transcript.test.ts › findTranscript › uses the realpath slug of the cwd, even when the worktree is gone | todo |
| claude/transcript.test.ts › findTranscript › falls back to the newest project dir holding the id (a resume from another cwd) | todo |
| claude/transcript.test.ts › findTranscript › refuses an id that is not a uuid (never a path) | todo |
| claude/transcript.test.ts › findTranscript › readTranscriptTail reads a small file whole | todo |
| claude/transcript.test.ts › hasTranscriptInCwd (the resume check) › only the cwd's own project dir counts (claude --resume looks nowhere else) | todo |
| claude/transcript.test.ts › hasTranscriptInCwd (the resume check) › refuses an id that is not a uuid | todo |

### commands/config.test.ts

| TS case | Rust |
|---|---|
| commands/config.test.ts › config.json › missing → defaults; round-trips at 0600 | todo |
| commands/config.test.ts › config.json › invalid JSON or shape → an error naming the file | todo |
| commands/config.test.ts › loadConfig inventory env › CONDUCTOR_ROOTS (`path.delimiter`-separated) overrides the file; unset → null | todo |
| commands/config.test.ts › loadConfig inventory env › CONDUCTOR_ROOTS with drive letters: `C:\a;D:\b` is two roots | todo |
| commands/config.test.ts › loadConfig inventory env › CONDUCTOR_TEST_REMOTE_ALIASES is ignored without CONDUCTOR_ALLOW_LOCAL_REPOS | todo |
| commands/config.test.ts › loadConfig inventory env › a bad alias throws (with the flag) | todo |
| commands/config.test.ts › conductor-daemon config › roots: saves realpaths (deduped) at 0600 | todo |
| commands/config.test.ts › conductor-daemon config › roots: a missing directory or none → 2, nothing written | todo |
| commands/config.test.ts › conductor-daemon config › repo --mode checkout: stored by path; warns when not under a root | todo |
| commands/config.test.ts › conductor-daemon config › repo: a bad mode, a non-repo or extra args → 2 | todo |
| commands/config.test.ts › conductor-daemon config › show: the file, effective roots and repos; CONDUCTOR_ROOTS wins | todo |
| commands/config.test.ts › conductor-daemon config › no or an unknown subcommand → usage, 2 | todo |

### commands/enroll.test.ts

| TS case | Rust |
|---|---|
| commands/enroll.test.ts › conductor-daemon enroll › posts the token and writes machine.json 0600 in a 0700 root | todo |
| commands/enroll.test.ts › conductor-daemon enroll › a 401 leaves no file and says the token is expired or used | todo |
| commands/enroll.test.ts › conductor-daemon enroll › refuses an existing file without --force (no request sent) and replaces it with --force | todo |
| commands/enroll.test.ts › conductor-daemon enroll › refuses a symlinked root without sending a request | todo |
| commands/enroll.test.ts › conductor-daemon enroll › refuses a symlinked machine.json even with --force | todo |
| commands/enroll.test.ts › conductor-daemon enroll › a 429 says to retry later | todo |
| commands/enroll.test.ts › conductor-daemon enroll › a network failure says the server cannot be reached | todo |
| commands/enroll.test.ts › conductor-daemon enroll › another status names it and its error code | todo |
| commands/enroll.test.ts › conductor-daemon enroll › never follows a redirect: the target gets no request and no file is written | todo |
| commands/enroll.test.ts › conductor-daemon enroll › an empty or over-long --token is a usage error naming the flag | todo |
| commands/enroll.test.ts › conductor-daemon enroll › refuses plain http to a non-loopback host and missing options | todo |
| commands/enroll.test.ts › enroll token sources (TD-117) › takes the token from CONDUCTOR_ENROLL_TOKEN and removes it from the environment | todo |
| commands/enroll.test.ts › enroll token sources (TD-117) › --token wins over the environment, which is still removed | todo |
| commands/enroll.test.ts › enroll token sources (TD-117) › --token - reads the first line of stdin | todo |
| commands/enroll.test.ts › enroll token sources (TD-117) › an empty or over-long token from stdin or the environment is the same usage error | todo |
| commands/enroll.test.ts › enroll token sources (TD-117) › no token anywhere is a usage error naming both sources | todo |
| commands/enroll.test.ts › enrollUrl › keeps https and loopback http, without a trailing slash | todo |

### commands/fake-runner.test.ts

| TS case | Rust |
|---|---|
| commands/fake-runner.test.ts › FakeCommandRunner › scripts exit codes, output and timeouts | todo |
| commands/fake-runner.test.ts › FakeCommandRunner › queues the third of three commands with limit 2 and reports build_slot | todo |
| commands/fake-runner.test.ts › FakeCommandRunner › resolves with SIGTERM on abort | todo |
| commands/fake-runner.test.ts › FakeCommandRunner › aborting a queued run keeps the next waiter queued until a slot frees | todo |

### commands/process-runner.test.ts

| TS case | Rust |
|---|---|
| commands/process-runner.test.ts › createCommandRunner › returns the real runner with the given semaphore size | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › exit 0: runs in cwd with merged env and streams output | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › non-zero exit is a result, not a rejection | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › timeout: kills the whole process group and reports timedOut | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › timeout escalates to SIGKILL when SIGTERM is ignored | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › abort (WS kill) terminates a running command | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › semaphore: 3 concurrent requests with limit 2 queue the third | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › aborting a queued command resolves SIGTERM without spawning or taking a slot | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › keeps only the last tailBytes of combined output | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › defaults the tail to OUTPUT_TAIL_BYTES | todo |
| commands/process-runner.test.ts › ProcessCommandRunner › rejects when the process cannot be spawned, and frees the slot | todo |
| commands/process-runner.test.ts › Semaphore › is FIFO and hands a released slot to the oldest waiter | todo |
| commands/process-runner.test.ts › Semaphore › rejects a non-positive size | todo |
| commands/process-runner.test.ts › TailBuffer › drops a multi-byte character cut at the front | todo |
| commands/process-runner.test.ts › TailBuffer › keeps everything under the limit across chunks | todo |

### credential.test.ts

| TS case | Rust |
|---|---|
| credential.test.ts › loadCredential › is null (local mode) without a root or a file | todo |
| credential.test.ts › loadCredential › round-trips what writeCredential wrote | todo |
| credential.test.ts › loadCredential › refuses a group/other-readable file and says how to fix it | todo |
| credential.test.ts › loadCredential › refuses a root other users can read (win32: any non-owner-only DACL) | todo |
| credential.test.ts › loadCredential › refuses a symlinked file and a symlinked root | todo |
| credential.test.ts › loadCredential › refuses invalid content without echoing it | todo |
| credential.test.ts › machine.json url › rejects plain http to a non-loopback host, on load and on write | todo |
| credential.test.ts › daemonWsUrl › maps https → wss and http → ws on the daemon WS path | todo |
| credential.test.ts › loadConfig with machine.json › uses the enrolled machine id, the stored url and the credential | todo |
| credential.test.ts › loadConfig with machine.json › refuses a cleartext URL to a non-loopback host when enrolled | todo |
| credential.test.ts › loadConfig with machine.json › CONDUCTOR_ORCHESTRATOR_URL still wins | todo |
| credential.test.ts › loadConfig with machine.json › local mode is unchanged | todo |
| credential.test.ts › loadConfig with machine.json › daemonVersion appends CONDUCTOR_BUILD_SHA | todo |

### daemon.kill.test.ts

| TS case | Rust |
|---|---|
| daemon.kill.test.ts › BUG-1 FR-2: kill of a parked process (real process group) › a kill %s ends it within 5 s and is acked | todo |
| daemon.kill.test.ts › BUG-1b: the startup sweep against a real (fake-claude) process group › FR-1: the start time is persisted at spawn; a restarted daemon kills its orphan | todo |
| daemon.kill.test.ts › BUG-1b: the startup sweep against a real (fake-claude) process group › FR-2 (b): a recorded pid whose start time differs (reused) is left alone | todo |

### daemon.test.ts

| TS case | Rust |
|---|---|
| daemon.test.ts › daemon core: link › registers, then sends heartbeat, inventory, repo_inventory and request_work | todo |
| daemon.test.ts › daemon core: link › register.daemon_version carries CONDUCTOR_BUILD_SHA | todo |
| daemon.test.ts › daemon core: link › enrolled: the enrolled machine id, the bearer header, no enrollment_token | todo |
| daemon.test.ts › daemon core: link › close 4001 (revoked) stops the link and calls onFatal; no re-register | todo |
| daemon.test.ts › daemon core: link › reconnects with backoff after the socket drops and registers again | todo |
| daemon.test.ts › daemon core: link › asks for work again after retry_after | todo |
| daemon.test.ts › daemon core: start_session › creates the worktree on the session branch, spawns the driver, and forwards events | todo |
| daemon.test.ts › daemon core: start_session › persists the pre-assigned Claude session id before spawning | todo |
| daemon.test.ts › daemon core: start_session › ADR-0009: a reviewer start is fresh, read-only, and never replaces the worker's stored id | todo |
| daemon.test.ts › daemon core: start_session › resumes with --resume semantics when resume_claude_session_id is set | todo |
| daemon.test.ts › daemon core: start_session › refuses no_conversation (never spawns) when the resumed conversation is not on this machine | todo |
| daemon.test.ts › daemon core: start_session › the hasConversation seam decides the resume check | todo |
| daemon.test.ts › daemon core: start_session › sends the last stderr lines on exit (stderr_tail) | todo |
| daemon.test.ts › daemon core: start_session › parks after ask_user (process alive) and feeds send_input into the live process | todo |
| daemon.test.ts › daemon core: start_session › U-028: an outcome-less turn gets ONE nudge; the agent then completes | todo |
| daemon.test.ts › daemon core: start_session › U-028: a second outcome-less turn emits no_outcome (parked); an answer re-arms the nudge | todo |
| daemon.test.ts › daemon core: start_session › U-028: no_outcome carries only the tail of the assistant output | todo |
| daemon.test.ts › daemon core: start_session › refuses send_input with no_live_process when the process is gone | todo |
| daemon.test.ts › daemon core: start_session › refuses start_session with max_sessions and memory_pressure | todo |
| daemon.test.ts › daemon core: start_session › re-arms request_work after a memory_pressure refusal of an assigned session (max_sessions=1) | todo |
| daemon.test.ts › daemon core: start_session › re-arms request_work right after a max_sessions refusal and when a hold expires | todo |
| daemon.test.ts › daemon core: start_session › reports start_failed when the repo cannot be cloned | todo |
| daemon.test.ts › daemon core: send_message (ADR-0007) › writes into the working process (not as an answer) and leaves the U-028 nudge state alone | todo |
| daemon.test.ts › daemon core: send_message (ADR-0007) › refuses: parked (agent_parked), another process, a newer process token, or none (no_live_process) | todo |
| daemon.test.ts › daemon core: send_message (ADR-0007) › refuses with no_live_process once the process completed | todo |
| daemon.test.ts › daemon core: command_id dedupe and seq › re-acks a re-sent command without re-running it, also after a daemon restart | todo |
| daemon.test.ts › daemon core: command_id dedupe and seq › next seq = max(local + 1, registered.last_seq + 1) | todo |
| daemon.test.ts › daemon core: command_id dedupe and seq › buffers session_events while disconnected and replays those after registered.last_seq | todo |
| daemon.test.ts › daemon core: run_cmd and kill › runs a command through the injected CommandRunner and reports build_slot + cmd_exit | todo |
| daemon.test.ts › daemon core: run_cmd and kill › ADR-0010 (Ben 2026-10-26): entry checks run in a fresh checkout of the commit, setup once, then it is removed | todo |
| daemon.test.ts › daemon core: run_cmd and kill › ADR-0010: a session kill between checks removes the kept checkout | todo |
| daemon.test.ts › daemon core: run_cmd and kill › ADR-0010: an older run cleanup never removes a newer checkout of the same session | todo |
| daemon.test.ts › daemon core: run_cmd and kill › ADR-0010: a failed setup is reported (setup_failed), the check does not run, the checkout goes | todo |
| daemon.test.ts › daemon core: run_cmd and kill › ADR-0010: a require_clean check on a dirty worktree is not run; cmd_exit reports dirty | todo |
| daemon.test.ts › daemon core: run_cmd and kill › refuses run_cmd for an unknown session and a cwd outside the worktree | todo |
| daemon.test.ts › daemon core: run_cmd and kill › kill rule: target_command_id kills only that process; null kills at or below the envelope token | todo |
| daemon.test.ts › daemon core: run_cmd and kill › kill with target_command_id kills the process that start spawned | todo |
| daemon.test.ts › daemon core: BUG-1 no process outlives its session › FR-3: a start superseding a parked process kills it before the new one runs | todo |
| daemon.test.ts › daemon core: BUG-1 no process outlives its session › FR-3: two starts racing through worktree preparation leave exactly one process | todo |
| daemon.test.ts › daemon core: BUG-1 no process outlives its session › FR-4: repeated heartbeat-backstop kills stop a parked process once, logged once | todo |
| daemon.test.ts › daemon core: BUG-1 no process outlives its session › FR-4: the pid and start time of a started process are persisted for the startup sweep | todo |
| daemon.test.ts › daemon core: BUG-1 no process outlives its session › BUG-1b FR-1: a process whose start time cannot be read is not tracked for the sweep | todo |
| daemon.test.ts › daemon core: BUG-1b orphan sweep only kills provably-ours processes › FR-2 (c): our argv, start time and UUID: killed with its whole group | todo |
| daemon.test.ts › daemon core: BUG-1b orphan sweep only kills provably-ours processes › FR-2 (a)(b)(d)(e): anything not provably ours is untouched and logged | todo |
| daemon.test.ts › daemon core: BUG-1b orphan sweep only kills provably-ours processes › FR-4: an old entry without startedAt is untouched, logged and cleared | todo |
| daemon.test.ts › daemon core: BUG-1b orphan sweep only kills provably-ours processes › FR-3: a process replaced between SIGTERM and SIGKILL gets no SIGKILL | todo |
| daemon.test.ts › daemon core: BUG-1b orphan sweep only kills provably-ours processes › FR-3 control: a process still ours after the grace period is SIGKILLed | todo |
| daemon.test.ts › daemon core: misc › reports exit (daemon_restart) for a process that died with the previous daemon | todo |
| daemon.test.ts › daemon core: misc › omits the CLAUDE.md section when the worktree has none | todo |
| daemon.test.ts › daemon core: run_action (ADR-0010 open_pr) › acks, pushes the session branch to origin, opens the PR with gh, reports action_result | todo |
| daemon.test.ts › daemon core: run_action (ADR-0010 open_pr) › refuses run_action for an unknown session | todo |
| daemon.test.ts › daemon core: ADR-0011 transitions › passes start_session.transitions to the driver and forwards transition + reason | todo |
| daemon.test.ts › daemon core: ADR-0011 transitions › an old start_session (no transitions) forwards complete_state without the fields | todo |
| daemon.test.ts › daemon core: run_action evaluate_conditions (ADR-0011) › acks accepted and reports one action_result with a result per condition | todo |
| daemon.test.ts › daemon core: run_action evaluate_conditions (ADR-0011) › invalid args → accepted, then an action_result error | todo |
| daemon.test.ts › appendTail (exit stderr_tail) › keeps the last STDERR_TAIL_LINES lines across chunk boundaries | todo |
| daemon.test.ts › appendTail (exit stderr_tail) › caps the characters | todo |
| daemon.test.ts › daemon core: ADR-0023 permission prompts › sends a durable permission_request on the session envelope | todo |
| daemon.test.ts › daemon core: ADR-0023 permission prompts › a decision resolves the held call once; a second decision is accepted and ignored; unknown is refused | todo |
| daemon.test.ts › daemon core: ADR-0023 permission prompts › a deny carries the human note to Claude | todo |
| daemon.test.ts › daemon core: ADR-0023 permission prompts › an old server's protocol_error naming the request denies the held call at once | todo |
| daemon.test.ts › daemon core: ADR-0023 permission prompts › the request is replayed after a socket drop (durable seq), same msg_id | todo |
| daemon.test.ts › daemon core: ADR-0023 permission prompts › daemon shutdown denies every held call | todo |

### index.test.ts

| TS case | Rust |
|---|---|
| index.test.ts › @conductor/daemon scaffold › resolves @conductor/shared across the workspace | todo |

### inventory/capabilities.test.ts

| TS case | Rust |
|---|---|
| inventory/capabilities.test.ts › inventory capabilities: cli probes (M2-T10) › gh / az authed → {authed: true}, and no account name anywhere in the output | todo |
| inventory/capabilities.test.ts › inventory capabilities: cli probes (M2-T10) › a failed auth probe → authed false; a missing CLI is omitted | todo |
| inventory/capabilities.test.ts › inventory capabilities: cli probes (M2-T10) › jira and git report their versions, never authed | todo |
| inventory/capabilities.test.ts › inventory capabilities: cli probes (M2-T10) › a hanging probe is killed at 5 s | todo |
| inventory/capabilities.test.ts › inventory capabilities: names from Claude Code config (M2-T10) › MCP names from user scope and enabled plugins; no command, args, env or URL | todo |
| inventory/capabilities.test.ts › inventory capabilities: names from Claude Code config (M2-T10) › malformed config files contribute nothing (never throw) | todo |
| inventory/capabilities.test.ts › inventory capabilities: names from Claude Code config (M2-T10) › skills and agents: user scope, and repo scope only for repos with a remote | todo |
| inventory/capabilities.test.ts › inventory capabilities: names from Claude Code config (M2-T10) › normalizeMcpName: plugin:<plugin>:<server> → <server> (M2-T10b) | todo |
| inventory/capabilities.test.ts › inventory capabilities: names from Claude Code config (M2-T10) › a plugin MCP name is reported as mcp:<server> (M2-T10b) | todo |
| inventory/capabilities.test.ts › inventory capabilities: names from Claude Code config (M2-T10) › an invalid name is logged once per scan and not reported; the rest is (M2-T10b) | todo |

### inventory/report.test.ts

| TS case | Rust |
|---|---|
| inventory/report.test.ts › inventoryHash › is stable under reordering and changes with a version or a repo | todo |
| inventory/report.test.ts › InventoryReporter › sends on registered; the 10-minute rescan sends only when the hash changed | todo |
| inventory/report.test.ts › InventoryReporter › a failed scan keeps the previous inventory | todo |
| inventory/report.test.ts › daemon inventory over the link (M2-T10) › sent after registered (before request_work), with the legacy repo_inventory too | todo |
| inventory/report.test.ts › daemon inventory over the link (M2-T10) › not re-sent when unchanged; re-sent on SIGHUP after a change | todo |

### inventory/repos.test.ts

| TS case | Rust |
|---|---|
| inventory/repos.test.ts › inventory repos (M2-T10) › finds repos at depth 1–4, not 5 | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › skips node_modules, dot-directories and symlinks | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › canonicalises origin to host/org/repo; no origin → remote null | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › a remote that is not canonical is null for that repo only | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › allowedRepoHosts: another host is reported with remote null | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › a repo without commits is not reported | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › default_branch from origin/HEAD, else main / master; head_commit; mode from config | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › a planted hook / hooksPath / fsmonitor in a scanned repo never runs | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › test remote aliases give a local repo a canonical remote | todo |
| inventory/repos.test.ts › inventory repos (M2-T10) › a missing root is skipped, the others still scanned | todo |

### inventory/version.test.ts

| TS case | Rust |
|---|---|
| inventory/version.test.ts › cliVersionFrom › %j → %s | todo |
| inventory/version.test.ts › cliVersionFrom › garbage → null | todo |

### orphan.test.ts

| TS case | Rust |
|---|---|
| orphan.test.ts › parseLstart › parses ps lstart (UTC) to ms epoch | todo |
| orphan.test.ts › parseLstart › returns null for anything else | todo |
| orphan.test.ts › parseLstart › readProcInfo reads this process (read-only) and null for no such pid | todo |
| orphan.test.ts › checkOurs › %s | todo |
| orphan.test.ts › checkOurs › matches the configured binary by exact path, even with spaces | todo |
| orphan.test.ts › checkOurs › (d) an empty or non-UUID stored id is never ours | todo |
| orphan.test.ts › checkOurs › FR-4: no recorded start time is never ours | todo |

### platform/acl.test.ts

| TS case | Rust |
|---|---|
| platform/acl.test.ts › parseWhoamiCsv › reads the SID with and without the header row, CRLF and a BOM | todo |
| platform/acl.test.ts › parseWhoamiCsv › refuses %s | todo |
| platform/acl.test.ts › parseGetAclJson › reads owner, protection, rules, SDDL and ACE count | todo |
| platform/acl.test.ts › parseGetAclJson › accepts ConvertTo-Json flattening a single rule to an object, and null for none | todo |
| platform/acl.test.ts › parseGetAclJson › throws on %s (callers fail closed) | todo |
| platform/acl.test.ts › parseSddl / resolveSddlSid › reads owner, DACL flags and ACEs, skipping over conditional expressions | todo |
| platform/acl.test.ts › parseSddl / resolveSddlSid › finds the DACL after alias owners and groups that contain a D | todo |
| platform/acl.test.ts › parseSddl / resolveSddlSid › throws on %s | todo |
| platform/acl.test.ts › parseSddl / resolveSddlSid › resolves SIDs, fixed aliases and domain-relative aliases; refuses unknown aliases | todo |
| platform/acl.test.ts › evaluateWinAcl › passes an owner-only ACL (SIDs compared case-insensitively, aliases resolved) | todo |
| platform/acl.test.ts › evaluateWinAcl › refuses a file owned by another SID, naming it | todo |
| platform/acl.test.ts › evaluateWinAcl › refuses an allow-ACE for any other SID, and says how to fix it | todo |
| platform/acl.test.ts › evaluateWinAcl › ignores deny-ACEs for other SIDs | todo |
| platform/acl.test.ts › evaluateWinAcl › refuses inheritance, whether flagged on the ACL, on a rule or on an SDDL ACE | todo |
| platform/acl.test.ts › evaluateWinAcl › checkAccess: false checks only the owner | todo |
| platform/acl.test.ts › evaluateWinAcl › refuses a %s ACE the rules do not show | todo |
| platform/acl.test.ts › evaluateWinAcl › refuses a NULL DACL, from the SDDL or the raw count | todo |
| platform/acl.test.ts › evaluateWinAcl › treats SDDL / raw count / rules disagreement as unreadable | todo |
| platform/acl.test.ts › icaclsRestrictArgs / GET_ACL_SCRIPT › grants only user, SYSTEM and Administrators, removing inheritance; dirs propagate | todo |
| platform/acl.test.ts › icaclsRestrictArgs / GET_ACL_SCRIPT › reads the path from the environment, never from the script text | todo |
| platform/acl.test.ts › POSIX › writePrivateFile writes 0600 atomically, leaving no temp file | todo |
| platform/acl.test.ts › POSIX › writePrivateFile leaves no temp file when the rename fails | todo |
| platform/acl.test.ts › POSIX › mkdirPrivate creates parents and chmods 0700, also an existing 0755 dir | todo |
| platform/acl.test.ts › POSIX › mkdirPrivate refuses a symlink without chmodding its target | todo |
| platform/acl.test.ts › POSIX › refuses a group/other-readable file with the chmod hint | todo |
| platform/acl.test.ts › POSIX › never mode-checks a dir (ADR-0010 checks only its owner) | todo |
| platform/acl.test.ts › POSIX › refuses symlinks and the wrong kind with the credential.ts messages | todo |
| platform/acl.test.ts › POSIX › refuses a path owned by another uid | todo |
| platform/acl.test.ts › POSIX › throws ENOENT for a missing path, as checkPrivateDir does | todo |
| platform/acl.test.ts › POSIX › currentUserSid is win32-only | todo |
| platform/acl.test.ts › win32 › currentUserSid is a user SID | todo |
| platform/acl.test.ts › win32 › a file written by writePrivateFile passes and holds the data | todo |
| platform/acl.test.ts › win32 › refuses a plain (inheriting) file | todo |
| platform/acl.test.ts › win32 › refuses after Everyone is granted read, with a clear message | todo |
| platform/acl.test.ts › win32 › refuses after inheritance is re-enabled | todo |
| platform/acl.test.ts › win32 › refuses a file owned by another SID (when the runner may set one) | todo |
| platform/acl.test.ts › win32 › mkdirPrivate refuses an existing dir owned by another SID (when the runner may set one) | todo |
| platform/acl.test.ts › win32 › mkdirPrivate makes an owner-only dir whose new children inherit only those grants | todo |
| platform/acl.test.ts › win32 › refuses a junction and a missing path fails closed | todo |
| platform/acl.test.ts › win32 › handles paths with spaces, quotes-free metacharacters and brackets | todo |
| platform/acl.test.ts › win32 › no inherited-permission window › writePrivateFile refuses a folder that is not private, creating nothing | todo |
| platform/acl.test.ts › win32 › no inherited-permission window › mkdirPrivate refuses to create under a non-private ancestor, creating nothing | todo |
| platform/acl.test.ts › win32 › no inherited-permission window › mkdirPrivate creates directly under %LOCALAPPDATA%, every new level owner-only | todo |
| platform/acl.test.ts › win32 › no inherited-permission window › mkdirPrivate creates directly under the profile dir | todo |
| platform/acl.test.ts › win32 › no inherited-permission window › a real owner-only ACL has matching SDDL, raw ACE count and rules | todo |

### platform/index.test.ts

| TS case | Rust |
|---|---|
| platform/index.test.ts › platform seam › exports the MW-T03 modules | todo |
| platform/index.test.ts › platform seam › U-107: lstat on a junction | todo |

### platform/kill-tree.test.ts

| TS case | Rust |
|---|---|
| platform/kill-tree.test.ts › killTree › taskkillArgs: tree, force, by pid | todo |
| platform/kill-tree.test.ts › killTree › rejects a bad pid and ignores a never-spawned child | todo |
| platform/kill-tree.test.ts › killTree › kills a node child and its grandchild (both pids gone) | todo |
| platform/kill-tree.test.ts › killTree › accepts a bare pid as well | todo |
| platform/kill-tree.test.ts › killTree › POSIX: escalates to SIGKILL after the grace period | todo |
| platform/kill-tree.test.ts › killTree › POSIX: cancel() stops the escalation | todo |
| platform/kill-tree.test.ts › killTree › win32: an exited child is skipped (its pid may be reused) | todo |

### platform/procinfo.test.ts

| TS case | Rust |
|---|---|
| platform/procinfo.test.ts › parsePsLine (POSIX, as orphan.ts) › parses lstart (UTC) and the command | todo |
| platform/procinfo.test.ts › parsePsLine (POSIX, as orphan.ts) › returns null for anything else | todo |
| platform/procinfo.test.ts › parseWindowsCommandLine (CommandLineToArgvW) › %j | todo |
| platform/procinfo.test.ts › parseCimDate › accepts every shape PowerShell may print | todo |
| platform/procinfo.test.ts › parseCimDate › null for zone-less or garbage values | todo |
| platform/procinfo.test.ts › parseCimProcessJson › reads start time, command, argv and image path | todo |
| platform/procinfo.test.ts › parseCimProcessJson › null when gone, unreadable (CommandLine null) or malformed | todo |
| platform/procinfo.test.ts › parseCimProcessJson › cimScript embeds an integer pid only | todo |
| platform/procinfo.test.ts › readProcInfo (real processes) › returns the start time and argv of a spawned child, then null once it is dead | todo |
| platform/procinfo.test.ts › readProcInfo (real processes) › null for a pid that does not exist or is invalid | todo |

### platform/seam.test.ts

| TS case | Rust |
|---|---|
| platform/seam.test.ts › platform seam (ADR-0024 §1) › no daemon source outside platform/ branches on process.platform | crates/conductor-daemon/tests/seam.rs::no_os_cfg_outside_platform |

### platform/shell.test.ts

| TS case | Rust |
|---|---|
| platform/shell.test.ts › workflowShell › POSIX: /bin/sh -c | todo |
| platform/shell.test.ts › workflowShell › runs a POSIX command line with quotes, $ and && on this OS | todo |
| platform/shell.test.ts › workflowShell › win32: finds Git Bash on the runner (not WSL bash) | todo |
| platform/shell.test.ts › findGitBash › CONDUCTOR_SHELL wins, and must exist | todo |
| platform/shell.test.ts › findGitBash › then CLAUDE_CODE_GIT_BASH_PATH | todo |
| platform/shell.test.ts › findGitBash › then relative to git --exec-path (forward slashes, any MSYS prefix) | todo |
| platform/shell.test.ts › findGitBash › then the default install dirs, in order | todo |
| platform/shell.test.ts › findGitBash › throws with the places it looked when there is no Git Bash | todo |

### platform/spawn.test.ts

| TS case | Rust |
|---|---|
| platform/spawn.test.ts › resolveWindowsBin › searches absolute PATH entries in order with PATHEXT order | todo |
| platform/spawn.test.ts › resolveWindowsBin › honours PATHEXT order and an explicit extension | todo |
| platform/spawn.test.ts › resolveWindowsBin › never looks in the cwd for a bare name, and skips relative PATH entries | todo |
| platform/spawn.test.ts › resolveWindowsBin › resolves a name with a directory part against cwd only | todo |
| platform/spawn.test.ts › resolveWindowsBin › returns null when nothing matches | todo |
| platform/spawn.test.ts › escapeCmdArg › quotes for MSVCRT and caret-escapes metacharacters twice | todo |
| platform/spawn.test.ts › escapeCmdArg › refuses CR, LF and NUL (cmd.exe ends the command at a newline) | todo |
| platform/spawn.test.ts › buildCmdLine length guard (TD-192) › refuses a cmd.exe line over 8191 characters with ERR_CMD_UNSAFE_ARG | todo |
| platform/spawn.test.ts › buildCmdLine round trip (cmd model + CommandLineToArgvW) › delivers every nasty arg intact through cmd /c and a %* batch shim | todo |
| platform/spawn.test.ts › buildCmdLine round trip (cmd model + CommandLineToArgvW) › caret-escapes spaces, parens and the colon in the program path | todo |
| platform/spawn.test.ts › buildCmdLine round trip (cmd model + CommandLineToArgvW) › leaves no %NAME% / %NAME:…% span whose name is a real variable | todo |
| platform/spawn.test.ts › prepareCli › POSIX: spawn as given, keeps detached, drops shell | todo |
| platform/spawn.test.ts › prepareCli › win32: an .exe is spawned directly by absolute path, hidden, never detached | todo |
| platform/spawn.test.ts › prepareCli › win32: a .cmd/.bat runs via System32 cmd.exe /d /s /c with verbatim arguments | todo |
| platform/spawn.test.ts › prepareCli › win32: an unresolvable bin is null (the caller reports ENOENT) | todo |
| platform/spawn.test.ts › prepareCli › win32: a multi-line argument for a .cmd throws instead of being truncated | todo |
| platform/spawn.test.ts › spawnCli (real processes) › a bare name resolves through PATH (PATHEXT on win32) and gets metachar args intact | todo |
| platform/spawn.test.ts › spawnCli (real processes) › execFileCliSync does the same synchronously | todo |
| platform/spawn.test.ts › spawnCli (real processes) › runs an absolute .exe/binary directly | todo |
| platform/spawn.test.ts › spawnCli (real processes) › a missing bin fails with an ENOENT error event and no pid | todo |
| platform/spawn.test.ts › spawnCli (real processes) › win32: a node.cmd/node.bat planted in the cwd is not run by the shim | todo |
| platform/spawn.test.ts › spawnCli (real processes) › win32: a program planted in the cwd is not run for a bare name | todo |

### platform/sysres.test.ts

| TS case | Rust |
|---|---|
| platform/sysres.test.ts › busyCoresBetween (win32 CPU, ADR-0024 §8) › is the busy share of the elapsed time times the cores | todo |
| platform/sysres.test.ts › busyCoresBetween (win32 CPU, ADR-0024 §8) › busyCores is a number between 0 and the core count on every OS | todo |

### reopen-transcript.test.ts

| TS case | Rust |
|---|---|
| reopen-transcript.test.ts › fetch_transcript (ADR-0008) › answers with the session transcript located from the store | todo |
| reopen-transcript.test.ts › fetch_transcript (ADR-0008) › unknown_session for a session this daemon never ran | todo |
| reopen-transcript.test.ts › reopen: a new session on the earlier session’s branch (ADR-0008) › reuses the old worktree, resumes the Claude session, and both transcripts resolve | todo |
| reopen-transcript.test.ts › reopen: a new session on the earlier session’s branch (ADR-0008) › refuses the start while the earlier session still has a live process in that worktree | todo |

### sysinfo.test.ts

| TS case | Rust |
|---|---|
| sysinfo.test.ts › parseVmStatAvailableBytes › counts free + inactive + speculative + purgeable pages | todo |
| sysinfo.test.ts › parseVmStatAvailableBytes › returns null on unparseable output | todo |
| sysinfo.test.ts › liveResources › reports more than the raw free pages on macOS | todo |

### test-support/fake-bin.test.ts

| TS case | Rust |
|---|---|
| test-support/fake-bin.test.ts › writeFakeBin › echoes args with spaces and cmd metacharacters back exactly | todo |
| test-support/fake-bin.test.ts › writeFakeBin › writes a #!/usr/bin/env node script, mode 755, on POSIX | todo |
| test-support/fake-bin.test.ts › writeFakeBin › writes name.mjs plus a name.cmd shim on win32 | todo |
| test-support/fake-bin.test.ts › pathWith › joins dirs with the platform delimiter, dropping empties | todo |

### units.test.ts

| TS case | Rust |
|---|---|
| units.test.ts › loadConfig › defaults: localhost orchestrator on CONDUCTOR_PORT, 25 % owner reserve, port pool | todo |
| units.test.ts › loadConfig › reads env overrides and rejects bad values | todo |
| units.test.ts › loadConfig › M1-T14: local repos are off by default; repo hosts are unrestricted unless listed | todo |
| units.test.ts › PortPool › allocates aligned ranges, reuses a session’s range, and reports exhaustion | todo |
| units.test.ts › DaemonStore › persists seq, buffered events, acks and sessions across instances | todo |
| units.test.ts › DaemonStore › onRegistered: drops confirmed events, sequences the rest from max(local+1, last_seq+1) | todo |
| units.test.ts › helpers › cloneSource / repoSlug | todo |
| units.test.ts › helpers › backoff grows exponentially with jitter and is capped | todo |
| units.test.ts › helpers › appendSystemPrompt carries CLAUDE.md after the conductor instructions | todo |
| units.test.ts › helpers › tells the agent to attempt commands and ask on a denial, not refuse (ADR-0023) | todo |

### workspace.fresh-base.test.ts

| TS case | Rust |
|---|---|
| workspace.fresh-base.test.ts › Workspace fresh base (M2-T13a) › bases each new session on the fetched default branch; a resume is not rebased | todo |
| workspace.fresh-base.test.ts › Workspace fresh base (M2-T13a) › uses an explicit default branch when one is given | todo |
| workspace.fresh-base.test.ts › Workspace fresh base (M2-T13a) › isSafeBranchName accepts usual names and refuses refspec tricks | todo |
| workspace.fresh-base.test.ts › Workspace fresh base (M2-T13a) › sets origin/HEAD once when the clone lacks it | todo |
| workspace.fresh-base.test.ts › Workspace fresh base (M2-T13a) › fails the start with an error naming the repo when origin is unreachable | todo |
| workspace.fresh-base.test.ts › Workspace fresh base (M2-T13a) › concurrent starts › runs one fetch at a time per repo and both sessions get the fresh base | todo |

### workspace.test.ts

| TS case | Rust |
|---|---|
| workspace.test.ts › cloneSource policy › accepts canonical host/org/repo, https URLs and scp-style ssh | todo |
| workspace.test.ts › cloneSource policy › rejects absolute paths and file:// unless allowLocalRepos | todo |
| workspace.test.ts › cloneSource policy › rejects other schemes, transports, relative paths and traversal | todo |
| workspace.test.ts › cloneSource policy › checks the host against allowedRepoHosts when it is set | todo |
| workspace.test.ts › Workspace › ensureWorktree refuses a local repo before cloning when allowLocalRepos is off | todo |
| workspace.test.ts › Workspace › reads a regular CLAUDE.md inside the worktree | todo |
| workspace.test.ts › Workspace › returns null without a log line when CLAUDE.md is absent | todo |
| workspace.test.ts › Workspace › skips a CLAUDE.md symlink (outside or inside the worktree) and logs it | todo |
| workspace.test.ts › Workspace › resolves the worktree path itself through symlinks (macOS /var → /private/var) | todo |
| workspace.test.ts › Workspace › skips a directory named CLAUDE.md and a file over 64 KB | todo |

### ws-client.test.ts

| TS case | Rust |
|---|---|
| ws-client.test.ts › ReconnectingWs (M2-T04) › sends the bearer header when enrolled and none in local mode | todo |
| ws-client.test.ts › ReconnectingWs (M2-T04) › close 4001 stops reconnecting and reports it once | todo |
| ws-client.test.ts › ReconnectingWs (M2-T04) › close 4003 is fatal too; 4005 says to re-run the install command | todo |
| ws-client.test.ts › ReconnectingWs (M2-T04) › HTTP 401 at the upgrade is treated as unauthorized: no retries | todo |
| ws-client.test.ts › ReconnectingWs (M2-T04) › another refused upgrade, and an ordinary close, still reconnect | todo |
