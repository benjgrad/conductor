# MW · Native Windows daemon (ADR-0024)

> **Process (Ben, 2026-10-28):** built in one lead session, no implementer/QA agent fan-out, targeted tests locally; the Windows proof is the `daemon-windows` Actions job. Tasks land on the single branch `mw-windows-daemon` (T01–T04 were merged into it from their own branches).
>
> **Approved by Ben 2026-10-28** (plan approval), with his four decisions: native port (not WSL2), owner-only DACL verified on load, `taskkill /T /F` plus the orphan sweep, and `install.ps1` with a Scheduled Task in scope. Windows CI is a GitHub Actions `windows-latest` job.

**Goal** ([ADR-0024](../../adr/0024-native-windows-daemon.md)): the daemon runs as a native `win32` Node process on Ben's work laptop with the same safety guarantees as on macOS/Linux: tree kill, orphan sweep, a fail-closed edit guard and owner-only credentials. `irm https://conductor.gradyserver.com/install.ps1 | iex` installs, enrolls and starts it at logon.

> **2026-10-29 ([ADR-0026](../../adr/0026-rust-daemon.md)):** the daemon is being ported to Rust. MW-T09's remaining items, T10, T11b, T12 and T13 move to [MR](MR-rust-daemon.md); MW-T00..T08 and T11 stay done in TS and are the behaviour reference.

**Placement**: the MW lane is independent of M2r/M3/M2c. Groups A and B touch only daemon and shared files. Two cross-lane constraints:
- **MW-T09** (owns `main.ts`) starts after **M2-T18** merges.
- **MW-T10** extends M2-T18's `service` subcommand.

**Exit criteria**:
- Every task below is `done` and QA'd.
- `.github/workflows/daemon-windows.yml` is green on `main`: typecheck, daemon and shared vitest, and the fake-claude e2e on `windows-latest`.
- `scripts/ci.sh` is green on Linux and macOS, so POSIX behaviour is unchanged.
- No `skipIf(win32)` survives without a TD row.
- **Ben** installs on the work laptop with `install.ps1 -Service`, runs one real-claude ticket end to end, and sees an out-of-worktree edit blocked. `open_pr` pushes through Git Credential Manager (MW-T13).

**Not in MW**:
- the IIS runtime slot and deploy step (U-070; the spike's WIN-3..5);
- Job Objects (TD-189 payoff);
- WSL2 setup docs;
- code signing of the scripts or the tarball;
- an ARM64-specific build (the tarball is plain JS).

**Blocking unknowns**: none open. U-071 is resolved by ADR-0024. These are answered during MW:
- U-106 (hook shell on Windows): MW-T13. The guard is built to be shell-independent.
- U-107 (`lstat` on junctions): MW-T03 test.
- U-108 (Scheduled Task stop signal): MW-T10.

**Design refs for every task**:
- [ADR-0024](../../adr/0024-native-windows-daemon.md);
- [windows-spike.md](../../design/windows-spike.md) FR-2 (the N1–N13 table, with file:line on bb197a7; re-check the lines on current `main`);
- ADR-0010 (private repos, `open_pr`);
- ADR-0013 (credential, inventory);
- ADR-0021 (launcher).

## Tasks

| ID | Task | Depends on | Group | Migration | Status |
|---|---|---|---|---|---|
| MW-T00 | ADR-0024, this file, ROADMAP, design-doc touch-ups, tracking | — | — | — | done |
| MW-T01 | Windows CI workflow + portable test support (`fake-bin`), POSIX-only tests skipped with markers | T00 | A | — | done (PR #58, b790864) |
| MW-T02 | shared: `AbsolutePathSchema` accepts Windows drive paths | T00 | A | — | done (PR #58, b790864) |
| MW-T03 | platform: `spawn`, `kill-tree`, `shell`, `procinfo` (not wired in) | T00 | A | — | done (PR #58, b790864) |
| MW-T04 | platform: `acl` (owner-only DACL write + verify) | T00 | A | — | done (PR #58, b790864) |
| MW-T05 | Wire spawn + kill into the claude driver, process runner, capability probes, conditions | T01, T03, T04 | B | — | done (PR #58, b790864; win32 CI green) |
| MW-T06 | Orphan sweep on Windows (procinfo, `checkOurs`, sweep kill) | T01, T03 | B | — | done (PR #58, b790864; win32 CI green) |
| MW-T07 | Credential, config, private repos and git env on Windows | T01, T04 | B | — | done (PR #58, b790864; win32 CI green) |
| MW-T08 | Edit guard on Windows (command quoting, resolver), fail-closed path table | T01 | B | — | done (PR #58, b790864; win32 CI green) |
| MW-T09 | CLI, paths, sysinfo, rescan, long paths, transcript slug | T01, M2-T18 | B | — | moved → MR-T13 for the rest (ADR-0026; done in TS: 8.3 worktree reuse, repo scan, transcript slug; left: main.ts SIGBREAK + `rescan`, core.longpaths; win32 CPU done (platform/sysres.ts); after M2-T18) |
| MW-T10 | `service` on win32: Scheduled Task + `conductor-launch.ps1` | T05, T09, M2-T18 | C | — | moved → MR-T13 (ADR-0026) |
| MW-T11 | `install.ps1` + tarball `.cmd` shim + Windows tabs (Machines page, setup guide) + help docs | T07 | D | — | done (PR #61, 363b31e; split 2026-10-29, Ben asked for the Windows instructions before T10) |
| MW-T11b | install.ps1 starts the daemon at logon (`service install`, `conductor-launch.ps1` in the tarball) | T10, T11 | D | — | moved → MR-T13 (ADR-0026) |
| MW-T12 | E2E on Windows, remove the remaining skips, setup docs | T05–T11 | E | — | moved → MR-T16 (ADR-0026) |
| MW-T13 | Laptop smoke test (Ben, guided); answers U-106 | T12 | F | — | moved → MR-T18b (ADR-0026) |

Groups run in order A → F, and tasks within a group own disjoint files. Branch names are `mw-tNN-<slug>`. Every task is green on the Windows Actions job **and** `scripts/ci.sh` before merge.

Shared rules for every task:
- No `shell: true`, ever. Use `spawnCli`.
- New OS branching goes in `packages/daemon/src/platform/` only. Call sites don't test `process.platform`.
- Every win32 shortcut gets a TD row and a `// TD-###` comment.
- POSIX behaviour is byte-for-byte unchanged unless the task says otherwise.

## Task details

### MW-T01 · Windows CI + portable test support
- **Scope**:
  - Add `.github/workflows/daemon-windows.yml`. It runs on `push` to `mw-*` / `m*-t*` branches and on PRs to `main`, on `windows-latest`. Steps: Node 22 (`.nvmrc`), pnpm 10 (via `npm i -g pnpm@10`, never corepack), `git config --global core.longpaths true`, `pnpm i --frozen-lockfile`, `pnpm typecheck`, `pnpm vitest run --project daemon --project shared`. Use a matching `ubuntu-latest` job only if it is cheap; `ci.sh` stays the Linux gate.
  - Add `packages/daemon/src/test-support/fake-bin.ts`:
    - `writeFakeBin(dir, name, jsSource)`: on POSIX, a `#!/usr/bin/env node` file chmod 755; on win32, `name.mjs` plus `name.cmd` (`@node "%~dp0name.mjs" %*`);
    - `pathWith(...dirs)`, using `path.delimiter`.
  - Each test that can't pass on win32 today gets `describe.skipIf(process.platform === 'win32')` (or `it.skipIf`) with a `// MW-Tnn` marker naming the task that will unskip it. The job is green from the first push.
  - Out of scope: changing any `src/` behaviour.
- **Files owned**: `.github/**`, `packages/daemon/src/test-support/fake-bin.ts` (+ test), skip markers in `packages/daemon/**/*.test.ts`, the root `package.json` only if a script is needed.
- **Do not touch**: `docs/tracking/**`, `packages/daemon/src/**` outside `test-support/`.
- **Acceptance**:
  - [ ] The workflow runs green on the pushed branch on `windows-latest` (link the run).
  - [ ] `fake-bin` tests pass on both OSes: a fake with args containing spaces, `&`, `^`, `%` and `"` echoes them back exactly when run through `execFile` on POSIX, and through `cmd.exe /d /s /c` with escaping on win32.
  - [ ] Every skip has a `// MW-Tnn` marker. `grep -c` of the markers is listed in the report.
  - [ ] `scripts/ci.sh` green on Linux.

### MW-T02 · shared: Windows absolute paths
- **Scope**:
  - `AbsolutePathSchema` (`packages/shared/src/machines/inventory.ts`) accepts `/…` (as today) and `^[A-Za-z]:[\\/]`. It refuses UNC (`\\host\…`), `\\?\`, `\\.\`, relative paths, and anything containing a NUL byte.
  - Update the comment that cites U-071.
  - Grep the orchestrator and web for code that splits these fields on `/` (display, repo names, slugs) and fix it to handle `\`.
- **Files owned**: `packages/shared/src/machines/**` + tests; the orchestrator/web display sites found (list them in the report).
- **Acceptance**:
  - [ ] A table test of accepted and refused path forms.
  - [ ] An inventory, `start_session.working_copy` and a git_tamper `alert` with `C:\Users\b\repo` all round-trip through the WS schemas.
  - [ ] No orchestrator or web test regressions.

### MW-T03 · platform: spawn, kill-tree, shell, procinfo
- **Scope**: new modules in `packages/daemon/src/platform/`, per ADR-0024 §1. They are **not wired in** (T05/T06 do that).
  - `spawnCli(bin, args, opts)`, plus a sync `execFile`-like helper. Use the `cross-spawn` package, or vendor its PATHEXT resolution and cmd escaping (≤ 150 lines). Justify the choice in the report.
  - `killTree(pid, {graceMs, signal})`: POSIX group kill moved here as a function (copy, don't delete the originals yet); win32 `taskkill /T /F /PID`.
  - `workflowShell()`: returns `{file, args: (cmd) => string[]}`.
  - `readProcInfo(pid)`: POSIX logic copied from `orphan.ts`; win32 via `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<n>' | Select … | ConvertTo-Json"`, with the CommandLine parsed by Windows argv rules (`CommandLineToArgvW` semantics).
- **Files owned**: `packages/daemon/src/platform/{spawn,kill-tree,shell,procinfo,index}.ts` + tests; `packages/daemon/package.json` (the dep).
- **Acceptance**:
  - [ ] win32: a `.cmd` fake (via `fake-bin`, or the T01 helper copied if T01 isn't merged) gets metachar args intact. A bare name resolves through PATHEXT. A missing bin rejects with ENOENT.
  - [ ] win32: `killTree` kills a node child **and its grandchild** (assert both pids are gone).
  - [ ] Both OSes: `readProcInfo` returns the start time and argv for a spawned child, and null for a dead pid. CIM JSON fixtures cover quoted `C:\Program Files\…` argv.
  - [ ] win32: a test records whether `lstatSync(junction).isSymbolicLink()` is true. The result goes in the report and answers U-107.
  - [ ] `workflowShell()` finds Git Bash on the runner.

### MW-T04 · platform: acl
- **Scope**: `packages/daemon/src/platform/acl.ts`, per ADR-0024 §3:
  - `currentUserSid()`, cached;
  - `writePrivateFile(path, data)` (atomic: write tmp, set the DACL, rename);
  - `mkdirPrivate(path)`;
  - `assertOwnerOnly(path, {kind: 'file'|'dir'})`.
  On POSIX these wrap today's mode, lstat and uid logic, copied from `credential.ts`/`config.ts` without changing it.
- **Files owned**: `packages/daemon/src/platform/acl.ts` + test.
- **Acceptance**:
  - [ ] win32: a file written by `writePrivateFile` passes `assertOwnerOnly`. After `icacls <f> /grant *S-1-1-0:R` (Everyone) it is refused with a clear message. Re-enabled inheritance is refused. A file owned by another SID is refused (simulate with fixture JSON if the runner can't chown).
  - [ ] POSIX: existing behaviour pinned by tests, with the same messages as today.
  - [ ] The ACL reader parses `Get-Acl` JSON fixtures, so the parsing logic is unit-tested on Linux too.

### MW-T05 · Wire spawn + kill (N1, N3, N11)
- **Scope**:
  - `claude/cli-driver.ts`: spawn via `spawnCli`, kill via `killTree`, MCP config via `writePrivateFile`.
  - `commands/process-runner.ts`: `workflowShell()`, `killTree`, reaping.
  - `inventory/capabilities.ts`: `claude`/`az`/`gh` probes via `spawnCli`.
  - `actions/conditions.ts`.
  - `main.ts`'s `claude --version` probe: coordinate. If T09 owns `main.ts` at the time, leave the probe to T09 and say so.
  - Delete the copied group-kill code.
  - Unskip these files' tests.
- **Acceptance**:
  - [ ] win32: a session kill takes down claude (the fake, via `.cmd`) and a grandchild started by its fake Bash tool.
  - [ ] A workflow command `echo $FOO && exit 3` runs in Git Bash and reports exit 3.
  - [ ] The build semaphore is released after a kill.
  - [ ] The `az.cmd` fake is detected as present, **from a dir whose path contains a space and parentheses** (TD-193), e.g. `…\Program Files (x86)\wbin\az.cmd`.
  - [ ] TD-192: `spawnCli` throws `ERR_CMD_UNSAFE_ARG` when a `.cmd` payload exceeds 8191 chars.
  - [ ] U-111 decided before merge (lead): lookalike `"`/`\` refusal for `.exe` args, or a recorded no.
  - [ ] U-110 (native `claude.exe` only): with only a `claude.cmd` on PATH, `run` and the claude capability probe fail with a clear "install native Claude Code (claude.exe)" message. The test uses a fake `.cmd`.
  - [ ] On win32, `killTree` skips an already-exited ChildProcess (MW-T03), so process-runner's "reap the group after the shell exits" is a no-op there. Document this at the call site with TD-189.
  - [ ] POSIX tests unchanged and green.
  - [ ] TD-189 comment at the win32 `killTree` call sites.

### MW-T06 · Orphan sweep (N2)
- **Scope**:
  - `orphan.ts` uses `readProcInfo`. `checkOurs` accepts `node(.exe)? <…>/cli.js` and `claude(.exe)?` and compares paths case-insensitively on win32.
  - The `daemon.ts` sweep section checks liveness via `readProcInfo` (not `kill(pid, 0)` on win32) and kills via `killTree`.
  - `store.ts` only if its pid-record shape needs the start time format.
  - `daemon.kill.test.ts` runs the fake claude via `fake-bin`.
- **Acceptance**:
  - [ ] win32: after a simulated daemon crash, the next start kills a recorded `ours` claude and spares a recorded pid that now belongs to a different process (a reused pid).
  - [ ] Start-time comparison tolerates CIM's precision. Note from MW-T03 QA: `readProcInfo` truncates to whole ms and is stable across reads, but equality only holds if the **recorded** start time also comes from `readProcInfo` (right after spawn), not from `Date.now()`. A DST-ambiguous local time could be an hour off any other source.
  - [ ] Unskipped tests green on both OSes.

### MW-T07 · Credential, config, private repos, git env (N6, N7)
- **Scope**:
  - `credential.ts`, `config.ts` (also `CONDUCTOR_ROOTS` split on `path.delimiter`), `actions/checkout.ts` and `actions/open-pr.ts` use `acl.ts`.
  - In `open-pr.ts`'s `cleanEnv` on win32: no `GIT_CONFIG_NOSYSTEM`, and `core.hooksPath=NUL`. POSIX is unchanged.
- **Acceptance**:
  - [ ] win32: `enroll` then `loadCredential` round-trips. An added Everyone ACE makes the daemon refuse to start with the message.
  - [ ] A planted `pre-push` hook in the private repo does **not** run during `open_pr`'s push (both OSes).
  - [ ] On win32, `<root>` is created with `mkdirPrivate` before anything is written into it (MW-T04: `writePrivateFile` refuses a non-private parent, and `mkdirPrivate` refuses unless the nearest existing ancestor is owner-only, the profile dir or `%LOCALAPPDATA%`). A custom `--root` under a permissive dir (e.g. `C:\conductor`) fails with a clear message.
  - [ ] `CONDUCTOR_ROOTS=C:\a;D:\b` parses to two roots.
  - [ ] The MW-T01 skips (35 markers) are removed. Note from MW-T01: on the runner, checkClean/open_pr see ` M README.md` on fresh files, which looks like `core.autocrlf`. Pin `core.autocrlf=false` in the daemon's git env, or in the test repos only if the daemon really doesn't care, and justify the choice.
  - [ ] Unskipped tests green.

### MW-T08 · Edit guard (N4, N5; security)
- **Scope**: `claude/edit-guard.ts`, per ADR-0024 §6:
  - the hook command format, and refusing `"%!^` in paths;
  - the resolver: per-drive root, case-insensitive containment, refusing UNC, `\\?\`, `\\.\` and ADS, expanding 8.3 names via `realpathSync.native`, junctions treated as links (per U-107, or defensively if T03 hasn't answered it);
  - `~\` expansion.
- **Acceptance**:
  - [ ] A table test (≥ 25 rows) of path forms. Every out-of-worktree target is denied: other drive, UNC, `\\?\C:\…`, `C:\WT\x` vs `c:\wt\x` (allowed only when inside), `PROGRA~1`, `file.txt:stream`, a junction out of the worktree, `..\..`. In-worktree targets are allowed.
  - [ ] The generated hook command, run under both `cmd.exe /d /s /c` and Git Bash `-c`, gives exit 2 for a denied path and 0 for an allowed one. If `node` is missing it still exits non-zero **2**, fail-closed under both shells. If cmd can't produce 2, record it as a finding.
  - [ ] **QA must run a second, security-focused review of this branch.**

### MW-T09 · CLI, paths, sysinfo, rescan
- **Scope**:
  - `main.ts`: SIGBREAK, the `.claude` warning regex using `sep`, a `rescan` subcommand, and the claude probe via `spawnCli` (if not done by T05).
  - `inventory/report.ts`: win32 rescan via a `<root>/state/rescan` trigger file (poll ≤ 5 s, or `fs.watch` with a poll fallback). SIGHUP stays on POSIX.
  - `sysinfo.ts`: win32 CPU free from `os.cpus()` deltas.
  - `claude/transcript.ts`: the slug matches Claude's naming on Windows. Verify against Claude Code's behaviour and docs, and note the source.
  - `workspace.ts` / `inventory/git.ts`: `-c core.longpaths=true` on win32, and `git worktree list` parsing with `C:/` paths.
  - `inventory/repos.ts`.
- **Starts after M2-T18 merges.**
- **Acceptance**: unit tests per item on both OSes. A worktree at a > 260-char path is created and removed on the runner.

### MW-T10 · `service` on win32
- **Scope**: the win32 backend of M2-T18's `service install|uninstall|restart|status`:
  - `Register-ScheduledTask`: logon trigger, current user, `RunLevel Limited`, no visible console (`conhost.exe --headless` or a hidden PowerShell host; pick one and justify it), restart on failure.
  - `conductor-launch.ps1` (an asset in the tarball) implements ADR-0021's launcher contract: exit 75 → switch the `current` junction → relaunch; trial + rollback.
  - Record U-108's answer (does Stop-ScheduledTask give any graceful signal?) and TD-190.
- **Acceptance**:
  - [ ] On the runner: install registers the task; status reports it; restart restarts it; uninstall removes it.
  - [ ] The launcher's switch + rollback is tested with fake versions.
  - [ ] No admin required (the runner job runs the test un-elevated, or documents why it can't).

### MW-T11 · `install.ps1`
- **Split 2026-10-29**: Ben wanted the Windows install instructions before T10. T11 ships the installer without starting at logon, and T11b adds that once T10 has the `service` command. T11 also takes T12's help-doc item.
- **Scope**:
  - `packages/orchestrator/assets/install.ps1.tmpl`, served at `/install.ps1` (`distribution.ts`). `irm | iex` passes no arguments, so instead of `-Token` / `-Root` flags it reads `CONDUCTOR_ENROLL_TOKEN` (removed from the session at once) and `CONDUCTOR_ROOT`, like install.sh's environment forms. It checks node ≥ 22, git, Git Bash and the native `claude.exe` (U-110: only a `claude.cmd` → "install native Claude Code" hint), listing what's missing. It downloads the tarball over https, checks its SHA-256 (with .NET's SHA256: `Get-FileHash` doesn't autoload in a 5.1 window started from pwsh 7), unpacks with `tar.exe`, makes the `current` junction and `bin\conductor-daemon.cmd`, applies the root DACL, enrolls with the token in `CONDUCTOR_ENROLL_TOKEN` (never argv; TD-117), and adds `bin` to the user PATH.
  - `build-daemon-tarball.sh` adds the `.cmd` entry (`assets/conductor-daemon.cmd.tmpl`) and deploys with pnpm's hoisted linker, so the tarball has no symlinks (Windows `tar.exe` can't make them).
  - `EnrollmentTokenCreated.command_windows`; the Machines page's Add a machine and the setup guide get a Windows tab; the help page gets Windows sections.
- **Acceptance**:
  - [x] A PowerShell (5.1) test on the windows job against a fake tarball server: install, enroll (the recorded argv has no token), DACL verified, upgrade-in-place re-run (`test/install-ps1.test.ts`).
  - [x] A wrong SHA-256 aborts with nothing switched.
  - [x] Distribution route test for `/install.ps1`.

### MW-T11b · install.ps1 starts the daemon at logon
- **Scope**: once T10 has `service install` on win32, install.ps1 runs it when asked (an environment switch such as `CONDUCTOR_INSTALL_SERVICE=1`, since `irm | iex` takes no flags) and on an upgrade restarts a registered task; the tarball carries `conductor-launch.ps1`; Add a machine shows the "start at logon" variant.
- **Acceptance**: the T11 test also covers the service path on the windows job; no admin needed.

### MW-T12 · E2E on Windows + cleanup
- **Scope**:
  - `e2e/harness` uses `fake-bin` for claude and gh, `path.delimiter`, and taskkill-based teardown instead of `pgrep`.
  - A node e2e entry so win32 doesn't need `e2e/run.sh`.
  - The Actions job adds `Start-Service postgresql*` (preinstalled on the image; set `DATABASE_URL`) and `test:e2e`.
  - Remove every remaining `skipIf(win32)`; any survivor gets a TD row.
  - ~~Add a Windows section to the help docs~~: done in T11.
- **Acceptance**: the e2e is green on `windows-latest` and on Linux `ci.sh`, and `grep -r "skipIf(process.platform === 'win32')"` is empty or every hit is TD-tagged.

### MW-T13 · Laptop smoke (Ben, guided)
- **Scope**: Ben installs on the work laptop with `install.ps1 -Service`, logs out and back in (the daemon reconnects), and runs one real-claude ticket on a repo there. The lead guides and records the results.
- **Acceptance**:
  - [ ] The ticket reaches a PR, pushed through Git Credential Manager.
  - [ ] Asking the agent to edit a file outside its worktree is blocked. This answers U-106: which shell runs hooks.
  - [ ] The Machines page shows `win32` and the repos.
  - [ ] Results are recorded against U-106 and U-071.
