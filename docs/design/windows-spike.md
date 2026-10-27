# Spike · A conductor machine on Windows (WSL2 vs native) and IIS

Status: **spike report (SPIKE-1), not yet a decision.** It answers U-071 (the daemon on Windows) and U-070 (fixed-path runtimes such as IIS) far enough to plan the work. Nothing here has been run on Windows: every claim is either _from the code_ (with `file:line` on `main` at bb197a7) or _from the docs_ (with a link). Claims marked **verify** need the work laptop. Once Ben agrees, the decision itself goes into an ADR.

## TL;DR

1. **Run the daemon inside WSL2 (Ubuntu) first.** The daemon is Linux there, so process groups, `ps -o lstart`, file modes, symlinks, `/bin/sh` and the edit guard all behave as on Linux. **No daemon code changes are needed**, as long as `--root` and the repos sit on the Linux filesystem (not `/mnt/c`). The gaps are setup (systemd, keeping WSL alive, logins inside WSL) and one real risk: a **Windows-only build** (.NET Framework / msbuild) can't run in WSL.
2. **IIS:** don't point IIS at the worktree. **Deploy the session's build output into the fixed IIS directory as a test step**, under a per-machine **exclusive runtime slot** (a daemon-local semaphore of size 1, like the build semaphore). Use `app_offline.htm` and recycle the app pool, then run the e2e tests against `http://localhost`.
3. **Native Windows is a port, not a fix:** 13 work items (2 L, 1 M–L, 6 M, 4 S), roughly 3–4 weeks of tickets, the riskiest being process-tree kill and the security checks (owner/mode checks silently no-op or always fail on NTFS). Do it only if WSL2 is blocked on the laptop or the app's build needs Windows tooling that can't be called from WSL.
4. Staged plan: WIN-1…WIN-5 (about 1.5–2 weeks) get the laptop working on WSL2 with IIS e2e. WIN-N1…N8 is the native epic, kept parked.
5. The recommendation hinges on **Q1 (is WSL2 allowed on the laptop?)** and **Q2 (what does the app's build need?)**. See [Open questions](#open-questions-for-ben).

## Context

- **U-071:** everything so far is tested on macOS (and Linux in CI). The daemon assumes POSIX in several places: process groups, signals, `ps`, file modes and owner checks, `/bin/sh`, and symlink semantics. The installer (`packages/orchestrator/assets/install.sh.tmpl`) is POSIX `sh` and the service unit targets launchd/systemd (M2-T18, not yet built).
- **U-070:** the work app is served by IIS from one fixed physical directory. A session works in `<root>/wt/<session_id>` (`packages/daemon/src/workspace.ts:20`), so its build can't be e2e-tested where IIS looks without an extra step. Only one session at a time can own the site.
- **Assumptions:** Windows 11 (22H2 or newer, needed for WSL mirrored networking), a corporate-managed laptop, admin rights unknown, IIS installed with an existing site and app pool, and the app repo on github.com (or reachable from the laptop).
- Size scale used below: **S** ≤ 1 day (≈ < 150 lines incl. tests), **M** 1–3 days, **L** 3–5+ days or needs a design decision first.

## FR-1 · WSL2: does the daemon run unchanged?

**Verdict: yes for the daemon code, with setup conditions.** Inside WSL2, `process.platform` is `linux` and the kernel is a real Linux kernel ([WSL overview](https://learn.microsoft.com/windows/wsl/about)), so every POSIX path in the daemon takes its Linux branch.

| Component                                    | Unchanged? | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process groups and kill                      | yes        | `detached: true` + `process.kill(-pid, sig)` (`claude/cli-driver.ts:272-277,359`; `commands/process-runner.ts:68-71,85`; `daemon.ts:1252-1258`). Linux semantics: the child leads a new process group and session ([Node `options.detached`](https://nodejs.org/api/child_process.html#optionsdetached)).                                                                                                                                                                                                                                                                                                       |
| Orphan sweep (BUG-1b)                        | yes        | `ps -ww -o lstart= -o command= -p <pid>` with `LC_ALL=C TZ=UTC` (`orphan.ts:47-51`). Ubuntu ships procps `ps`, which supports these flags; `-ww` is there for exactly this Linux case (`orphan.ts:43`).                                                                                                                                                                                                                                                                                                                                                                                                        |
| File modes, lstat/owner checks (ADR-0010)    | yes, on ext4 | `config.ts:175-180`, `credential.ts:58-60,104-105,128-133`, `actions/open-pr.ts:308-324`, `actions/checkout.ts:107-110`, `claude/cli-driver.ts:58-63`. On ext4 they work as on Linux. **On `/mnt/c` (drvfs) they break:** without the `metadata` mount option chmod is a no-op and files show fixed modes ([WSL file permissions](https://learn.microsoft.com/windows/wsl/file-permissions)), so `credential.ts:104` (`mode & 0o077`) would refuse the credential. Rule: `--root` must be on the Linux filesystem (the default `~/.conductor` is, `install.sh.tmpl:44`). |
| Edit-guard hook                              | yes        | POSIX-quoted command run by the shell Claude Code uses on Linux (`claude/edit-guard.ts:73,94`); the resolver walks `/`-rooted paths (`:30-31`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Worktrees, symlinks, repo scan               | yes        | `git worktree add <root>/wt/<id>` (`workspace.ts:20`), lstat checks (`workspace.ts:263-267`, `inventory/repos.ts:39,89`). The scan roots must be Linux paths (repos cloned into WSL, not `/mnt/c/...`).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/bin/sh` commands, `core.hooksPath=/dev/null` | yes      | `commands/process-runner.ts:36`, `actions/open-pr.ts:187`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `claude`, `gh`, `git`                         | yes, installed **in WSL** | Claude Code supports WSL 1 and 2 ([setup](https://docs.anthropic.com/en/docs/claude-code/setup)); gh has Debian/Ubuntu packages ([gh Linux install](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)). They are separate from any Windows installs: Ben logs in to Claude and runs `gh auth login` **inside WSL** once.                                                                                                                                                                                                                                                      |
| Installer `install.sh`                        | yes        | POSIX sh with curl/wget, sha256sum and tar (`install.sh.tmpl:80-107`). The tarball is platform-independent JS run on the system Node (`packages/orchestrator/src/distribution.ts:10,29`), so Ben needs Node ≥ 22 inside WSL (`install.sh.tmpl:84-94`). `mv -T` exists in GNU coreutils (`:145`).                                                                                                                                                                                                                                                                                                                |
| Memory reporting                             | yes, as the VM sees it | `sysinfo.ts:34` takes the non-darwin branch. The figure is the WSL VM's, capped by `.wslconfig` `memory=` (default 50% of host RAM) ([wsl-config](https://learn.microsoft.com/windows/wsl/wsl-config#wslconfig)). Reservations (07) are then against the VM, which is the right number.                                                                                                                                                                                                                                                                                                 |
| Machine OS in inventory                      | reports `linux` | `commands/enroll.ts:153`, `daemon.ts:290` send `os.platform()`. The board can't tell WSL from Linux. That's harmless, but routing an IIS ticket needs a capability, not an OS (see FR-3).                                                                                                                                                                                                                                                                                                                                                                                                                  |

### What breaks or needs setup in WSL2

1. **`--service` needs systemd.** The service step (`install.sh.tmpl:170-172`, `daemon service install`, M2-T18) targets `systemd --user`. WSL supports systemd via `[boot] systemd=true` in `/etc/wsl.conf`, the default for Ubuntu installed by `wsl --install` ([systemd in WSL](https://learn.microsoft.com/windows/wsl/systemd)). Older distros need the line added and `wsl --shutdown`. `systemd --user` units only start at boot without a login if lingering is on (`loginctl enable-linger`). **Verify** on the laptop. Size S (docs plus an installer hint).
2. **WSL stops when idle, which kills the daemon.** WSL shuts a distro down after its last process/terminal goes away and the VM after `vmIdleTimeout` ([wsl-config](https://learn.microsoft.com/windows/wsl/wsl-config#main-wsl-settings)). Whether a systemd service alone keeps the distro up has varied across WSL versions: **verify**. The robust fix is a Windows Scheduled Task at logon that runs `wsl.exe -d Ubuntu --exec /bin/sh -c "sleep infinity"` hidden. Without it, the machine disconnects and live sessions go to `machine.lost`. Size S.
3. **Windows sleep and lid close** suspend the VM like any laptop. That's normal machine loss (08-failure-modes), not WSL-specific.
4. **Filesystem placement.** Repos, `--root` and worktrees must be on ext4: drvfs (`/mnt/c`) breaks the mode checks above, and cross-OS file access is much slower ([working across file systems](https://learn.microsoft.com/windows/wsl/filesystems)).
5. **A Windows-only build can't run in WSL.** If the app needs .NET Framework / msbuild / Windows SDKs, the agent's build and test commands have to call Windows binaries (`msbuild.exe`, `dotnet.exe`) through WSL interop ([WSL interop](https://learn.microsoft.com/windows/wsl/filesystems#run-windows-tools-from-linux)). From a `\\wsl.localhost\...` working directory this is slow, and `cmd.exe` refuses UNC working directories ("UNC paths are not supported", falls back to `C:\Windows`). That makes `.cmd`-based build scripts fragile. **This is the biggest WSL risk**: see Q2. A .NET (Core / 5+) app is fine: the Linux `dotnet` SDK builds and publishes it in WSL ([dotnet on Ubuntu](https://learn.microsoft.com/dotnet/core/install/linux-ubuntu)).
6. **Corporate policy.** WSL2 needs the Virtual Machine Platform feature; some managed laptops block it or require IT. See Q1.

No `file:line` in the daemon breaks in WSL2 as long as the placement rule (item 4) holds.

## FR-2 · Native Windows: each POSIX assumption

Node facts used below:

- `detached: true` on Windows gives the child its own console and lets it outlive the parent. It does **not** create a process group ([Node `options.detached`](https://nodejs.org/api/child_process.html#optionsdetached)).
- On Windows there are no POSIX signals: `subprocess.kill()` / `process.kill()` with SIGTERM, SIGINT, SIGKILL or SIGQUIT terminate the process forcefully, and other signals throw ([`subprocess.kill`](https://nodejs.org/api/child_process.html#subprocesskillsignal), [signal events](https://nodejs.org/api/process.html#signal-events)). Only that one pid is terminated, not its children. _From the code (libuv `uv_kill` on Windows opens one process handle):_ a negative pid (a group) is not supported.
- `fs.chmod` on Windows can only change the write bit; owner/group/other are not distinguished ([`fs.chmod`](https://nodejs.org/api/fs.html#file-modes)). `process.getuid` is POSIX-only (undefined on Windows) ([`process.getuid`](https://nodejs.org/api/process.html#processgetuid)).
- Since the April 2024 security releases (CVE-2024-27980), `spawn` of a `.bat`/`.cmd` without `shell: true` fails with `EINVAL` ([Node security release, April 2024](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)). npm-installed CLIs are `.cmd` shims on Windows.
- `fs.symlink` on Windows creates `file`/`dir` symlinks (needs Developer Mode or `SeCreateSymbolicLinkPrivilege`) or `junction`s ([`fs.symlink`](https://nodejs.org/api/fs.html#fssymlinktarget-path-type-callback), [Windows symlinks](https://learn.microsoft.com/windows/security/threat-protection/security-policy-settings/create-symbolic-links)). _From libuv:_ `lstat` reports junctions (mount-point reparse points) as symbolic links too. **Verify** with a test, since the edit guard and the "never follow a symlink" checks rely on it.
- Claude Code on native Windows needs Git for Windows and runs its Bash tool through Git Bash (`CLAUDE_CODE_GIT_BASH_PATH` if it isn't found) ([setup: Windows](https://docs.anthropic.com/en/docs/claude-code/setup#windows-setup)). **Verify** whether hook `command` strings also run through Git Bash ([hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)).

| # | Assumption | Where (`packages/daemon/src/…`) | What happens on Windows | Windows equivalent | Size |
| --- | --- | --- | --- | --- | --- |
| N1 | Kill the whole process tree | `claude/cli-driver.ts:272-277` (spawn detached), `:355-367` (`kill(-pid)` then fallback `child.kill`); `commands/process-runner.ts:68-71,82-89,129-133` (group kill, reap after the shell exits) | `kill(-pid)` throws, the fallback kills only `claude.exe`/the shell; Bash tools, test runners and dev servers survive as orphans and escape the build semaphore | Run each child in a **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ([Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects)). Node has no API: a tiny helper exe or a native addon. Cheaper interim: `taskkill /T /F /PID <pid>` ([taskkill](https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill)), which misses children whose parent already exited. No graceful SIGTERM step: there's no grace period, so `killGraceMs` becomes moot. Also `detached: true` would open a console window per agent: use `windowsHide: true` | L |
| N2 | Orphan sweep (BUG-1b) | `orphan.ts:44-56` (`ps -o lstart,command`), `:17-37` (lstart parsing), `daemon.ts:1243-1273` (`kill(pid,0)` liveness, group SIGTERM/SIGKILL), `store.ts:56` | `ps` doesn't exist → `readProcInfo` returns null → every orphan is "not ours" and survives | `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` → `CreationDate` + `CommandLine` ([Win32_Process](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-process)), via `powershell.exe -NoProfile`; adapt `checkOurs` to `claude.exe` / `node.exe …\cli.js` argv shapes; kill via N1. Pids are reused fast on Windows, so the start-time check stays essential | M |
| N3 | `/bin/sh -c <cmd>` for workflow commands | `commands/process-runner.ts:20,36,68` | `ENOENT`; every build/test/lint step fails | Run through Git Bash (`bash.exe -c`, already required by Claude Code), so workflow JSON commands stay POSIX and portable. `cmd.exe /d /s /c` would change every workflow's quoting. Locate bash like Claude does | M |
| N4 | Edit-guard hook command | `claude/edit-guard.ts:73,94` (`shellQuote` single quotes, `\|\| exit 2`) | Depends on which shell Claude runs hooks with (**verify**). Under Git Bash, single-quoted `C:\…` paths survive. Under `cmd.exe`, `'…'` is not quoting and `exit 2` semantics differ: the guard either fails open or blocks every edit | Quote for the shell actually used; prefer forward-slash paths (`C:/Users/...`) in the command. A test in Windows CI must prove an out-of-worktree edit is blocked (fail-closed) | M |
| N5 | Edit-guard path resolver | `claude/edit-guard.ts:28-48` (`resolve('/')`, split on `sep`, `..` handling), `:60-61` (`~/`), `:62-66` (relative containment) | `resolve('/')` is `C:\`, so a target on `D:\` or a UNC path is walked from the wrong root; case-insensitive NTFS means `C:\WT\x` vs `c:\wt\x` compare unequal (false denials) or, worse, mixed forms slip through; 8.3 short names (`PROGRA~1`), `\\?\` prefixes, ADS (`file.txt:stream`) and junctions all need handling | Root at `path.parse(p).root`; compare case-insensitively on win32; refuse `\\?\`, `\\.\`, `:` after the drive and UNC targets; resolve junctions via the N-lstat behaviour; security-sensitive, so a QA-reviewed table test of path forms | M–L |
| N6 | Owner checks (ADR-0010 private dirs, credential) | `credential.ts:58-60,63-76`; `actions/open-pr.ts:311-317`; `actions/checkout.ts:107-110` | `process.getuid` is undefined, so `foreign()` returns false: **the owner check silently passes** for any owner | Check the owner SID and that the DACL grants only the user (and SYSTEM/Administrators) via `icacls` / PowerShell `Get-Acl` ([icacls](https://learn.microsoft.com/windows-server/administration/windows-commands/icacls)), or rely on `%LOCALAPPDATA%` being per-user and document that (an ADR-0010 amendment). Needs Ben/lead decision | M |
| N7 | Mode bits 0600/0700 | `credential.ts:104-105` (`mode & 0o077` → refuse), `:128-133`; `config.ts:175-180`; `claude/cli-driver.ts:58-63`; `claude/edit-guard.ts:110-115`; `actions/open-pr.ts:310,321-323` | chmod is a no-op except the write bit; a fresh file stats as `0o666`, so **`loadCredential` always throws "readable by other users"**: an enrolled native daemon can't start | Skip the mode check on win32 and set an explicit DACL at write time (`icacls <path> /inheritance:r /grant:r %USERNAME%:F`), same mechanism as N6 | M |
| N8 | Symlink semantics | `workspace.ts:249-267`, `inventory/repos.ts:39,58,89`, `inventory/capabilities.ts:180`, `claude/transcript.ts:30-45` | Mostly fine if lstat treats junctions as links (**verify**). `claudeProjectSlug` (`transcript.ts:32`) maps `C:\Users\…` to `C--Users-…`; check it matches Claude's own naming on Windows, or transcript lookup (ADR-0008) breaks | Tests on a Windows runner; adjust the slug if Claude differs | S |
| N9 | `core.hooksPath=/dev/null` | `actions/open-pr.ts:187` (used by open_pr, checkout, inventory git reads) | _From Git for Windows' source:_ `/dev/null` is mapped to `NUL`, and no hook file can exist under it, so hooks stay off. **Verify** with a pre-push hook in a test repo | Keep, or use `NUL` on win32 | S |
| N10 | Long worktree paths | `workspace.ts:20` (`<root>/wt/<uuid>`) | `%USERPROFILE%\.conductor\wt\<36-char uuid>\` plus `node_modules` depth exceeds MAX_PATH (260) easily | `git config --system core.longpaths true` ([Git for Windows FAQ](https://github.com/git-for-windows/git/wiki/FAQ)), the `LongPathsEnabled` registry setting ([MAX_PATH](https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation)), a short root such as `C:\cd` | S |
| N11 | Spawning `claude` / `gh` / `git` | `claude/cli-driver.ts:272` (`spawn(bin, …)`), `actions/conditions.ts:112`, `inventory/capabilities.ts:47-61`, `inventory/git.ts:27` | `claude` from npm is `claude.cmd` → `EINVAL` (CVE-2024-27980) without a shell. The native Claude installer gives `claude.exe`, which spawns fine; `gh.exe`/`git.exe` are fine. Signals: `child.kill('SIGKILL')` works (forceful) | Resolve to the `.exe` (require the native Claude install), never `shell: true` (argv quoting risk). The SIGTERM/SIGINT handlers in `main.ts:71-72` only see Ctrl+C under a console; a Windows service needs its own stop hook | S |
| N12 | Installer and service | `packages/orchestrator/assets/install.sh.tmpl` (all of it: `#!/bin/sh`, `ln -s` `:144,147`, `mv -T` `:145`, `chmod 700` `:133`), M2-T18 service units | Doesn't run in PowerShell | A new `install.ps1` (`irm …/install.ps1 \| iex`, the pattern Claude Code's installer uses), a `current` junction instead of a symlink, a `.cmd` shim in `bin`, a Scheduled Task at logon (no admin) instead of launchd/systemd, ACLs from N7 | L |
| N13 | Tests and CI | e.g. `daemon.test.ts:52` (`mkdir -p`), `:160` and `:1288` (`/bin/sh` fakes), `actions/conditions.ts:76` (fake `gh` is a `/bin/sh` script) | The daemon test suite can't run on Windows as is, so none of N1–N12 can be proven | A `windows-latest` CI job for `packages/daemon`, fakes written as `.mjs` run by `node` | M |

**Total for native:** 2 L + 1 M–L + 6 M + 4 S ≈ 15–25 engineer-days, plus an ADR-0010 amendment (N6/N7) and a Windows CI job to keep it working. Windows CI also has a running cost that macOS/Linux-only development doesn't.

## FR-3 · IIS (U-070): serving a session's build

### Options

| Option | How | Verdict |
| --- | --- | --- |
| A. Repoint the site at the worktree | `appcmd set vdir "<Site>/" -physicalPath:<worktree build dir>` ([appcmd](https://learn.microsoft.com/iis/get-started/getting-started-with-iis/getting-started-with-appcmdexe)) or a junction at the fixed path, flipped back afterwards | **No, for WSL.** The worktree would be `\\wsl.localhost\Ubuntu\home\…`. IIS treats it as a UNC share: it needs "connect as" credentials or the app pool identity to have access ([IIS UNC content](https://learn.microsoft.com/iis/manage/configuring-security/application-pool-identities#accessing-the-network)), and _inferred:_ the WSL Plan 9 file server runs in the logged-in user's session, so a service identity (`IIS AppPool\…`) most likely can't see it at all. It's also slow, file-change notifications are unreliable, and the site breaks whenever WSL stops. For native it works, but needs admin, rewrites `applicationHost.config` (a crash leaves the site pointing at a deleted worktree), and the source tree is usually not the publish layout. |
| B. **Deploy into the fixed directory (recommended)** | A test step: build/publish in the worktree, then copy the output into the IIS directory and recycle, then run e2e | **Yes.** It's the same in WSL and native, keeps IIS config untouched, and matches how the app is really deployed. |
| C. A second IIS site per session | One site per session on its own port | Out of scope: admin rights, port/binding management, and the app may assume its fixed path or host name. |

### Recommended deploy step (option B)

A repo-configured command, run by the session as an ordinary workflow command (so it goes through the build semaphore and the runtime slot below):

1. Build and publish inside the worktree (`dotnet publish -c Release -o <wt>/.publish`, or whatever Q2 says).
2. Take the site offline: write `app_offline.htm` into the IIS directory, so the ASP.NET Core Module stops the app and releases its DLL locks ([app_offline.htm](https://learn.microsoft.com/aspnet/core/host-and-deploy/iis/app-offline)). (For ASP.NET Framework: stop the app pool, `appcmd stop apppool /apppool.name:<pool>`, which needs admin; see Q3.)
3. Copy with `robocopy <publish> <iis dir> /MIR /XF app_offline.htm` ([robocopy](https://learn.microsoft.com/windows-server/administration/windows-commands/robocopy)). From WSL, either run `robocopy.exe` via interop with a Windows-side source (`wslpath -w` gives `\\wsl.localhost\…`; robocopy accepts UNC sources) or `rsync -a --delete <publish>/ /mnt/c/inetpub/<site>/` (drvfs). The copy is done **by the logged-in user**, so IIS reads ordinary NTFS files; no UNC access by IIS.
4. Remove `app_offline.htm` (and recycle the app pool if needed). Wait until `http://localhost/<health>` answers.
5. Run the e2e suite against the site.
   - From native Windows: `http://localhost`.
   - From WSL: in the default NAT mode, Windows `localhost` is **not** WSL's `localhost`; use **mirrored networking** (`networkingMode=mirrored` in `.wslconfig`, Windows 11 22H2+), which makes `localhost` reach Windows services ([WSL networking](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking)). Fallback: the host IP from `ip route` plus a firewall rule.
6. Optional restore: put back what was there before (a snapshot copy taken in step 2). See Q4.

Steps 2–4 need write access to the IIS directory for Ben's user (a one-time ACL grant), not admin, as long as recycling isn't needed.

### The exclusive runtime slot

Only one session can own the site at a time, or two sessions overwrite each other's deploy mid-test.

- **Rule:** one **runtime slot per (machine, runtime)**, where a runtime is a named fixed-path target that a repo declares (e.g. `iis:WorkApp` → `C:\inetpub\workapp`). Capacity 1. A command that declares the runtime (the deploy + e2e command) must hold the slot for its **whole duration**: deploy and e2e are one command, so the site can't change between them.
- **Where it lives:** in the daemon, as a second semaphore beside the build semaphore (`commands/process-runner.ts`, 07 · Build semaphore), keyed by runtime name. Acquire order: runtime slot first, then a build slot, so a waiting deploy doesn't hold a build slot. Release on command exit, timeout or kill, which the runner already guarantees. A daemon crash releases it implicitly: no lease or orchestrator lock is needed, since only one machine has the site.
- **Visibility:** a `runtime_slot` session event `{waiting, runtime}` and a `waiting_for_runtime_slot` card badge, the same pattern as `build_slot` (`03-protocols.md`, `02-data-model.md` `waiting_for_build_slot`).
- **Routing:** the repo's runtime appears in the machine inventory, so a ticket that needs `iis:WorkApp` only routes to the laptop. Note: U-070 says the per-repo `runtime` field is "in ADR-0013", but **ADR-0013 has no runtime field today**. It needs an amendment (or a new ADR).
- **The human's own use of IIS:** Ben's manual deploys collide with the slot just like a session's. Decide whether the daemon refuses while a "manual hold" file exists (Q4).

## FR-4 · Recommendation

**Stage 1, WSL2 (recommended now, if Q1 is yes and Q2 allows it):** about 1.5–2 weeks of tickets, almost all of it docs and orchestrator/daemon features that also help Linux/macOS (the runtime slot). No Windows port.

**Stage 2, native Windows (parked):** only if Q1 is no, or Q2 shows the build can only run under Windows tooling with a Windows working directory. It's ~3–4 weeks, adds Windows CI, and touches security code (edit guard, ADR-0010 checks) that then needs a second review on every change.

A hybrid is possible if Q2 is "Windows-only build": the daemon in WSL, with the build command calling `msbuild.exe`. But UNC working directories make that fragile; prototype it in WIN-1 before committing.

### Proposed tickets

| ID | Title | Size | Deps |
| --- | --- | --- | --- |
| WIN-1 | WSL2 machine setup guide and a laptop smoke test | S | M2-T18 (service install) |
| WIN-2 | Keep the WSL daemon alive (Scheduled Task, linger) and detect drvfs roots | S | WIN-1 |
| WIN-3 | Runtime declaration in repo config and the inventory (ADR-0013 amendment) | M | — |
| WIN-4 | Daemon runtime slot (exclusive semaphore + `runtime_slot` badge) | M | WIN-3 |
| WIN-5 | IIS deploy step: `app_offline` + robocopy + health wait, and the e2e on the laptop | M | WIN-4, Q2–Q4 |
| WIN-N1…N8 | Native Windows epic: N1 tree kill, N2 orphan sweep, N3+N11 shell and spawn, N4+N5 edit guard, N6+N7 ACLs (ADR-0010 amendment), N8–N10 paths/symlinks, N12 installer + task, N13 Windows CI first | L (epic) | N13 before the rest |

**WIN-1 · WSL2 machine setup guide and smoke test**

- Goal: Ben enrolls the work laptop's WSL2 Ubuntu as a machine by following one doc.
- FR: `docs/setup/add-a-machine.md` gets a "Windows (WSL2)" section: `wsl --install`, systemd check, Node 22, git, gh, Claude inside WSL, clone repos into `~/`, run `install.sh` with `--service`; `.wslconfig` (`memory=`, `networkingMode=mirrored`). Prototype a Windows-tool call from WSL if Q2 needs one.
- NFR: no daemon code changes.
- Verification: Ben enrolls the laptop, a fake ticket runs end to end, the Machines page shows the repos; the outcome is recorded against U-071.

**WIN-2 · Keep alive and placement checks**

- Goal: the WSL daemon stays connected while Ben is logged in, and a bad placement fails loudly.
- FR: document (or `service install` prints, when `/proc/version` contains `microsoft`) the Scheduled Task and `loginctl enable-linger`; `run`/`enroll` refuse a `--root` on a `9p`/`drvfs` mount with a clear message, instead of the confusing "readable by other users" (`credential.ts:104-105`).
- NFR: Linux/macOS behaviour unchanged.
- Verification: unit test with a faked mount table; a manual 1-hour idle test on the laptop.

**WIN-3 · Runtime declaration**

- Goal: a repo can say "my e2e needs the fixed-path runtime `iis:<name>` on this machine".
- FR: per-machine config `runtimes: [{name, kind: 'iis', path, health_url}]`; the inventory reports runtime names (not paths, per ADR-0013's privacy rule); routing requires the runtime for tickets/commands that declare it.
- NFR: an ADR-0013 amendment, approved by Ben; schema change → migration.
- Verification: inventory and routing tests.

**WIN-4 · Runtime slot**

- Goal: two sessions never deploy to the same runtime at once.
- FR: a capacity-1 semaphore per runtime in the daemon, acquired before the build slot and held for the whole command; a `runtime_slot {waiting, runtime}` session event and a `waiting_for_runtime_slot` badge; released on exit, timeout and kill.
- NFR: no orchestrator-side lock; the 03/02/07 design docs updated in the same branch.
- Verification: process-runner unit tests (ordering, release on kill); fake-claude e2e with two sessions, where the second shows the badge until the first finishes.

**WIN-5 · IIS deploy step**

- Goal: a session's build is e2e-tested on the laptop's IIS site.
- FR: a documented deploy script/command template (publish → `app_offline.htm` → robocopy/rsync → remove → health wait → e2e), run under the runtime slot; optional snapshot/restore (Q4).
- NFR: no admin needed for the normal path; failures leave `app_offline.htm` removed (a trap/finally).
- Verification: a run on the laptop for a real ticket, with the PR showing the e2e result.

**WIN-N (native epic)**: Goal: the daemon runs on native Windows with the same safety guarantees. FRs per row of the FR-2 table. NFR: Windows CI (N13) first, and a security re-review for N4–N7. Verification: the daemon test suite green on `windows-latest`, plus a fake-claude e2e on Windows and the edit-guard path table test.

## Open questions for Ben

1. **Q1. Is WSL2 allowed and installable on the work laptop?** (Virtual Machine Platform, corporate policy, IT approval.) If no, only the native path is left.
2. **Q2. What does the app's build need?** .NET (Core/5+) builds in WSL; .NET Framework / msbuild / Windows-only tools force Windows tooling (interop from WSL, or native). The answer picks the stage.
3. **Q3. Admin rights?** Needed to recycle or stop the app pool or to change IIS config. The recommended path only needs write access to the IIS directory.
4. **Q4. May a test deploy overwrite what's in the IIS directory, and should it restore the previous contents afterwards?** And should a manual hold stop sessions from deploying while Ben is using the site himself?
5. **Q5. Logins inside WSL:** is it OK to log in to Claude Code and `gh` inside WSL with the work GitHub account (separate from any Windows-side logins)? Is the org's GitHub reachable and allowed from a WSL VM (proxy, VPN, SSO)?
6. **Q6. Which repos live on the laptop**, and do they also need the IIS runtime (one runtime or several sites)?

## Proposed tracking updates (for the lead)

- **U-070** → status `answered (pending Ben)`. Resolution: "Spike (docs/design/windows-spike.md, FR-3): don't repoint IIS at worktrees (UNC/`\\wsl$` access by the app pool identity is unreliable). Deploy the build output into the fixed IIS directory as a test step (`app_offline.htm`, robocopy/rsync, health wait, e2e), under a daemon-local **exclusive runtime slot** per (machine, runtime) held for the whole deploy+e2e command, with a `waiting_for_runtime_slot` badge. ADR-0013 has no `runtime` field yet; needs an amendment (WIN-3). Open: Q2–Q4, Q6."
- **U-071** → status `answered (pending Ben)`. Resolution: "Spike (docs/design/windows-spike.md): run the daemon in WSL2 Ubuntu. It needs no code change if `--root` and the repos are on ext4 (drvfs breaks the mode checks, `credential.ts:104`). Setup gaps: systemd for `--service`, a keep-alive task, logins inside WSL (WIN-1, WIN-2). Native Windows is a ~15–25-day port (process-tree kill, orphan sweep, owner/mode checks that no-op or always fail on NTFS, edit-guard quoting and paths, installer), parked unless Q1/Q2 rule WSL out."
- New unknowns: **Q1–Q6** above (Q1 and Q2 block the stage choice); "does a systemd service alone keep a WSL distro running?" (verify on the laptop, WIN-2); "does Node `lstat` report junctions as symlinks?" (native only, N8).
