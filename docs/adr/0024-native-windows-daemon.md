# ADR-0024 · The daemon runs natively on Windows

- **Status**: accepted (Ben approved the MW plan, 2026-10-28)
- **Date**: 2026-10-28
- **Deciders**: Ben (+ Claude lead session, 2026-10-28)
- **Resolves**: [U-071](../tracking/UNKNOWNS.md) (daemon on Windows). Leaves [U-070](../tracking/UNKNOWNS.md) (IIS fixed-path runtime) open.
- **Amends**:
  - [ADR-0010](0010-one-workflow-columns-are-states.md): private dirs (and ADR-0013's `machine.json` credential) on Windows. An owner-only DACL replaces mode bits and the uid check.
  - [ADR-0021](0021-daemon-auto-update.md): on Windows the launcher is PowerShell, `current` is a junction, and the service is a Scheduled Task.
- **Supersedes**: the "WSL2 first, native parked" recommendation of [the Windows spike](../design/windows-spike.md) (FR-4). Its FR-2 table stays the inventory of work.

## Context
Ben's work laptop runs Windows. The spike recommended running the daemon inside WSL2 and parking a native port (N1–N13, about 15–25 engineer-days). Ben chose the native port (2026-10-28).

Re-checking the current tree found more breaks than the spike listed:
- `AbsolutePathSchema` (`shared/src/machines/inventory.ts`) accepts only `/`-rooted paths.
- `CONDUCTOR_ROOTS` is split on `:`.
- The orphan check doesn't recognise `node.exe` or `claude.exe`.
- `GIT_CONFIG_NOSYSTEM` drops Git for Windows' credential helper.
- `az.cmd` isn't found.
- `loadavg()` is always zero on Windows.
- SIGHUP doesn't exist on Windows.

## Decision
**The daemon supports native Windows (`win32`) next to macOS and Linux, with the same safety guarantees. All OS branching lives in one module, `packages/daemon/src/platform/`.** Call sites stay OS-agnostic. Milestone [MW](../plan/milestones/MW-windows-daemon.md) delivers it.

### 1 · Platform seam
| Module | POSIX (unchanged behaviour) | win32 |
|---|---|---|
| `spawn.ts` `spawnCli` | `spawn(bin, args, {detached})` | Resolve `bin` via PATH/PATHEXT. Spawn an `.exe` directly. Run a `.cmd`/`.bat` (npm `claude.cmd`, `az.cmd`) through `cmd.exe /d /s /c` with cross-spawn-style escaping. Always `windowsHide: true`, never `detached`, never `shell: true` |
| `kill-tree.ts` `killTree` | Signal the process group: SIGTERM, then SIGKILL after the grace period | `taskkill /T /F /PID <pid>`: forceful, with no grace step |
| `shell.ts` `workflowShell` | `/bin/sh` | Git Bash `bash.exe`, from `CONDUCTOR_SHELL`, then `CLAUDE_CODE_GIT_BASH_PATH`, then relative to `git --exec-path`, then Program Files |
| `acl.ts` | 0600 / 0700, `lstat` and uid checks | Owner-only DACL (§3) |
| `procinfo.ts` `readProcInfo` | `ps -ww -o lstart= -o command=` | `Get-CimInstance Win32_Process`: CreationDate, ExecutablePath, CommandLine (parsed with Windows argv rules) |

### 2 · Tree kill: `taskkill /T /F`, with the orphan sweep as backstop (Ben)
Windows has no process groups and no signals. `taskkill /T` walks the parent-pid tree, so it misses a grandchild whose parent has already exited. The orphan sweep (BUG-1b) on the next start catches daemon-owned `claude` processes. A reparented build or dev-server process can still survive. That gap is a recorded shortcut (TD-187).

Job Objects (`KILL_ON_JOB_CLOSE`) would close it, but they need native code in the tarball. That is the payoff path if the gap bites.

### 3 · Private files: an explicit owner-only DACL, verified on load (Ben)
Writing a private file or dir runs `icacls <p> /inheritance:r /grant:r *<user SID>:F *S-1-5-18:F *S-1-5-32-544:F`. That grants the current user, SYSTEM and Administrators only, with no inherited ACEs.

Loading the credential or a private dir reads the owner and the ACEs (`Get-Acl`) and refuses if:
- the owner is not the user;
- any ACE grants another SID; or
- inheritance is on.

This is the Windows equivalent of ADR-0010's `mode & 0o077` and uid checks. The checks never silently pass on Windows: `process.getuid` being undefined is not "same owner". The current user's SID comes from `whoami /user /fo csv`.

### 4 · Workflow commands run in Git Bash
Workflow JSON commands stay POSIX `sh`, so one workflow runs on every OS. Claude Code on Windows already requires Git for Windows and uses its Bash, so the daemon adds no new dependency. `cmd.exe` would change every workflow's quoting, so it is not used.

### 5 · Git on Windows
- Every daemon git call adds `-c core.longpaths=true`. Worktree paths under `%USERPROFILE%\.conductor\wt\<uuid>` exceed MAX_PATH easily.
- `core.hooksPath` is `NUL` on win32. Tests prove that a planted hook does not run.
- `cleanEnv` does **not** set `GIT_CONFIG_NOSYSTEM` on win32. The system gitconfig lives under Program Files, where only admins can write. It carries `credential.helper=manager`, `http.sslBackend=schannel` and corporate CAs, and `open_pr` can't push without them. On POSIX, `GIT_CONFIG_NOSYSTEM` stays.

### 6 · Edit-guard hook
- The hook command is `"<node>" "<guard.mjs>" "<worktree>" || exit 2`, with double quotes and forward-slash paths. It means the same under `cmd.exe` and Git Bash.
- A worktree root or guard path containing `"`, `%`, `!` or `^` is refused at session start.
- Which shell Claude Code uses for hooks on Windows is U-104. The command is built so the answer doesn't change the guard's behaviour.
- The resolver:
  - roots at `path.parse(p).root`;
  - compares case-insensitively on win32;
  - refuses UNC, `\\?\`, `\\.\` and alternate data streams;
  - expands 8.3 short names with `realpathSync.native`.
- It stays fail-closed: a target it can't classify is denied.

### 7 · Service, launcher, installer
- **Install:** `install.ps1` (`irm <url>/install.ps1 | iex`) does what `install.sh` does:
  - it unpacks into `<root>\daemon\<version>`, makes `current` a **junction**, and adds `<root>\bin\conductor-daemon.cmd`;
  - it applies §3's DACL to `<root>`;
  - it passes the enrollment token in the environment (TD-117 parity).
- **Service:** `service install` registers a user-level **Scheduled Task at logon**. It needs no admin and shows no visible console.
- **Launcher:** `conductor-launch.ps1` implements ADR-0021's launcher on Windows: on exit 75 it switches the junction and relaunches, with trial and rollback.
- **Stopping:** a Scheduled Task stop terminates the process without a signal (U-106), so a stop is ungraceful (TD-188). Live sessions go to `machine.lost` on the orchestrator, and the next start's orphan sweep reaps what is left. `SIGINT` and `SIGBREAK` are handled when it runs in a console.

### 8 · Smaller changes
- `AbsolutePathSchema` accepts `^[A-Za-z]:[\\/]` and still refuses UNC, `\\?\` and relative paths.
- `CONDUCTOR_ROOTS` splits on `path.delimiter`.
- On win32, `conductor-daemon rescan` writes `<root>/state/rescan` for the running daemon to pick up, since there is no SIGHUP.
- On win32, free CPU comes from `os.cpus()` time deltas.

### 9 · Requirements and CI
- **Supported:** Windows 10 1809+ or Windows 11, Node ≥ 22, Git for Windows ≥ 2.40 (Git Bash), and `claude` (native `claude.exe` or npm `claude.cmd`).
- **CI:** a GitHub Actions `windows-latest` job (`.github/workflows/daemon-windows.yml`) runs typecheck and the daemon and shared test projects on every pushed task branch. After MW-T12 it also runs the fake-claude e2e. This is the repo's first hosted CI (Ben, 2026-10-28). Linux and macOS keep `scripts/ci.sh`.

## Consequences
- Every change to `platform/`, the edit guard or the credential code needs the Windows job green as well as `ci.sh`.
- The edit guard and ADR-0010 checks now have two implementations. QA reviews both on every change.
- TD-187 (tree kill gap) and TD-188 (ungraceful stop) are accepted shortcuts.
- IIS (U-070) is not solved here. The spike's WIN-3..5 runtime slot comes later and works the same on native Windows.

## Alternatives considered
- **WSL2 first** (the spike's recommendation). It needs no code, but depends on corporate policy, keep-alive tasks and logins inside the VM, and can't run Windows-only builds well. Ben chose native.
- **Trust `%LOCALAPPDATA%` and skip the checks on Windows.** Simpler, but it silently weakens ADR-0010. Rejected.
- **Job Objects for tree kill.** Robust, but needs native code (an addon or helper exe) plus a build toolchain and signing. Deferred to TD-187's payoff.
- **`cmd.exe` for workflow commands.** It would fork every workflow's quoting by OS. Rejected.
