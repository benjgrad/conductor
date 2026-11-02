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

- [x] `claude/cli-driver.real.test.ts`

- [x] `claude/cli-driver.test.ts`

- [x] `claude/edit-guard.test.ts`

- [x] `claude/fake-driver.test.ts`

- [x] `claude/outcome-server.test.ts`

- [x] `claude/stream-parser.test.ts`

- [x] `claude/transcript.test.ts`

- [ ] `commands/config.test.ts`

- [ ] `commands/enroll.test.ts`

- [x] `commands/fake-runner.test.ts`

- [x] `commands/process-runner.test.ts`

- [ ] `commands/service.test.ts`

- [x] `credential.test.ts`

- [ ] `daemon.kill.test.ts`

- [ ] `daemon.test.ts`

- [x] `index.test.ts`

- [ ] `inventory/capabilities.test.ts`

- [ ] `inventory/report.test.ts`

- [ ] `inventory/repos.test.ts`

- [x] `inventory/version.test.ts`

- [x] `orphan.test.ts`

- [x] `platform/acl.test.ts`

- [x] `platform/index.test.ts`

- [x] `platform/kill-tree.test.ts`

- [x] `platform/procinfo.test.ts`

- [x] `platform/seam.test.ts`

- [x] `platform/shell.test.ts`

- [x] `platform/spawn.test.ts`

- [x] `platform/sysres.test.ts`

- [ ] `reopen-transcript.test.ts`

- [x] `rust-compat.test.ts`

- [x] `sysinfo.test.ts`

- [x] `test-support/fake-bin.test.ts`

- [ ] `units.test.ts`

- [ ] `workspace.fresh-base.test.ts`

- [ ] `workspace.test.ts`

- [x] `ws-client.test.ts`
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
| claude/cli-driver.real.test.ts › real claude CLI: flags › accepts the exact ADR-0005 argv and exits 0 on stdin EOF | crates/conductor-daemon/src/claude/cli_driver/tests.rs::real_claude_accepts_the_exact_adr_0005_argv_and_exits_0_on_stdin_eof |
| claude/cli-driver.real.test.ts › real claude CLI: ask_user round trip (spends money) › asks, takes the live answer, completes | crates/conductor-daemon/src/claude/cli_driver/tests.rs::real_claude_asks_takes_the_live_answer_completes |
| claude/cli-driver.real.test.ts › real claude CLI: permission prompt round trip (spends money) › git push never reaches the prompt tool; touch does, is allowed, and runs | crates/conductor-daemon/src/claude/cli_driver/tests.rs::real_claude_git_push_never_reaches_the_prompt_tool_touch_does_and_runs |

### claude/cli-driver.test.ts

| TS case | Rust |
|---|---|
| claude/cli-driver.test.ts › buildClaudeArgs › emits exactly the ADR-0005/ADR-0006 flags for a new session | crates/conductor-daemon/src/claude/cli_driver/tests.rs::emits_exactly_the_adr_0005_0006_flags_for_a_new_session, crates/conductor-daemon/src/claude/cli_driver/tests.rs::argv_and_user_lines_match_the_recorded_ts_output |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0009: a reviewer always runs in dontAsk and never prompts; ADR-0023: a worker runs in auto | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_reviewer_runs_in_dont_ask_and_never_prompts_a_worker_runs_in_auto |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0029: inherit drops --strict-mcp-config and denies the listed servers; none, absent and reviewers stay strict | crates/conductor-daemon/src/claude/cli_driver/tests.rs::inherit_drops_strict_mcp_config_and_denies_the_listed_servers |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0029: agentMcp, and agentEnv leaves the claude.ai connectors on only when not strict | crates/conductor-daemon/src/claude/cli_driver/tests.rs::agent_mcp_and_agent_env_leave_connectors_on_only_when_not_strict, crates/conductor-daemon/src/claude/cli_driver/tests.rs::mcp_server_rule_gives_claude_code_tool_prefixes |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0023 fallback (old CLI): the pre-ADR-0023 flags, the user mode or the bypass cap, prompts denied | crates/conductor-daemon/src/claude/cli_driver/tests.rs::old_cli_fallback_uses_the_pre_adr_0023_flags |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0023 §4: git push stays a deny rule beside the prompt tool, so it never reaches a human | crates/conductor-daemon/src/claude/cli_driver/tests.rs::git_push_stays_a_deny_rule_beside_the_prompt_tool |
| claude/cli-driver.test.ts › buildClaudeArgs › ADR-0023: detects auto mode and --permission-prompts in claude --help | crates/conductor-daemon/src/claude/cli_driver/tests.rs::detects_auto_mode_and_permission_prompts_in_claude_help |
| claude/cli-driver.test.ts › buildClaudeArgs › uses --resume for resume, omits unset optionals and an empty deny list | crates/conductor-daemon/src/claude/cli_driver/tests.rs::uses_resume_for_resume_and_omits_unset_optionals_and_an_empty_deny_list, crates/conductor-daemon/src/claude/cli_driver/tests.rs::js_number_prints_as_js_string |
| claude/cli-driver.test.ts › buildClaudeArgs › writes stream-json user messages | crates/conductor-daemon/src/claude/cli_driver/tests.rs::writes_stream_json_user_messages, crates/conductor-daemon/src/claude/cli_driver/tests.rs::argv_and_user_lines_match_the_recorded_ts_output |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0011: an unknown transition is nudged once, then the named one is forwarded with its reason | crates/conductor-daemon/src/claude/cli_driver/tests.rs::an_unknown_transition_is_nudged_once_then_the_named_one_is_forwarded |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ask_user → park → sendInput → complete_state → end() → exit 0 | crates/conductor-daemon/src/claude/cli_driver/tests.rs::ask_user_park_send_input_complete_state_end_exit_0 |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0007: sendMessage is folded into the running turn (a slash command passes through) | crates/conductor-daemon/src/claude/cli_driver/tests.rs::send_message_is_folded_into_the_running_turn |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0007: sendMessage is not an answer: a pending ask_user question stays pending | crates/conductor-daemon/src/claude/cli_driver/tests.rs::send_message_is_not_an_answer_a_pending_question_stays_pending |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: --settings is the edit-guard hook for the worktree, beside mcp.json, removed on exit | crates/conductor-daemon/src/claude/cli_driver/tests.rs::settings_is_the_edit_guard_hook_beside_mcp_json_removed_on_exit |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: agentEnv passes only allowlisted state keys and pins connectors and safe mode off | crates/conductor-daemon/src/claude/cli_driver/tests.rs::agent_env_passes_only_allowlisted_state_keys_and_pins_connectors_and_safe_mode_off, crates/conductor-daemon/src/claude/cli_driver/tests.rs::state_env_allowed_matches_the_ts_regex |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: logs the state env keys it dropped | crates/conductor-daemon/src/claude/cli_driver/tests.rs::logs_the_state_env_keys_it_dropped, crates/conductor-daemon/src/claude/cli_driver/tests.rs::start_notes_say_the_mode_the_mcp_policy_and_dropped_keys |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0006: caps the user defaultMode bypassPermissions to auto; leaves others alone | crates/conductor-daemon/src/claude/cli_driver/tests.rs::caps_the_user_default_mode_bypass_permissions_to_auto |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › M1-T14: the MCP URL token never appears in argv; it is in a 0600 file, removed on exit | crates/conductor-daemon/src/claude/cli_driver/tests.rs::the_mcp_url_token_never_appears_in_argv_it_is_in_a_private_file_removed_on_exit |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › resume continues the script and the cumulative spend (TD-001) | crates/conductor-daemon/src/claude/cli_driver/tests.rs::resume_continues_the_script_and_the_cumulative_spend |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › resume of an unknown session exits non-zero, like the real CLI | crates/conductor-daemon/src/claude/cli_driver/tests.rs::resume_of_an_unknown_session_exits_non_zero_like_the_real_cli |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › kill(): SIGTERM first; SIGKILL after the grace period when SIGTERM is ignored (TD-003) | crates/conductor-daemon/src/claude/cli_driver/tests.rs::kill_sends_sigterm_first_then_sigkill_after_the_grace_when_ignored |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › kill() of a cooperative process exits on SIGTERM and never escalates | crates/conductor-daemon/src/claude/cli_driver/tests.rs::kill_of_a_cooperative_process_exits_on_sigterm_and_never_escalates |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › end() escalates to kill when the process ignores stdin EOF | crates/conductor-daemon/src/claude/cli_driver/tests.rs::end_escalates_to_kill_when_the_process_ignores_stdin_eof |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › parses leniently: raw lines and stderr pass through, a crash still reports exit | crates/conductor-daemon/src/claude/cli_driver/tests.rs::parses_leniently_raw_lines_and_stderr_pass_through_a_crash_still_reports_exit, crates/conductor-daemon/src/claude/cli_driver/tests.rs::take_utf8_keeps_a_split_character_for_the_next_read |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › reports error turns and permission denials; refuses a guarded complete_state | crates/conductor-daemon/src/claude/cli_driver/tests.rs::reports_error_turns_and_permission_denials_refuses_a_guarded_complete_state |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › a missing binary yields stderr output and an exit event | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_missing_binary_yields_stderr_output_and_an_exit_event, crates/conductor-daemon/src/claude/cli_driver/tests.rs::events_before_the_first_listener_are_delivered_to_it_in_order |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › U-110: a claude.cmd is refused with the install hint, before anything is registered | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_claude_cmd_is_refused_with_the_install_hint_before_anything_is_registered |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a held call resolves on allow: Claude gets the input back | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_held_call_resolves_on_allow_claude_gets_the_input_back |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a held call resolves on deny with the default text | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_held_call_resolves_on_deny_with_the_default_text |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a held call is denied at the timeout | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_held_call_is_denied_at_the_timeout |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › kill while held: the call is denied and the process exits | crates/conductor-daemon/src/claude/cli_driver/tests.rs::kill_while_held_the_call_is_denied_and_the_process_exits |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › ADR-0023 permission prompts › a worker announces auto mode; an old CLI falls back to the old flags with a warning | crates/conductor-daemon/src/claude/cli_driver/tests.rs::a_worker_announces_auto_mode_an_old_cli_falls_back_with_a_warning |
| claude/cli-driver.test.ts › createCliDriver against fake-claude › defaults claudeBin to $CONDUCTOR_CLAUDE_BIN | crates/conductor-daemon/src/claude/cli_driver/tests.rs::defaults_claude_bin_to_conductor_claude_bin |

### claude/edit-guard.test.ts

| TS case | Rust |
|---|---|
| claude/edit-guard.test.ts › edit guard settings › matches the file tools and pins the hook kill switches off (disableAllHooks, safe mode) | crates/conductor-daemon/tests/edit_guard.rs::settings_match_the_file_tools_and_pin_the_kill_switches_off, crates/conductor-daemon/src/claude/edit_guard.rs::tests::settings_match_the_file_tools_and_pin_the_kill_switches_off |
| claude/edit-guard.test.ts › edit guard settings › writes the script and settings 0600 (win32: owner-only DACL) | crates/conductor-daemon/tests/edit_guard.rs::writes_the_settings_0600_or_owner_only |
| claude/edit-guard.test.ts › edit guard settings › a path cmd.exe or Git Bash would reinterpret is refused at setup | crates/conductor-daemon/tests/edit_guard.rs::a_path_cmd_or_git_bash_would_reinterpret_is_refused_at_setup |
| claude/edit-guard.test.ts › edit guard › allows absolute paths inside the worktree, including new files in new directories | crates/conductor-daemon/tests/edit_guard.rs::allows_absolute_paths_inside_the_worktree_including_new_dirs |
| claude/edit-guard.test.ts › edit guard › blocks paths outside the worktree with exit 2 and a reason | crates/conductor-daemon/tests/edit_guard.rs::blocks_paths_outside_the_worktree_with_exit_2_and_a_reason |
| claude/edit-guard.test.ts › edit guard › expands ~ like Claude Code and blocks home paths; refuses relative paths | crates/conductor-daemon/tests/edit_guard.rs::expands_tilde_and_blocks_home_paths_refuses_relative_paths |
| claude/edit-guard.test.ts › edit guard › follows symlinks: to an existing dir, to a missing target, and `..` after a link | crates/conductor-daemon/tests/edit_guard.rs::follows_symlinks_existing_missing_and_dotdot_after_a_link, crates/conductor-daemon/src/claude/edit_guard.rs::tests::posix_rules_through_a_fake_fs |
| claude/edit-guard.test.ts › edit guard › checks every path field, not just the first | crates/conductor-daemon/tests/edit_guard.rs::checks_every_path_field_not_just_the_first |
| claude/edit-guard.test.ts › edit guard › fails closed: bad input, odd types, a guard crash, a missing script | crates/conductor-daemon/tests/edit_guard.rs::fails_closed_on_bad_input_and_odd_types, crates/conductor-daemon/src/claude/edit_guard.rs::tests::input_shapes_fail_closed, crates/conductor-daemon/src/claude/edit_guard.rs::tests::the_hook_writes_the_reason_and_exits_2 |
| claude/edit-guard.test.ts › edit guard › fails closed when node itself is missing (only exit 2 blocks) | crates/conductor-daemon/tests/edit_guard.rs::fails_closed_when_the_daemon_executable_is_missing |
| claude/edit-guard.test.ts › edit guard path forms (win32) › allows and blocks the right path forms | crates/conductor-daemon/tests/edit_guard.rs::windows_allows_and_blocks_the_right_path_forms, crates/conductor-daemon/src/claude/edit_guard.rs::tests::windows_path_forms_through_a_fake_fs |

### claude/fake-driver.test.ts

| TS case | Rust |
|---|---|
| claude/fake-driver.test.ts › FakeClaudeDriver › runs ask_user → live answer → complete_state, then exits 0 on end() | crates/conductor-daemon/src/claude/fake_driver.rs::tests::runs_ask_user_live_answer_complete_state_then_exits_0_on_end |
| claude/fake-driver.test.ts › FakeClaudeDriver › continues the script and cumulative spend on resume | crates/conductor-daemon/src/claude/fake_driver.rs::tests::continues_the_script_and_cumulative_spend_on_resume |
| claude/fake-driver.test.ts › FakeClaudeDriver › refuses complete_state while a question is pending, and a second one | crates/conductor-daemon/src/claude/fake_driver.rs::tests::refuses_complete_state_while_a_question_is_pending_and_a_second_one |
| claude/fake-driver.test.ts › FakeClaudeDriver › models a crash mid-turn | crates/conductor-daemon/src/claude/fake_driver.rs::tests::models_a_crash_mid_turn |

### claude/outcome-server.test.ts

| TS case | Rust |
|---|---|
| claude/outcome-server.test.ts › outcome server › binds 127.0.0.1 and issues a 128-bit path token per session | crates/conductor-daemon/src/claude/outcome_server.rs::tests::binds_127_0_0_1_and_issues_a_128_bit_path_token_per_session |
| claude/outcome-server.test.ts › outcome server › lists exactly complete_state, ask_user and (ADR-0023) permission | crates/conductor-daemon/src/claude/outcome_server.rs::tests::lists_exactly_complete_state_ask_user_and_permission |
| claude/outcome-server.test.ts › outcome server › ask_user returns at once with the ADR text; complete_state after the answer records | crates/conductor-daemon/src/claude/outcome_server.rs::tests::ask_user_returns_at_once_and_complete_state_after_the_answer_records |
| claude/outcome-server.test.ts › outcome server › attributes calls to the session that owns the token | crates/conductor-daemon/src/claude/outcome_server.rs::tests::attributes_calls_to_the_session_that_owns_the_token |
| claude/outcome-server.test.ts › outcome server › rejects invalid arguments without emitting | crates/conductor-daemon/src/claude/outcome_server.rs::tests::rejects_invalid_arguments_without_emitting |
| claude/outcome-server.test.ts › outcome server › 404s unknown and unregistered tokens, 405s non-POST, 403s foreign Host headers | crates/conductor-daemon/src/claude/outcome_server.rs::tests::status_404_405_403_and_unregister |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › emits a valid name with its reason | crates/conductor-daemon/src/claude/outcome_server.rs::tests::adr_0011_emits_a_valid_name_with_its_reason |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › refuses an unknown name once with the allowed list, then emits the next one as is | crates/conductor-daemon/src/claude/outcome_server.rs::tests::adr_0011_refuses_an_unknown_name_once_then_emits_the_next_as_is |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › a missing transition means done: nudged when done is not allowed | crates/conductor-daemon/src/claude/outcome_server.rs::tests::adr_0011_a_missing_transition_means_done |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › no list (old workflows, reviewers): any name passes | crates/conductor-daemon/src/claude/outcome_server.rs::tests::adr_0011_no_list_any_name_passes |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › the tool description lists the transitions | crates/conductor-daemon/src/claude/outcome_server.rs::tests::adr_0011_the_tool_description_lists_the_transitions |
| claude/outcome-server.test.ts › outcome server › ADR-0011 transitions › caps transition and reason at the tool call | crates/conductor-daemon/src/claude/outcome_server.rs::tests::adr_0011_caps_transition_and_reason_at_the_tool_call |
| claude/outcome-server.test.ts › ADR-0023 permission tool › holds the call until allow once: Claude gets the input back | crates/conductor-daemon/src/claude/outcome_server.rs::tests::holds_the_call_until_allow_once_and_claude_gets_the_input_back |
| claude/outcome-server.test.ts › ADR-0023 permission tool › allow always with a rule adds a session rule so this process does not ask again | crates/conductor-daemon/src/claude/outcome_server.rs::tests::allow_always_with_a_rule_adds_a_session_rule |
| claude/outcome-server.test.ts › ADR-0023 permission tool › deny: the human note, or the default text | crates/conductor-daemon/src/claude/outcome_server.rs::tests::deny_the_human_note_or_the_default_text |
| claude/outcome-server.test.ts › ADR-0023 permission tool › denies itself at the timeout; a later decision is unknown | crates/conductor-daemon/src/claude/outcome_server.rs::tests::denies_itself_at_the_timeout_and_a_later_decision_is_unknown |
| claude/outcome-server.test.ts › ADR-0023 permission tool › U-101: input over 64 KiB is denied at once and never sent | crates/conductor-daemon/src/claude/outcome_server.rs::tests::u101_input_over_64_kib_is_denied_at_once_and_never_sent |
| claude/outcome-server.test.ts › ADR-0023 permission tool › passes suggestions within bounds, drops them over the bounds | crates/conductor-daemon/src/claude/outcome_server.rs::tests::passes_suggestions_within_bounds_and_drops_them_over_the_bounds |
| claude/outcome-server.test.ts › ADR-0023 permission tool › denyPermission (an old server) denies the held call at once | crates/conductor-daemon/src/claude/outcome_server.rs::tests::deny_permission_from_an_old_server_denies_the_held_call_at_once |
| claude/outcome-server.test.ts › ADR-0023 permission tool › unregister (process gone) denies every held call; later prompts too | crates/conductor-daemon/src/claude/outcome_server.rs::tests::unregister_denies_every_held_call_and_later_prompts |
| claude/outcome-server.test.ts › ADR-0023 permission tool › close (daemon shutdown) denies every held call | crates/conductor-daemon/src/claude/outcome_server.rs::tests::close_denies_every_held_call |
| claude/outcome-server.test.ts › ADR-0023 permission tool › no handler: denied at once | crates/conductor-daemon/src/claude/outcome_server.rs::tests::no_handler_denied_at_once |
| claude/outcome-server.test.ts › ADR-0023 permission tool › parses exact rules into toolName / ruleContent | crates/conductor-daemon/src/claude/outcome_server.rs::tests::parses_exact_rules_into_tool_name_rule_content |

### claude/stream-parser.test.ts

| TS case | Rust |
|---|---|
| claude/stream-parser.test.ts › parseStreamLine › reads session id and CLI version from system/init | crates/conductor-daemon/src/claude/stream_parser.rs::tests::reads_session_id_and_cli_version_from_system_init |
| claude/stream-parser.test.ts › parseStreamLine › maps result to spend (cumulative total, per-turn usage) then turn_end | crates/conductor-daemon/src/claude/stream_parser.rs::tests::maps_result_to_spend_then_turn_end |
| claude/stream-parser.test.ts › parseStreamLine › result without a cost still ends the turn; error results are flagged | crates/conductor-daemon/src/claude/stream_parser.rs::tests::result_without_a_cost_still_ends_the_turn_and_flags_errors |
| claude/stream-parser.test.ts › parseStreamLine › maps assistant text and tool_use blocks, drops thinking | crates/conductor-daemon/src/claude/stream_parser.rs::tests::maps_assistant_text_and_tool_use_blocks_drops_thinking |
| claude/stream-parser.test.ts › parseStreamLine › maps user tool_result content (string or blocks) | crates/conductor-daemon/src/claude/stream_parser.rs::tests::maps_user_tool_result_content_string_or_blocks |
| claude/stream-parser.test.ts › parseStreamLine › is lenient: garbage, non-objects and unknown types become debug output | crates/conductor-daemon/src/claude/stream_parser.rs::tests::is_lenient_garbage_non_objects_and_unknown_types_become_debug |
| claude/stream-parser.test.ts › parseStreamLine › drops system/thinking_tokens progress estimates | crates/conductor-daemon/src/claude/stream_parser.rs::tests::drops_system_thinking_tokens_progress_estimates |

### claude/transcript.test.ts

| TS case | Rust |
|---|---|
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › maps a real-shaped transcript to the live parser streams, skipping everything else | crates/conductor-daemon/src/claude/transcript.rs::tests::maps_a_real_shaped_transcript_to_the_live_parser_streams, crates/conductor-daemon/src/claude/transcript.rs::tests::skips_meta_sidechain_and_other_lines_and_inherits_timestamps |
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › renders assistant and tool lines exactly like the live stream parser | crates/conductor-daemon/src/claude/transcript.rs::tests::renders_assistant_and_tool_lines_exactly_like_the_live_parser |
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › cuts each tool result at TRANSCRIPT_RESULT_CHARS with a marker | crates/conductor-daemon/src/claude/transcript.rs::tests::cuts_each_tool_result_at_transcript_result_chars_with_a_marker |
| claude/transcript.test.ts › transcriptChunks (ADR-0008) › keeps the most recent chunks within TRANSCRIPT_MAX_BYTES | crates/conductor-daemon/src/claude/transcript.rs::tests::keeps_the_most_recent_chunks_within_transcript_max_bytes |
| claude/transcript.test.ts › findTranscript › uses the realpath slug of the cwd, even when the worktree is gone | crates/conductor-daemon/src/claude/transcript.rs::tests::uses_the_realpath_slug_of_the_cwd_even_when_the_worktree_is_gone, crates/conductor-daemon/src/claude/transcript.rs::tests::slug_and_verbatim_paths |
| claude/transcript.test.ts › findTranscript › falls back to the newest project dir holding the id (a resume from another cwd) | crates/conductor-daemon/src/claude/transcript.rs::tests::falls_back_to_the_newest_project_dir_holding_the_id |
| claude/transcript.test.ts › findTranscript › refuses an id that is not a uuid (never a path) | crates/conductor-daemon/src/claude/transcript.rs::tests::find_transcript_refuses_an_id_that_is_not_a_uuid |
| claude/transcript.test.ts › findTranscript › readTranscriptTail reads a small file whole | crates/conductor-daemon/src/claude/transcript.rs::tests::read_transcript_tail_reads_a_small_file_whole |
| claude/transcript.test.ts › hasTranscriptInCwd (the resume check) › only the cwd's own project dir counts (claude --resume looks nowhere else) | crates/conductor-daemon/src/claude/transcript.rs::tests::only_the_cwds_own_project_dir_counts_for_resume |
| claude/transcript.test.ts › hasTranscriptInCwd (the resume check) › refuses an id that is not a uuid | crates/conductor-daemon/src/claude/transcript.rs::tests::has_transcript_in_cwd_refuses_an_id_that_is_not_a_uuid |

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
| commands/fake-runner.test.ts › FakeCommandRunner › scripts exit codes, output and timeouts | crates/conductor-daemon/src/commands/fake_runner.rs::tests::scripts_exit_codes_output_and_timeouts |
| commands/fake-runner.test.ts › FakeCommandRunner › queues the third of three commands with limit 2 and reports build_slot | crates/conductor-daemon/src/commands/fake_runner.rs::tests::queues_the_third_of_three_commands_with_limit_2_and_reports_build_slot |
| commands/fake-runner.test.ts › FakeCommandRunner › resolves with SIGTERM on abort | crates/conductor-daemon/src/commands/fake_runner.rs::tests::resolves_with_sigterm_on_abort |
| commands/fake-runner.test.ts › FakeCommandRunner › aborting a queued run keeps the next waiter queued until a slot frees | crates/conductor-daemon/src/commands/fake_runner.rs::tests::aborting_a_queued_run_keeps_the_next_waiter_queued_until_a_slot_frees |

### commands/process-runner.test.ts

| TS case | Rust |
|---|---|
| commands/process-runner.test.ts › createCommandRunner › returns the real runner with the given semaphore size | crates/conductor-daemon/src/commands/process_runner.rs::tests::create_command_runner_returns_the_real_runner_with_the_given_semaphore_size |
| commands/process-runner.test.ts › ProcessCommandRunner › exit 0: runs in cwd with merged env and streams output | crates/conductor-daemon/src/commands/process_runner.rs::tests::exit_0_runs_in_cwd_with_merged_env_and_streams_output |
| commands/process-runner.test.ts › ProcessCommandRunner › non-zero exit is a result, not a rejection | crates/conductor-daemon/src/commands/process_runner.rs::tests::non_zero_exit_is_a_result_not_an_error |
| commands/process-runner.test.ts › ProcessCommandRunner › timeout: kills the whole process group and reports timedOut | crates/conductor-daemon/src/commands/process_runner.rs::tests::timeout_kills_the_whole_process_group_and_reports_timed_out |
| commands/process-runner.test.ts › ProcessCommandRunner › timeout escalates to SIGKILL when SIGTERM is ignored | crates/conductor-daemon/src/commands/process_runner.rs::tests::timeout_escalates_to_sigkill_when_sigterm_is_ignored |
| commands/process-runner.test.ts › ProcessCommandRunner › abort (WS kill) terminates a running command | crates/conductor-daemon/src/commands/process_runner.rs::tests::abort_ws_kill_terminates_a_running_command |
| commands/process-runner.test.ts › ProcessCommandRunner › semaphore: 3 concurrent requests with limit 2 queue the third | crates/conductor-daemon/src/commands/process_runner.rs::tests::semaphore_3_concurrent_requests_with_limit_2_queue_the_third |
| commands/process-runner.test.ts › ProcessCommandRunner › aborting a queued command resolves SIGTERM without spawning or taking a slot | crates/conductor-daemon/src/commands/process_runner.rs::tests::aborting_a_queued_command_resolves_sigterm_without_spawning_or_taking_a_slot |
| commands/process-runner.test.ts › ProcessCommandRunner › keeps only the last tailBytes of combined output | crates/conductor-daemon/src/commands/process_runner.rs::tests::keeps_only_the_last_tail_bytes_of_combined_output |
| commands/process-runner.test.ts › ProcessCommandRunner › defaults the tail to OUTPUT_TAIL_BYTES | crates/conductor-daemon/src/commands/process_runner.rs::tests::defaults_the_tail_to_output_tail_bytes |
| commands/process-runner.test.ts › ProcessCommandRunner › rejects when the process cannot be spawned, and frees the slot | crates/conductor-daemon/src/commands/process_runner.rs::tests::fails_when_the_process_cannot_be_spawned_and_frees_the_slot |
| commands/process-runner.test.ts › Semaphore › is FIFO and hands a released slot to the oldest waiter | crates/conductor-daemon/src/commands/semaphore.rs::tests::is_fifo_and_hands_a_released_slot_to_the_oldest_waiter |
| commands/process-runner.test.ts › Semaphore › rejects a non-positive size | crates/conductor-daemon/src/commands/semaphore.rs::tests::rejects_a_non_positive_size |
| commands/process-runner.test.ts › TailBuffer › drops a multi-byte character cut at the front | crates/conductor-daemon/src/commands/tail.rs::tests::drops_a_multi_byte_character_cut_at_the_front |
| commands/process-runner.test.ts › TailBuffer › keeps everything under the limit across chunks | crates/conductor-daemon/src/commands/tail.rs::tests::keeps_everything_under_the_limit_across_chunks |

### commands/service.test.ts

| TS case | Rust |
|---|---|
| commands/service.test.ts › unit files › launchd on macOS, systemd on Linux, none on Windows | todo |
| commands/service.test.ts › unit files › the launchd plist runs the launcher, supervised, with pinned node, logs and a throttle | todo |
| commands/service.test.ts › unit files › the systemd unit runs the launcher, supervised, and never restarts on 78 | todo |
| commands/service.test.ts › unit files › escapes XML and systemd specifiers, and refuses what systemd cannot quote | todo |
| commands/service.test.ts › unit files › restart policy: 75 and crashes restart, 0 and 78 do not (TD-119, ADR-0021) | todo |
| commands/service.test.ts › unit files › stopSupervisedJob does nothing when unsupervised or under systemd | todo |
| commands/service.test.ts › service install / uninstall / restart › `${manager}: install writes the unit and the launcher; a second install changes nothing` | todo |
| commands/service.test.ts › service install / uninstall / restart › `${manager}: restart, status and uninstall; sudo is never used` | todo |
| commands/service.test.ts › service install / uninstall / restart › `${manager}: refuses without an installed daemon, and with Node 20` | todo |
| commands/service.test.ts › service install / uninstall / restart › usage errors and an OS without a service manager exit 2 | todo |

### credential.test.ts

| TS case | Rust |
|---|---|
| credential.test.ts › loadCredential › is null (local mode) without a root or a file | crates/conductor-daemon/src/credential.rs::tests::is_none_local_mode_without_a_root_or_a_file |
| credential.test.ts › loadCredential › round-trips what writeCredential wrote | crates/conductor-daemon/src/credential.rs::tests::round_trips_what_write_credential_wrote |
| credential.test.ts › loadCredential › refuses a group/other-readable file and says how to fix it | crates/conductor-daemon/src/credential.rs::tests::refuses_a_group_other_readable_file_and_says_how_to_fix_it |
| credential.test.ts › loadCredential › refuses a root other users can read (win32: any non-owner-only DACL) | crates/conductor-daemon/src/credential.rs::tests::refuses_a_root_other_users_can_read |
| credential.test.ts › loadCredential › refuses a symlinked file and a symlinked root | crates/conductor-daemon/src/credential.rs::tests::refuses_a_symlinked_file_and_a_symlinked_root |
| credential.test.ts › loadCredential › refuses invalid content without echoing it | crates/conductor-daemon/src/credential.rs::tests::refuses_invalid_content_without_echoing_it |
| credential.test.ts › credential.ts on POSIX (TD-118) › a symlinked machine.json is refused by the O_NOFOLLOW open, even when the target is private | crates/conductor-daemon/src/credential.rs::tests::a_symlinked_machine_json_is_refused_by_the_o_nofollow_open |
| credential.test.ts › credential.ts on POSIX (TD-118) › a write fsyncs the file and then the root | crates/conductor-daemon/src/credential.rs::tests::a_write_fsyncs_the_file_and_then_the_root |
| credential.test.ts › credential.ts on POSIX (TD-118) › a symlinked root is refused and its target is never chmodded | crates/conductor-daemon/src/credential.rs::tests::a_symlinked_root_is_refused_and_its_target_is_never_chmodded |
| credential.test.ts › credential.ts on POSIX (TD-118) › a loose existing root is tightened to 0700 by a write | crates/conductor-daemon/src/credential.rs::tests::a_loose_existing_root_is_tightened_to_0700_by_a_write |
| credential.test.ts › machine.json url › rejects plain http to a non-loopback host, on load and on write | crates/conductor-daemon/src/credential.rs::tests::rejects_plain_http_to_a_non_loopback_host_on_load_and_on_write |
| credential.test.ts › daemonWsUrl › maps https → wss and http → ws on the daemon WS path | crates/conductor-daemon/src/credential.rs::tests::maps_https_to_wss_and_http_to_ws_on_the_daemon_ws_path |
| credential.test.ts › loadConfig with machine.json › uses the enrolled machine id, the stored url and the credential | crates/conductor-daemon/src/config.rs::tests::uses_the_enrolled_machine_id_the_stored_url_and_the_credential |
| credential.test.ts › loadConfig with machine.json › refuses a cleartext URL to a non-loopback host when enrolled | crates/conductor-daemon/src/config.rs::tests::refuses_a_cleartext_url_to_a_non_loopback_host_when_enrolled |
| credential.test.ts › loadConfig with machine.json › CONDUCTOR_ORCHESTRATOR_URL still wins | crates/conductor-daemon/src/config.rs::tests::conductor_orchestrator_url_still_wins |
| credential.test.ts › loadConfig with machine.json › local mode is unchanged | crates/conductor-daemon/src/config.rs::tests::local_mode_is_unchanged |
| credential.test.ts › loadConfig with machine.json › daemonVersion appends CONDUCTOR_BUILD_SHA | crates/conductor-daemon/src/config.rs::tests::daemon_version_appends_conductor_build_sha |

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
| daemon.test.ts › daemon core: link › logs no_work's reason only when it changes (M2-T36) | todo |
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
| index.test.ts › @conductor/daemon scaffold › resolves @conductor/shared across the workspace | crates/conductor-daemon/tests/scaffold.rs::resolves_the_protocol_crate |

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
| inventory/version.test.ts › cliVersionFrom › %j → %s | crates/conductor-daemon/src/inventory/version.rs::tests::extracts_the_version_token |
| inventory/version.test.ts › cliVersionFrom › garbage → null | crates/conductor-daemon/src/inventory/version.rs::tests::garbage_is_none |

### orphan.test.ts

| TS case | Rust |
|---|---|
| orphan.test.ts › parseLstart › parses ps lstart (UTC) to ms epoch | crates/conductor-daemon/src/orphan.rs::tests::parses_ps_lstart_utc_to_ms_epoch |
| orphan.test.ts › parseLstart › returns null for anything else | crates/conductor-daemon/src/orphan.rs::tests::returns_none_for_anything_else |
| orphan.test.ts › parseLstart › readProcInfo reads this process (read-only) and null for no such pid | crates/conductor-daemon/src/orphan.rs::tests::read_proc_info_reads_this_process_and_none_for_no_such_pid |
| orphan.test.ts › checkOurs › %s | crates/conductor-daemon/src/orphan.rs::tests::check_ours_cases |
| orphan.test.ts › checkOurs › matches the configured binary by exact path, even with spaces | crates/conductor-daemon/src/orphan.rs::tests::matches_the_configured_binary_by_exact_path_even_with_spaces |
| orphan.test.ts › checkOurs › (d) an empty or non-UUID stored id is never ours | crates/conductor-daemon/src/orphan.rs::tests::an_empty_or_non_uuid_stored_id_is_never_ours |
| orphan.test.ts › checkOurs › FR-4: no recorded start time is never ours | crates/conductor-daemon/src/orphan.rs::tests::no_recorded_start_time_is_never_ours |

### platform/acl.test.ts

| TS case | Rust |
|---|---|
| platform/acl.test.ts › parseWhoamiCsv › reads the SID with and without the header row, CRLF and a BOM | dropped: the Rust daemon reads ACLs natively, with no PowerShell, icacls or whoami (FR-4, ADR-0026); current_user_sid comes from the process token, covered by crates/conductor-daemon/src/platform/acl.rs::tests::win32::current_user_sid_is_a_user_sid |
| platform/acl.test.ts › parseWhoamiCsv › refuses %s | dropped: the Rust daemon reads ACLs natively, with no PowerShell, icacls or whoami (FR-4, ADR-0026); no whoami output to parse |
| platform/acl.test.ts › parseGetAclJson › reads owner, protection, rules, SDDL and ACE count | dropped: the Rust daemon reads ACLs natively, with no PowerShell, icacls or whoami (FR-4, ADR-0026); no Get-Acl JSON; the native read is covered by crates/conductor-daemon/src/platform/acl.rs::tests::win32::a_real_owner_only_acl_has_matching_sddl_ace_count_and_rules |
| platform/acl.test.ts › parseGetAclJson › accepts ConvertTo-Json flattening a single rule to an object, and null for none | dropped: the Rust daemon reads ACLs natively, with no PowerShell, icacls or whoami (FR-4, ADR-0026); no ConvertTo-Json output to parse |
| platform/acl.test.ts › parseGetAclJson › throws on %s (callers fail closed) | dropped: the Rust daemon reads ACLs natively, with no PowerShell, icacls or whoami (FR-4, ADR-0026); no Get-Acl JSON; a failed native read is Unreadable (fail closed) |
| platform/acl.test.ts › parseSddl / resolveSddlSid › reads owner, DACL flags and ACEs, skipping over conditional expressions | crates/conductor-daemon/src/platform/acl.rs::tests::parse_sddl_reads_owner_flags_and_aces_skipping_conditional_expressions |
| platform/acl.test.ts › parseSddl / resolveSddlSid › finds the DACL after alias owners and groups that contain a D | crates/conductor-daemon/src/platform/acl.rs::tests::parse_sddl_finds_the_dacl_after_alias_owners_and_groups_containing_a_d |
| platform/acl.test.ts › parseSddl / resolveSddlSid › throws on %s | crates/conductor-daemon/src/platform/acl.rs::tests::parse_sddl_errs_on_malformed_input |
| platform/acl.test.ts › parseSddl / resolveSddlSid › resolves SIDs, fixed aliases and domain-relative aliases; refuses unknown aliases | crates/conductor-daemon/src/platform/acl.rs::tests::resolve_sddl_sid_resolves_sids_and_aliases_refusing_unknown_ones |
| platform/acl.test.ts › evaluateWinAcl › passes an owner-only ACL (SIDs compared case-insensitively, aliases resolved) | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_passes_an_owner_only_acl |
| platform/acl.test.ts › evaluateWinAcl › refuses a file owned by another SID, naming it | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_refuses_a_foreign_owner_naming_it |
| platform/acl.test.ts › evaluateWinAcl › refuses an allow-ACE for any other SID, and says how to fix it | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_refuses_an_allow_ace_for_another_sid_with_the_fix |
| platform/acl.test.ts › evaluateWinAcl › ignores deny-ACEs for other SIDs | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_ignores_deny_aces_for_other_sids |
| platform/acl.test.ts › evaluateWinAcl › refuses inheritance, whether flagged on the ACL, on a rule or on an SDDL ACE | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_refuses_inheritance_on_the_acl_a_rule_or_an_sddl_ace |
| platform/acl.test.ts › evaluateWinAcl › checkAccess: false checks only the owner | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_check_access_false_checks_only_the_owner |
| platform/acl.test.ts › evaluateWinAcl › refuses a %s ACE the rules do not show | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_refuses_an_ace_the_rules_do_not_show |
| platform/acl.test.ts › evaluateWinAcl › refuses a NULL DACL, from the SDDL or the raw count | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_refuses_a_null_dacl |
| platform/acl.test.ts › evaluateWinAcl › treats SDDL / raw count / rules disagreement as unreadable | crates/conductor-daemon/src/platform/acl.rs::tests::evaluate_treats_any_disagreement_as_unreadable |
| platform/acl.test.ts › icaclsRestrictArgs / GET_ACL_SCRIPT › grants only user, SYSTEM and Administrators, removing inheritance; dirs propagate | crates/conductor-daemon/src/platform/acl.rs::tests::owner_only_aces_grant_only_user_system_and_administrators_dirs_propagate |
| platform/acl.test.ts › icaclsRestrictArgs / GET_ACL_SCRIPT › reads the path from the environment, never from the script text | dropped: the Rust daemon reads ACLs natively, with no PowerShell, icacls or whoami (FR-4, ADR-0026); no script, so no path can be spliced into one |
| platform/acl.test.ts › POSIX › writePrivateFile writes 0600 atomically, leaving no temp file | crates/conductor-daemon/src/platform/acl.rs::tests::posix::write_private_file_writes_0600_atomically_leaving_no_temp_file |
| platform/acl.test.ts › POSIX › writePrivateFile leaves no temp file when the rename fails | crates/conductor-daemon/src/platform/acl.rs::tests::posix::write_private_file_leaves_no_temp_file_when_the_rename_fails |
| platform/acl.test.ts › POSIX › mkdirPrivate creates parents and chmods 0700, also an existing 0755 dir | crates/conductor-daemon/src/platform/acl.rs::tests::posix::mkdir_private_creates_parents_and_chmods_0700_also_an_existing_0755_dir |
| platform/acl.test.ts › POSIX › mkdirPrivate refuses a symlink without chmodding its target | crates/conductor-daemon/src/platform/acl.rs::tests::posix::mkdir_private_refuses_a_symlink_without_chmodding_its_target |
| platform/acl.test.ts › POSIX › refuses a group/other-readable file with the chmod hint | crates/conductor-daemon/src/platform/acl.rs::tests::posix::refuses_a_group_other_readable_file_with_the_chmod_hint |
| platform/acl.test.ts › POSIX › never mode-checks a dir (ADR-0010 checks only its owner) | crates/conductor-daemon/src/platform/acl.rs::tests::posix::never_mode_checks_a_dir |
| platform/acl.test.ts › POSIX › refuses symlinks and the wrong kind with the credential.ts messages | crates/conductor-daemon/src/platform/acl.rs::tests::posix::refuses_symlinks_and_the_wrong_kind_with_the_credential_messages |
| platform/acl.test.ts › POSIX › refuses a path owned by another uid | crates/conductor-daemon/src/platform/acl.rs::tests::posix::refuses_a_path_owned_by_another_uid |
| platform/acl.test.ts › POSIX › throws ENOENT for a missing path, as checkPrivateDir does | crates/conductor-daemon/src/platform/acl.rs::tests::posix::a_missing_path_is_not_found |
| platform/acl.test.ts › POSIX › currentUserSid is win32-only | crates/conductor-daemon/src/platform/acl.rs::tests::posix::current_user_sid_is_win32_only |
| platform/acl.test.ts › win32 › currentUserSid is a user SID | crates/conductor-daemon/src/platform/acl.rs::tests::win32::current_user_sid_is_a_user_sid |
| platform/acl.test.ts › win32 › a file written by writePrivateFile passes and holds the data | crates/conductor-daemon/src/platform/acl.rs::tests::win32::a_file_written_by_write_private_file_passes_and_holds_the_data |
| platform/acl.test.ts › win32 › refuses a plain (inheriting) file | crates/conductor-daemon/src/platform/acl.rs::tests::win32::refuses_a_plain_inheriting_file |
| platform/acl.test.ts › win32 › refuses after Everyone is granted read, with a clear message | crates/conductor-daemon/src/platform/acl.rs::tests::win32::refuses_after_everyone_is_granted_read |
| platform/acl.test.ts › win32 › refuses after inheritance is re-enabled | crates/conductor-daemon/src/platform/acl.rs::tests::win32::refuses_after_inheritance_is_re_enabled |
| platform/acl.test.ts › win32 › refuses a file owned by another SID (when the runner may set one) | crates/conductor-daemon/src/platform/acl.rs::tests::win32::refuses_a_file_owned_by_another_sid_when_the_runner_may_set_one |
| platform/acl.test.ts › win32 › mkdirPrivate refuses an existing dir owned by another SID (when the runner may set one) | crates/conductor-daemon/src/platform/acl.rs::tests::win32::mkdir_private_refuses_an_existing_dir_owned_by_another_sid |
| platform/acl.test.ts › win32 › mkdirPrivate makes an owner-only dir whose new children inherit only those grants | crates/conductor-daemon/src/platform/acl.rs::tests::win32::mkdir_private_makes_an_owner_only_dir_whose_children_inherit_only_those_grants |
| platform/acl.test.ts › win32 › refuses a junction and a missing path fails closed | crates/conductor-daemon/src/platform/acl.rs::tests::win32::refuses_a_junction_and_a_missing_path_fails_closed |
| platform/acl.test.ts › win32 › handles paths with spaces, quotes-free metacharacters and brackets | crates/conductor-daemon/src/platform/acl.rs::tests::win32::handles_paths_with_spaces_metacharacters_and_brackets |
| platform/acl.test.ts › win32 › no inherited-permission window › writePrivateFile refuses a folder that is not private, creating nothing | crates/conductor-daemon/src/platform/acl.rs::tests::win32::write_private_file_refuses_a_folder_that_is_not_private_creating_nothing |
| platform/acl.test.ts › win32 › no inherited-permission window › mkdirPrivate refuses to create under a non-private ancestor, creating nothing | crates/conductor-daemon/src/platform/acl.rs::tests::win32::mkdir_private_refuses_to_create_under_a_non_private_ancestor_creating_nothing |
| platform/acl.test.ts › win32 › no inherited-permission window › mkdirPrivate creates directly under %LOCALAPPDATA%, every new level owner-only | crates/conductor-daemon/src/platform/acl.rs::tests::win32::mkdir_private_creates_directly_under_localappdata_every_level_owner_only |
| platform/acl.test.ts › win32 › no inherited-permission window › mkdirPrivate creates directly under the profile dir | crates/conductor-daemon/src/platform/acl.rs::tests::win32::mkdir_private_creates_directly_under_the_profile_dir |
| platform/acl.test.ts › win32 › no inherited-permission window › a real owner-only ACL has matching SDDL, raw ACE count and rules | crates/conductor-daemon/src/platform/acl.rs::tests::win32::a_real_owner_only_acl_has_matching_sddl_ace_count_and_rules |

### platform/index.test.ts

| TS case | Rust |
|---|---|
| platform/index.test.ts › platform seam › exports the MW-T03 modules | crates/conductor-daemon/src/platform/mod.rs::tests::exports_the_platform_modules |
| platform/index.test.ts › platform seam › U-107: lstat on a junction | crates/conductor-daemon/src/platform/mod.rs::tests::u107_lstat_on_a_junction |

### platform/kill-tree.test.ts

| TS case | Rust |
|---|---|
| platform/kill-tree.test.ts › killTree › taskkillArgs: tree, force, by pid | crates/conductor-daemon/src/platform/kill_tree.rs::tests::taskkill_args_tree_force_by_pid |
| platform/kill-tree.test.ts › killTree › rejects a bad pid and ignores a never-spawned child | crates/conductor-daemon/src/platform/kill_tree.rs::tests::rejects_a_bad_pid_and_ignores_a_never_spawned_child |
| platform/kill-tree.test.ts › killTree › kills a node child and its grandchild (both pids gone) | crates/conductor-daemon/src/platform/kill_tree.rs::tests::kills_a_child_and_its_grandchild, crates/conductor-daemon/src/platform/kill_tree.rs::tests::win32_job_kills_a_detached_reparented_grandchild |
| platform/kill-tree.test.ts › killTree › accepts a bare pid as well | crates/conductor-daemon/src/platform/kill_tree.rs::tests::accepts_a_bare_pid_as_well |
| platform/kill-tree.test.ts › killTree › POSIX: escalates to SIGKILL after the grace period | crates/conductor-daemon/src/platform/kill_tree.rs::tests::posix_escalates_to_sigkill_after_the_grace_period |
| platform/kill-tree.test.ts › killTree › POSIX: cancel() stops the escalation | crates/conductor-daemon/src/platform/kill_tree.rs::tests::posix_cancel_stops_the_escalation |
| platform/kill-tree.test.ts › killTree › win32: an exited child is skipped (its pid may be reused) | crates/conductor-daemon/src/platform/kill_tree.rs::tests::win32_an_exited_child_without_a_job_is_skipped |

### platform/procinfo.test.ts

| TS case | Rust |
|---|---|
| platform/procinfo.test.ts › parsePsLine (POSIX, as orphan.ts) › parses lstart (UTC) and the command | crates/conductor-daemon/src/platform/procinfo.rs::tests::parse_ps_line_parses_lstart_utc_and_the_command |
| platform/procinfo.test.ts › parsePsLine (POSIX, as orphan.ts) › returns null for anything else | crates/conductor-daemon/src/platform/procinfo.rs::tests::parse_ps_line_returns_none_for_anything_else |
| platform/procinfo.test.ts › parseWindowsCommandLine (CommandLineToArgvW) › %j | crates/conductor-daemon/src/platform/procinfo.rs::tests::parse_windows_command_line_cases |
| platform/procinfo.test.ts › parseCimDate › accepts every shape PowerShell may print | dropped: the Rust daemon reads procinfo natively, with no PowerShell/CIM (FR-3, ADR-0026); the start time is a FILETIME from GetProcessTimes, covered by crates/conductor-daemon/src/platform/procinfo.rs::tests::read_proc_info_reads_a_spawned_child_then_none_once_dead |
| platform/procinfo.test.ts › parseCimDate › null for zone-less or garbage values | dropped: the Rust daemon reads procinfo natively, with no PowerShell/CIM (FR-3, ADR-0026); no date text to parse |
| platform/procinfo.test.ts › parseCimProcessJson › reads start time, command, argv and image path | dropped: the Rust daemon reads procinfo natively, with no PowerShell/CIM (FR-3, ADR-0026); covered natively by crates/conductor-daemon/src/platform/procinfo.rs::tests::read_proc_info_reads_a_spawned_child_then_none_once_dead |
| platform/procinfo.test.ts › parseCimProcessJson › null when gone, unreadable (CommandLine null) or malformed | dropped: the Rust daemon reads procinfo natively, with no PowerShell/CIM (FR-3, ADR-0026); gone or unreadable is covered by crates/conductor-daemon/src/platform/procinfo.rs::tests::read_proc_info_none_for_a_missing_or_invalid_pid |
| platform/procinfo.test.ts › parseCimProcessJson › cimScript embeds an integer pid only | crates/conductor-daemon/src/platform/procinfo.rs::tests::read_proc_info_none_for_a_missing_or_invalid_pid |
| platform/procinfo.test.ts › readProcInfo (real processes) › returns the start time and argv of a spawned child, then null once it is dead | crates/conductor-daemon/src/platform/procinfo.rs::tests::read_proc_info_reads_a_spawned_child_then_none_once_dead |
| platform/procinfo.test.ts › readProcInfo (real processes) › null for a pid that does not exist or is invalid | crates/conductor-daemon/src/platform/procinfo.rs::tests::read_proc_info_none_for_a_missing_or_invalid_pid |

### platform/seam.test.ts

| TS case | Rust |
|---|---|
| platform/seam.test.ts › platform seam (ADR-0024 §1) › no daemon source outside platform/ branches on process.platform | crates/conductor-daemon/tests/seam.rs::no_os_cfg_outside_platform |

### platform/shell.test.ts

| TS case | Rust |
|---|---|
| platform/shell.test.ts › workflowShell › POSIX: /bin/sh -c | crates/conductor-daemon/src/platform/shell.rs::tests::workflow_shell_posix_is_bin_sh_c |
| platform/shell.test.ts › workflowShell › runs a POSIX command line with quotes, $ and && on this OS | crates/conductor-daemon/src/platform/shell.rs::tests::workflow_shell_runs_a_posix_command_line_on_this_os |
| platform/shell.test.ts › workflowShell › win32: finds Git Bash on the runner (not WSL bash) | crates/conductor-daemon/src/platform/shell.rs::tests::win32_finds_git_bash_on_the_runner_not_wsl_bash |
| platform/shell.test.ts › findGitBash › CONDUCTOR_SHELL wins, and must exist | crates/conductor-daemon/src/platform/shell.rs::tests::find_git_bash_conductor_shell_wins_and_must_exist |
| platform/shell.test.ts › findGitBash › then CLAUDE_CODE_GIT_BASH_PATH | crates/conductor-daemon/src/platform/shell.rs::tests::find_git_bash_then_claude_code_git_bash_path |
| platform/shell.test.ts › findGitBash › then relative to git --exec-path (forward slashes, any MSYS prefix) | crates/conductor-daemon/src/platform/shell.rs::tests::find_git_bash_then_relative_to_git_exec_path |
| platform/shell.test.ts › findGitBash › then the default install dirs, in order | crates/conductor-daemon/src/platform/shell.rs::tests::find_git_bash_then_the_default_install_dirs_in_order |
| platform/shell.test.ts › findGitBash › throws with the places it looked when there is no Git Bash | crates/conductor-daemon/src/platform/shell.rs::tests::find_git_bash_errs_with_the_places_it_looked |

### platform/spawn.test.ts

| TS case | Rust |
|---|---|
| platform/spawn.test.ts › resolveWindowsBin › searches absolute PATH entries in order with PATHEXT order | crates/conductor-daemon/src/platform/spawn.rs::tests::resolve_searches_absolute_path_entries_in_order_with_pathext_order |
| platform/spawn.test.ts › resolveWindowsBin › honours PATHEXT order and an explicit extension | crates/conductor-daemon/src/platform/spawn.rs::tests::resolve_honours_pathext_order_and_an_explicit_extension |
| platform/spawn.test.ts › resolveWindowsBin › never looks in the cwd for a bare name, and skips relative PATH entries | crates/conductor-daemon/src/platform/spawn.rs::tests::resolve_never_looks_in_the_cwd_for_a_bare_name_and_skips_relative_path_entries |
| platform/spawn.test.ts › resolveWindowsBin › resolves a name with a directory part against cwd only | crates/conductor-daemon/src/platform/spawn.rs::tests::resolve_a_name_with_a_directory_part_against_cwd_only |
| platform/spawn.test.ts › resolveWindowsBin › returns null when nothing matches | crates/conductor-daemon/src/platform/spawn.rs::tests::resolve_returns_none_when_nothing_matches |
| platform/spawn.test.ts › escapeCmdArg › quotes for MSVCRT and caret-escapes metacharacters twice | crates/conductor-daemon/src/platform/spawn.rs::tests::escape_cmd_arg_quotes_for_msvcrt_and_caret_escapes_twice |
| platform/spawn.test.ts › escapeCmdArg › refuses CR, LF and NUL (cmd.exe ends the command at a newline) | crates/conductor-daemon/src/platform/spawn.rs::tests::escape_cmd_arg_refuses_cr_lf_and_nul |
| platform/spawn.test.ts › buildCmdLine length guard (TD-192) › refuses a cmd.exe line over 8191 characters with ERR_CMD_UNSAFE_ARG | crates/conductor-daemon/src/platform/spawn.rs::tests::build_cmd_line_refuses_a_line_over_8191_characters |
| platform/spawn.test.ts › buildCmdLine round trip (cmd model + CommandLineToArgvW) › delivers every nasty arg intact through cmd /c and a %* batch shim | crates/conductor-daemon/src/platform/spawn.rs::tests::build_cmd_line_delivers_every_nasty_arg_through_cmd_and_a_batch_shim |
| platform/spawn.test.ts › buildCmdLine round trip (cmd model + CommandLineToArgvW) › caret-escapes spaces, parens and the colon in the program path | crates/conductor-daemon/src/platform/spawn.rs::tests::build_cmd_line_caret_escapes_the_program_path |
| platform/spawn.test.ts › buildCmdLine round trip (cmd model + CommandLineToArgvW) › leaves no %NAME% / %NAME:…% span whose name is a real variable | crates/conductor-daemon/src/platform/spawn.rs::tests::escape_leaves_no_percent_span_naming_a_real_variable |
| platform/spawn.test.ts › prepareCli › POSIX: spawn as given, keeps detached, drops shell | crates/conductor-daemon/src/platform/spawn.rs::tests::prepare_posix_spawns_as_given_and_keeps_detached |
| platform/spawn.test.ts › prepareCli › win32: an .exe is spawned directly by absolute path, hidden, never detached | crates/conductor-daemon/src/platform/spawn.rs::tests::prepare_win32_exe_directly_by_absolute_path_hidden_never_detached |
| platform/spawn.test.ts › prepareCli › win32: a .cmd/.bat runs via System32 cmd.exe /d /s /c with verbatim arguments | crates/conductor-daemon/src/platform/spawn.rs::tests::prepare_win32_cmd_runs_via_system32_cmd_with_verbatim_arguments |
| platform/spawn.test.ts › prepareCli › win32: an unresolvable bin is null (the caller reports ENOENT) | crates/conductor-daemon/src/platform/spawn.rs::tests::prepare_win32_unresolvable_bin_is_none |
| platform/spawn.test.ts › prepareCli › win32: a multi-line argument for a .cmd throws instead of being truncated | crates/conductor-daemon/src/platform/spawn.rs::tests::prepare_win32_multi_line_argument_for_a_cmd_errs |
| platform/spawn.test.ts › spawnCli (real processes) › a bare name resolves through PATH (PATHEXT on win32) and gets metachar args intact | crates/conductor-daemon/src/platform/spawn.rs::tests::spawn_bare_name_resolves_through_path_with_metachar_args_intact |
| platform/spawn.test.ts › spawnCli (real processes) › execFileCliSync does the same synchronously | crates/conductor-daemon/src/platform/spawn.rs::tests::exec_file_cli_sync_does_the_same_synchronously |
| platform/spawn.test.ts › spawnCli (real processes) › runs an absolute .exe/binary directly | crates/conductor-daemon/src/platform/spawn.rs::tests::spawn_runs_an_absolute_binary_directly |
| platform/spawn.test.ts › spawnCli (real processes) › a missing bin fails with an ENOENT error event and no pid | crates/conductor-daemon/src/platform/spawn.rs::tests::spawn_a_missing_bin_fails_with_enoent_and_no_pid |
| platform/spawn.test.ts › spawnCli (real processes) › win32: a node.cmd/node.bat planted in the cwd is not run by the shim | crates/conductor-daemon/src/platform/spawn.rs::tests::win32_a_node_cmd_planted_in_the_cwd_is_not_run_by_the_shim |
| platform/spawn.test.ts › spawnCli (real processes) › win32: a program planted in the cwd is not run for a bare name | crates/conductor-daemon/src/platform/spawn.rs::tests::win32_a_program_planted_in_the_cwd_is_not_run_for_a_bare_name |

### platform/sysres.test.ts

| TS case | Rust |
|---|---|
| platform/sysres.test.ts › busyCoresBetween (win32 CPU, ADR-0024 §8) › is the busy share of the elapsed time times the cores | crates/conductor-daemon/src/platform/sysres.rs::tests::busy_cores_between_is_the_busy_share_times_the_cores |
| platform/sysres.test.ts › busyCoresBetween (win32 CPU, ADR-0024 §8) › busyCores is a number between 0 and the core count on every OS | crates/conductor-daemon/src/platform/sysres.rs::tests::busy_cores_is_a_finite_non_negative_number_on_every_os |

### reopen-transcript.test.ts

| TS case | Rust |
|---|---|
| reopen-transcript.test.ts › fetch_transcript (ADR-0008) › answers with the session transcript located from the store | todo |
| reopen-transcript.test.ts › fetch_transcript (ADR-0008) › unknown_session for a session this daemon never ran | todo |
| reopen-transcript.test.ts › reopen: a new session on the earlier session’s branch (ADR-0008) › reuses the old worktree, resumes the Claude session, and both transcripts resolve | todo |
| reopen-transcript.test.ts › reopen: a new session on the earlier session’s branch (ADR-0008) › refuses the start while the earlier session still has a live process in that worktree | todo |

### rust-compat.test.ts

| TS case | Rust |
|---|---|
| rust-compat.test.ts › Rust daemon file compatibility (MR-T05) › the TS fixtures are what the TS daemon writes | crates/conductor-daemon/tests/compat_ts_files.rs::reads_the_files_the_ts_daemon_wrote |
| rust-compat.test.ts › Rust daemon file compatibility (MR-T05) › reads the machine.json, config.json and store the Rust daemon wrote | crates/conductor-daemon/tests/compat_ts_files.rs::the_rust_fixtures_are_what_the_rust_daemon_writes |

### sysinfo.test.ts

| TS case | Rust |
|---|---|
| sysinfo.test.ts › parseVmStatAvailableBytes › counts free + inactive + speculative + purgeable pages | crates/conductor-daemon/src/sysinfo.rs::tests::counts_free_inactive_speculative_and_purgeable_pages |
| sysinfo.test.ts › parseVmStatAvailableBytes › returns null on unparseable output | crates/conductor-daemon/src/sysinfo.rs::tests::returns_none_on_unparseable_output |
| sysinfo.test.ts › liveResources › reports more than the raw free pages on macOS | crates/conductor-daemon/src/sysinfo.rs::tests::reports_more_than_the_raw_free_pages_on_macos |

### test-support/fake-bin.test.ts

| TS case | Rust |
|---|---|
| test-support/fake-bin.test.ts › writeFakeBin › echoes args with spaces and cmd metacharacters back exactly | crates/conductor-daemon/src/test_support/fake_bin.rs::tests::echoes_args_with_spaces_and_cmd_metacharacters_back_exactly |
| test-support/fake-bin.test.ts › writeFakeBin › writes a #!/usr/bin/env node script, mode 755, on POSIX | crates/conductor-daemon/src/test_support/fake_bin.rs::tests::writes_a_node_script_mode_755_on_posix |
| test-support/fake-bin.test.ts › writeFakeBin › writes name.mjs plus a name.cmd shim on win32 | crates/conductor-daemon/src/test_support/fake_bin.rs::tests::writes_name_mjs_plus_a_name_cmd_shim_on_windows |
| test-support/fake-bin.test.ts › pathWith › joins dirs with the platform delimiter, dropping empties | crates/conductor-daemon/src/test_support/fake_bin.rs::tests::path_with_joins_with_the_platform_delimiter_dropping_empties |

### units.test.ts

| TS case | Rust |
|---|---|
| units.test.ts › loadConfig › defaults: localhost orchestrator on CONDUCTOR_PORT, 25 % owner reserve, port pool | crates/conductor-daemon/src/config.rs::tests::defaults_localhost_orchestrator_owner_reserve_and_port_pool |
| units.test.ts › loadConfig › reads env overrides and rejects bad values | crates/conductor-daemon/src/config.rs::tests::reads_env_overrides_and_rejects_bad_values |
| units.test.ts › loadConfig › M1-T14: local repos are off by default; repo hosts are unrestricted unless listed | crates/conductor-daemon/src/config.rs::tests::local_repos_are_off_by_default_and_repo_hosts_unrestricted_unless_listed |
| units.test.ts › PortPool › allocates aligned ranges, reuses a session’s range, and reports exhaustion | crates/conductor-daemon/src/ports.rs::tests::allocates_aligned_ranges_reuses_a_sessions_range_and_reports_exhaustion |
| units.test.ts › DaemonStore › persists seq, buffered events, acks and sessions across instances | crates/conductor-daemon/src/store.rs::tests::persists_seq_buffered_events_acks_and_sessions_across_instances |
| units.test.ts › DaemonStore › onRegistered: drops confirmed events, sequences the rest from max(local+1, last_seq+1) | crates/conductor-daemon/src/store.rs::tests::on_registered_drops_confirmed_events_and_sequences_the_rest |
| units.test.ts › helpers › cloneSource / repoSlug | todo |
| units.test.ts › helpers › backoff grows exponentially with jitter and is capped | crates/conductor-daemon/src/ws_client.rs::tests::backoff_grows_exponentially_with_jitter_and_is_capped |
| units.test.ts › helpers › appendSystemPrompt carries CLAUDE.md after the conductor instructions | crates/conductor-daemon/src/system_prompt.rs::tests::append_system_prompt_carries_claude_md_after_the_conductor_instructions |
| units.test.ts › helpers › tells the agent to attempt commands and ask on a denial, not refuse (ADR-0023) | crates/conductor-daemon/src/system_prompt.rs::tests::tells_the_agent_to_attempt_commands_and_ask_on_a_denial_not_refuse |

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
| ws-client.test.ts › ReconnectingWs (M2-T04) › sends the bearer header when enrolled and none in local mode | crates/conductor-daemon/src/ws_client.rs::tests::sends_the_bearer_header_when_enrolled_and_none_in_local_mode |
| ws-client.test.ts › ReconnectingWs (M2-T04) › close 4001 stops reconnecting and reports it once | crates/conductor-daemon/src/ws_client.rs::tests::close_4001_stops_reconnecting_and_reports_it_once |
| ws-client.test.ts › ReconnectingWs (M2-T04) › close 4003 is fatal too; 4005 says to re-run the install command | crates/conductor-daemon/src/ws_client.rs::tests::close_4003_is_fatal_too_4005_says_to_rerun_the_install_command |
| ws-client.test.ts › ReconnectingWs (M2-T04) › HTTP 401 and 403 at the upgrade are treated as unauthorized: no retries, exit 78 | crates/conductor-daemon/src/ws_client.rs::tests::http_401_and_403_at_the_upgrade_are_unauthorized_no_retries_exit_78 |
| ws-client.test.ts › ReconnectingWs (M2-T04) › any other code exits 1 | crates/conductor-daemon/src/ws_client.rs::tests::any_other_code_exits_1 |
| ws-client.test.ts › ReconnectingWs (M2-T04) › another refused upgrade, and an ordinary close, still reconnect | crates/conductor-daemon/src/ws_client.rs::tests::another_refused_upgrade_and_an_ordinary_close_still_reconnect |
| ws-client.test.ts › wake tick (M2-T18, ADR-0021 §5) › a 60 s jump during a 30 s backoff reconnects within one tick and resets the attempts | crates/conductor-daemon/src/ws_client.rs::tests::wake_a_60s_jump_during_a_30s_backoff_reconnects_within_one_tick_and_resets_attempts |
| ws-client.test.ts › wake tick (M2-T18, ADR-0021 §5) › a jump while connected drops the socket and opens a new one | crates/conductor-daemon/src/ws_client.rs::tests::wake_a_jump_while_connected_drops_the_socket_and_opens_a_new_one |
