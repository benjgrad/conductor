# ADR-0021 · Daemon auto-update: server-announced, drained, rolled back on failure

- **Status**: accepted (Ben merged PR #41, 2026-10-28)
- **Date**: 2026-10-28
- **Deciders**: Ben (+ Claude lead session, 2026-10-28)
- **Resolves**: none open. Amends [ADR-0017](0017-own-sign-in-and-self-hosting.md) §Daemon distribution, "Upgrades" (manual re-run → automatic)
- **Builds on**:
  - [ADR-0017](0017-own-sign-in-and-self-hosting.md): the orchestrator serves `/install.sh` and `conductor-daemon-<version>.tgz` + SHA-256 (M2-T14); layout `<root>/daemon/<version>`, `<root>/daemon/current`, `<root>/bin/conductor-daemon`;
  - [ADR-0013](0013-machine-enrollment-inventory-routing.md): enrolled credential, `register.daemon_version` / `protocol_version`, `alert`;
  - [ADR-0001](0001-pull-scheduler.md): the daemon pulls work, so it can stop taking work on its own;
  - M2-T18: `service install` (launchd agent / systemd user unit) that starts the daemon at login.

## Context
Ben, 2026-10-28: *"We should improve our daemon so it auto-updates and starts when the user opens the laptop."*

Starting at login is already planned (M2-T18). Updating isn't: ADR-0017 makes an upgrade a human re-running `install.sh`. The Machines page can only show "outdated", and a protocol bump (close 4005) leaves the machine offline until someone notices. Conductor is being built on itself and its main branch merges many times a day. Each deploy would leave every laptop behind, and a stale daemon is a correctness risk, not just a cosmetic one.

Three things make updating harder than it looks:
1. **Live work.** A daemon restart kills running Claude turns, checks and `open_pr` actions.
2. **A bad build.** If the new version can't start or connect, the machine drops out, and nobody may be at the laptop.
3. **Laptops.** They sleep, wake without a network, and get closed mid-download.

Engine invariants still apply: every loop bounded, every failure path ends at a human, idempotency on side effects.

## Decision
**The orchestrator tells an outdated daemon which build to fetch. The daemon downloads and verifies it in the background, stops taking new work, waits until nothing is running, switches `current`, and exits. Its service manager restarts it on the new version. A version-independent launcher rolls back to the previous version if the new one fails to start, and the failure reaches a human as a machine alert. Auto-update is on by default, with an opt-out per machine.**

### 1 · Trigger: the server announces (Ben: "server tells it")
- After `registered`, when `isOutdated(daemon_version, servedVersion)` (M2-T14) is true and a build is served, the gateway sends a direct frame **`update_available {version, file, sha256, size}`**. It's machine-level, not an outbox command: no `command_id`, no ack, no retry. It is re-sent on every register, so it is idempotent by construction.
- New builds reach daemons because a deploy restarts the orchestrator (`docker compose up`): every daemon reconnects, re-registers and gets the frame. No polling, no timer.
- **Protocol too old (4005).** The socket is closed before any frame can go out, so a daemon that knows this ADR fetches **`GET /downloads/latest.json`** (`{version, file, sha256, size}`, `no-store`) from its enrolled URL and runs the same update. Daemons released before this ADR can't, and need one manual `install.sh` re-run (the 4005 hint stays).
- **Trust** is the same as `install.sh`: the code comes from the orchestrator the machine enrolled with, over https, with plain http allowed only to a loopback host (`isSecureOrLoopback`) and no redirects followed, the same rules as `enroll`. The SHA-256 arrives over the authenticated socket or the latest.json fetch. `file` must match `^conductor-daemon-[0-9A-Za-z.+-]+\.tgz$` and `version` must equal the version in the name.

### 2 · Drain, then update (Ben: "drain, then update")
1. **Stage** (in the background; work continues): download to `<root>/daemon/.staging-<random>`, check size and SHA-256, list the archive and refuse absolute paths, `..`, links pointing outside the archive, and devices, then unpack. Run `<staging>/bin/conductor-daemon --version` and require that it prints `version`. Rename the result to `<root>/daemon/<version>`. A failure at any step deletes the staging directory.
2. **Drain**: stop sending `request_work`, and send `heartbeat.draining = {reason: 'update', version}` so the orchestrator sets `machine.status = 'draining'` (the enum already has it). Commands already queued for this machine are still honoured.
3. **Wait for idle**: no live Claude **turn**, no `run_cmd` and no `run_action` in flight. Sessions **parked** for a human (`ask_user`, `no_outcome`) or in event states **do not block**. On restart their process goes the way it already does after a daemon restart: the startup orphan sweep (BUG-1b), then the existing resume path on the next answer (`no_live_process` → `start_session` with `resume_claude_session_id`, [10](../design/10-contracts.md#refusals)).
4. **Switch**: write `<root>/daemon/trial` (`from=`, `to=`, `attempts=0`), atomically repoint `current` (rename a temp symlink over it), and exit with **`EXIT_RESTART_FOR_UPDATE` = 75** (`EX_TEMPFAIL`). The systemd unit (`Restart=on-failure`) and the launchd agent (`KeepAlive {SuccessfulExit: false}`) both restart on 75. Exit 78 (`EXIT_FATAL_AUTH`, M2-T18) still stops them.
5. **Bounds**: draining gives up after **6 h** (`update.max_drain_ms`). The daemon resumes taking work, raises the alert (§3), and doesn't drain for that version again for 1 h. After **3** abandoned drains for the same version it stops trying that version until the daemon restarts or a newer version is served.
6. **Not supervised** (run in a terminal, no unit installed; `CONDUCTOR_SUPERVISED` unset): the daemon stages the build but doesn't switch. It logs `update <version> staged; restart conductor-daemon to use it` once. Otherwise exiting would just stop the machine.

### 3 · Rollback (Ben: "auto-rollback")
- **The launcher.** The unit runs `<root>/bin/conductor-launch`, a small POSIX `sh` script that doesn't belong to any daemon version. `service install` and `install.sh` write it, and new versions never rewrite it from inside an update. Rollback logic must not live in the code being rolled back. On each start, if `<root>/daemon/trial` exists, it increments `attempts`. When `attempts > 2` (the new version failed to start twice), it repoints `current` to `from`, appends `to` to `<root>/daemon/bad-versions` and deletes `trial`. Then it `exec`s `<root>/daemon/current/bin/conductor-daemon run`.
- **Committing.** The new version deletes `trial` on its first `registered`. That is the success signal.
- **Connected but broken.** If the new version reaches the server (socket opened or HTTP response received) but has no `registered` within **120 s**, it exits 75, which counts as a failed attempt. **Being offline doesn't count**: a laptop that wakes without Wi-Fi keeps waiting and isn't rolled back. The launcher counts attempts, not wall-clock time, for the same reason.
- **Reporting.** The daemon that ends up running after a rollback (the old version) sees the new `bad-versions` entry and sends **`alert {kind: 'update_failed', version, stage, error, at}`** (stage ∈ `download`, `verify`, `unpack`, `drain_timeout`, `trial`). The Machines page shows it on the machine (not on a card). That is the human end of every update failure path. The daemon ignores `update_available` for a version in `bad-versions`, so it doesn't loop. A newer build is tried again.
- **Disk.** After a commit the daemon keeps `current` and the previous version and deletes older ones. It never deletes the directory `current` or `trial.from` points at.

### 4 · On by default, opt out per machine (Ben: "on, with opt-out")
- `conductor-daemon config auto-update on|off` (default `on`), in the daemon config (M2-T10's `config` command). With `off`, `update_available` is logged and ignored, and the Machines page keeps showing "outdated". No server-side setting and no migration.

### 5 · Start at login and wake (M2-T18, extended)
- Login: the T18 units, now `exec`ing the launcher.
- Wake (opening the lid): the daemon isn't restarted, it was only suspended. Its timers stall during sleep, so a check that sees wall-clock time jump by more than 30 s between 5 s ticks resets the reconnect backoff and reconnects at once. Without it, waking can wait up to the 30 s backoff cap (`reconnect.maxMs`).

## Alternatives considered
| Option | Why not |
|---|---|
| Daemon polls `/healthz` or `latest.json` on a timer | Ben chose server-announced. Polling adds traffic and a second trigger, and deploys already force a re-register. latest.json stays, used only for the 4005 path |
| Update only at daemon start | A laptop daemon runs for days; it would stay stale |
| Update immediately, kill running sessions | Interrupts agent turns and `open_pr` mid-step; recovery works but wastes spend and confuses the board |
| A human clicks "Update" on the Machines page | One more chore per deploy per machine; Ben chose automatic |
| Rollback logic inside the daemon | A build that crashes on start never runs it. The launcher is outside every version |
| Signed tarballs (key held off the server) | Protects against a compromised orchestrator, but that orchestrator already sends prompts and commands to Claude on the machine, so it controls the machine anyway. Revisit if someone else hosts the orchestrator |
| `npm` / Homebrew packages with their own updaters | ADR-0017 rejected publishing; the daemon stays in step with the server it talks to |
| Node SEA / bundled Node binary | Unchanged from ADR-0017: Node 22 is a prerequisite |

## Consequences
- **Good:** a deploy reaches every machine without anyone touching it; running work is never cut; a bad build rolls itself back and tells a human; protocol bumps (4005) heal themselves from now on.
- **Bad / accepted cost:**
  - one extra moving part, the launcher script, maintained in two writers (`service install` and `install.sh`); a test asserts they write identical bytes;
  - daemons from before this change need one manual `install.sh` re-run (and `service install` to switch the unit to the launcher);
  - a new version that hangs without exiting and without reaching the server isn't rolled back; it shows as offline + outdated on the Machines page;
  - a machine with a long agent turn can lag a deploy by up to 6 h; protocol changes must stay additive for that window (they already are, 10-contracts §Machines protocol v2);
  - the orchestrator's code runs on users' machines without a per-update human look (same trust as install, stated above).
- **Follow-ups:** M2-T18 (launcher, wake check), M2-T18b (contracts), M2-T18c (daemon updater), M2-T18d (orchestrator), M2-T18e (web); M2-T22 / T24 e2e cover an update and a rollback.

## Revisit when
- someone other than the account owner hosts the orchestrator (then: signed builds);
- Windows daemons arrive (U-071): no launchd/systemd, and a running binary can't be replaced in place;
- drains routinely hit the 6 h limit.
