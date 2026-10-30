//! Port of `packages/daemon/src/platform/kill-tree.ts` (MR-T04). ADR-0024 §1–§2, ADR-0026: end a
//! child and everything it started.
//!
//! POSIX: the child was spawned `detached`, so it leads its own process group. Signal the group
//! (`killpg`); with a grace period, escalate to SIGKILL afterwards. For a child we spawned whose
//! group signal fails, fall back to signalling the child alone, but only while it is not reaped. A
//! bare pid gets no per-pid fallback: after a reap its pid may already belong to someone else. A
//! grandchild that called `setsid` left the group and survives, exactly as in the TS daemon (U-117).
//!
//! Windows: there are no process groups or signals, so `signal` is ignored and there is no grace
//! step. A child `spawn_cli` put in a Job Object is ended by terminating the job: that takes every
//! process in it, including grandchildren whose parent already exited (U-116), so it is done even
//! after the root exited (no pid is involved, so pid reuse can't hit a stranger). Without a job
//! (assignment failed, or a bare pid) it falls back to `taskkill /T /F /PID`, which walks the
//! parent-pid tree and misses a reparented grandchild (TD-189). A child without a job that has
//! already exited is skipped: its pid may be reused.

use super::Platform;
use super::spawn::TreeHandle;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The signals the daemon sends. The protocol carries them as their names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

impl Signal {
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::Term => "SIGTERM",
            Signal::Kill => "SIGKILL",
        }
    }
}

/// What to kill.
#[derive(Debug, Clone, Copy)]
pub enum KillTarget<'a> {
    /// A pid we did not spawn (or no longer hold the child of).
    Pid(u32),
    /// A child `spawn_cli` started.
    Child(&'a TreeHandle),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct KillTreeOptions {
    /// First signal (POSIX). Default SIGTERM.
    pub signal: Option<Signal>,
    /// POSIX: send SIGKILL after this long unless cancelled. None: no escalation.
    pub grace: Option<Duration>,
}

/// A pid that can't name a process (0, or beyond `pid_t`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("killTree: bad pid {0}")]
pub struct BadPid(pub u32);

/// A kill in progress.
#[derive(Debug)]
pub struct KillTreeHandle {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    task: Option<JoinHandle<()>>,
}

impl KillTreeHandle {
    fn done() -> Self {
        KillTreeHandle {
            cancel: Mutex::new(None),
            task: None,
        }
    }

    /// Stop a pending SIGKILL escalation (call it when the child has exited). Idempotent.
    pub fn cancel(&self) {
        if let Some(tx) = self.cancel.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
        }
    }

    /// Resolves once the last kill was issued or the escalation was cancelled. On Windows that is
    /// when the job is empty (bounded) or `taskkill` has exited, so the tree is gone (modulo
    /// TD-189 for the taskkill path).
    pub async fn settled(self) {
        if let Some(task) = self.task {
            let _ = task.await;
        }
    }
}

/// The `taskkill` invocation for a tree kill. Pure.
pub fn taskkill_args(pid: u32) -> Vec<String> {
    vec!["/T".into(), "/F".into(), "/PID".into(), pid.to_string()]
}

/// Kill `target` and its descendants. See the header. Needs a tokio runtime when there is
/// something to wait for (an escalation, a job drain, taskkill).
pub fn kill_tree(target: KillTarget<'_>, opts: KillTreeOptions) -> Result<KillTreeHandle, BadPid> {
    let (pid, child) = match target {
        KillTarget::Pid(pid) => (pid, None),
        KillTarget::Child(tree) => match tree.pid() {
            None => return Ok(KillTreeHandle::done()), // never spawned
            Some(pid) => (pid, Some(tree)),
        },
    };
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(BadPid(pid));
    }
    Ok(imp::kill_tree(pid, child, opts))
}

/// Signal a whole tree now and say whether it was there: POSIX the process group (no per-pid
/// fallback); Windows a synchronous `taskkill /T /F` (`sig` ignored), true when it exited 0. For a
/// pid the caller has just proven is its own (the orphan sweep checks the start time first); those
/// belong to a dead daemon's job, which already took them when it died, so TD-189 applies here.
pub fn signal_tree(pid: u32, sig: Signal) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    imp::signal_tree(pid, sig)
}

/// How a child the daemon killed exited, reported the same on every OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KilledExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// POSIX reports the signal itself. Windows has no signals (a terminated job or taskkill leaves exit
/// code 1), so when the daemon sent `sent` and the child exited without a signal, it is reported
/// as `{code: None, signal: sent}`.
pub fn killed_exit_for(
    code: Option<i32>,
    signal: Option<&str>,
    sent: Option<Signal>,
    platform: Platform,
) -> KilledExit {
    if let (Platform::Windows, Some(sent), None) = (platform, sent, signal) {
        return KilledExit {
            code: None,
            signal: Some(sent.as_str().to_string()),
        };
    }
    KilledExit {
        code,
        signal: signal.map(str::to_string),
    }
}

/// [`killed_exit_for`] on this OS.
pub fn killed_exit(code: Option<i32>, signal: Option<&str>, sent: Option<Signal>) -> KilledExit {
    killed_exit_for(code, signal, sent, Platform::current())
}

#[cfg(unix)]
mod imp {
    use super::{KillTreeHandle, KillTreeOptions, Signal, TreeHandle};
    use nix::sys::signal::{self, Signal as NixSignal};
    use nix::unistd::Pid;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::oneshot;

    /// The handle of a delayed action that `cancel` can stop.
    fn escalation(grace: Duration, then: impl FnOnce() + Send + 'static) -> KillTreeHandle {
        let (tx, rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(grace) => then(),
                _ = rx => {}
            }
        });
        KillTreeHandle {
            cancel: Mutex::new(Some(tx)),
            task: Some(task),
        }
    }

    fn nix_sig(sig: Signal) -> NixSignal {
        match sig {
            Signal::Term => NixSignal::SIGTERM,
            Signal::Kill => NixSignal::SIGKILL,
        }
    }

    /// Signal a POSIX process group, then (for a child not yet reaped) the child alone.
    pub fn signal_group(pid: u32, sig: Signal, child: Option<&TreeHandle>) -> bool {
        let p = Pid::from_raw(pid as i32);
        if signal::killpg(p, nix_sig(sig)).is_ok() {
            return true;
        }
        match child {
            Some(c) if !c.has_exited() => signal::kill(p, nix_sig(sig)).is_ok(),
            _ => false, // ESRCH: the group is already gone
        }
    }

    pub fn kill_tree(
        pid: u32,
        child: Option<&TreeHandle>,
        opts: KillTreeOptions,
    ) -> KillTreeHandle {
        let sig = opts.signal.unwrap_or(Signal::Term);
        signal_group(pid, sig, child);
        match opts.grace {
            Some(grace) if sig != Signal::Kill => {
                let child = child.cloned();
                escalation(grace, move || {
                    signal_group(pid, Signal::Kill, child.as_ref());
                })
            }
            _ => KillTreeHandle::done(),
        }
    }

    pub fn signal_tree(pid: u32, sig: Signal) -> bool {
        signal_group(pid, sig, None)
    }
}

#[cfg(windows)]
mod imp {
    use super::{KillTreeHandle, KillTreeOptions, Signal, TreeHandle, taskkill_args};
    use crate::platform::spawn::{process_env, system32};
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    fn taskkill() -> String {
        system32("taskkill.exe", &process_env())
    }

    pub fn kill_tree(
        pid: u32,
        child: Option<&TreeHandle>,
        _opts: KillTreeOptions,
    ) -> KillTreeHandle {
        if let Some(job) = child.and_then(|c| c.job.clone()) {
            job.terminate();
            // Wait (bounded) until the job is empty, so the tree is gone when `settled` resolves.
            let task = tokio::spawn(async move {
                let deadline = Instant::now() + Duration::from_secs(5);
                while job.active_processes().is_some_and(|n| n > 0) && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            });
            return KillTreeHandle {
                cancel: Mutex::new(None),
                task: Some(task),
            };
        }
        if child.is_some_and(|c| c.has_exited()) {
            return KillTreeHandle::done();
        }
        let mut cmd = tokio::process::Command::new(taskkill());
        cmd.args(taskkill_args(pid))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        // Exit 128 = "not found" (already gone); any failure leaves it to the orphan sweep.
        let task = tokio::spawn(async move {
            let _ = cmd.status().await;
        });
        KillTreeHandle {
            cancel: Mutex::new(None),
            task: Some(task),
        }
    }

    pub fn signal_tree(pid: u32, _sig: Signal) -> bool {
        std::process::Command::new(taskkill())
            .args(taskkill_args(pid))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .is_ok_and(|s| s.success())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::spawn::tests_support::{node_bin, strings};
    use crate::platform::spawn::{CliChild, CliOptions, StdioKind, spawn_cli};
    use std::time::Instant;
    use tokio::io::{AsyncBufReadExt, BufReader};

    /// Is `pid` a live process? A Linux zombie (exited, not yet reaped) counts as dead.
    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        use nix::errno::Errno;
        match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None) {
            Ok(()) => {}
            Err(e) => return e == Errno::EPERM,
        }
        if cfg!(target_os = "linux") {
            return match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(stat) => !stat[stat.rfind(')').map_or(0, |i| i + 2)..].starts_with('Z'),
                Err(_) => false,
            };
        }
        true
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        // SAFETY: plain Win32 calls; the handle is closed.
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            running
        }
    }

    async fn wait_for(cond: impl Fn() -> bool, ms: u64) -> bool {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cond()
    }

    /// Kills whatever pids a test leaves behind.
    struct Reaper(Vec<u32>);
    impl Drop for Reaper {
        fn drop(&mut self) {
            for pid in &self.0 {
                let _ = signal_tree(*pid, Signal::Kill);
                #[cfg(unix)]
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(*pid as i32),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }

    /// A node child (own process group on POSIX, own job on Windows) that starts a grandchild and
    /// prints the grandchild's pid once it runs. `ignore_term` makes both ignore SIGTERM;
    /// `orphan` makes the grandchild detached and the child exit once it printed (Windows: a
    /// reparented grandchild, the case taskkill /T misses).
    async fn child_with_grandchild(ignore_term: bool, orphan: bool) -> (CliChild, u32, u32) {
        let trap = if ignore_term {
            "process.on('SIGTERM',()=>{});"
        } else {
            ""
        };
        let grand = format!("{trap}console.log('ready');setInterval(()=>{{}},1000);");
        let (opts, after) = if orphan {
            (
                "{stdio:['ignore','pipe','ignore'],detached:true}",
                "g.stdout.destroy();g.unref();process.exit(0);",
            )
        } else {
            ("{stdio:['ignore','pipe','ignore']}", "")
        };
        let src = format!(
            "{trap}const {{spawn}}=require('node:child_process');\
             const g=spawn(process.execPath,['-e',{}],{opts});\
             g.stdout.once('data',()=>{{console.log(g.pid);{after}}});setInterval(()=>{{}},1000);",
            serde_json::to_string(&grand).unwrap()
        );
        let mut child = spawn_cli(
            &node_bin(),
            &strings(&["-e", &src]),
            CliOptions {
                detached: true,
                stdin: Some(StdioKind::Null),
                stdout: Some(StdioKind::Piped),
                ..Default::default()
            },
        )
        .unwrap();
        let child_pid = child.pid().unwrap();
        let mut lines = BufReader::new(child.child.stdout.take().unwrap()).lines();
        let line = lines.next_line().await.unwrap().unwrap();
        (child, child_pid, line.trim().parse().unwrap())
    }

    /// Reap the direct child (tokio only reaps it when waited), then check both pids are gone.
    async fn assert_gone(child: &mut CliChild, child_pid: u32, grand_pid: u32) {
        let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
        assert!(
            wait_for(|| !alive(child_pid), 10_000).await,
            "child {child_pid} survived"
        );
        assert!(
            wait_for(|| !alive(grand_pid), 10_000).await,
            "grandchild {grand_pid} survived"
        );
    }

    #[test]
    fn taskkill_args_tree_force_by_pid() {
        assert_eq!(taskkill_args(42), strings(&["/T", "/F", "/PID", "42"]));
    }

    #[tokio::test]
    async fn rejects_a_bad_pid_and_ignores_a_never_spawned_child() {
        assert_eq!(
            kill_tree(KillTarget::Pid(0), KillTreeOptions::default()).unwrap_err(),
            BadPid(0)
        );
        let too_big = i32::MAX as u32 + 1;
        assert!(kill_tree(KillTarget::Pid(too_big), KillTreeOptions::default()).is_err());
        let never = TreeHandle::never_spawned();
        kill_tree(KillTarget::Child(&never), KillTreeOptions::default())
            .unwrap()
            .settled()
            .await;
    }

    #[tokio::test]
    async fn kills_a_child_and_its_grandchild() {
        let (mut child, child_pid, grand_pid) = child_with_grandchild(false, false).await;
        let _reaper = Reaper(vec![child_pid, grand_pid]);
        assert!(alive(child_pid) && alive(grand_pid));
        let opts = KillTreeOptions {
            grace: Some(Duration::from_secs(5)),
            ..Default::default()
        };
        let h = kill_tree(KillTarget::Child(&child.tree), opts).unwrap();
        assert_gone(&mut child, child_pid, grand_pid).await;
        h.cancel();
        h.settled().await;
    }

    #[tokio::test]
    async fn accepts_a_bare_pid_as_well() {
        let (mut child, child_pid, grand_pid) = child_with_grandchild(false, false).await;
        let _reaper = Reaper(vec![child_pid, grand_pid]);
        let opts = KillTreeOptions {
            signal: Some(Signal::Kill),
            grace: None,
        };
        kill_tree(KillTarget::Pid(child_pid), opts)
            .unwrap()
            .settled()
            .await;
        assert_gone(&mut child, child_pid, grand_pid).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn posix_escalates_to_sigkill_after_the_grace_period() {
        let (mut child, child_pid, grand_pid) = child_with_grandchild(true, false).await;
        let _reaper = Reaper(vec![child_pid, grand_pid]);
        let opts = KillTreeOptions {
            grace: Some(Duration::from_millis(300)),
            ..Default::default()
        };
        let h = kill_tree(KillTarget::Child(&child.tree), opts).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(alive(child_pid), "SIGTERM is ignored");
        h.settled().await;
        assert_gone(&mut child, child_pid, grand_pid).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn posix_cancel_stops_the_escalation() {
        let (child, child_pid, grand_pid) = child_with_grandchild(true, false).await;
        let _reaper = Reaper(vec![child_pid, grand_pid]);
        let opts = KillTreeOptions {
            grace: Some(Duration::from_millis(200)),
            ..Default::default()
        };
        let h = kill_tree(KillTarget::Child(&child.tree), opts).unwrap();
        h.cancel();
        h.cancel();
        h.settled().await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(alive(child_pid));
        assert!(alive(grand_pid));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn win32_an_exited_child_without_a_job_is_skipped() {
        let mut child =
            spawn_cli(&node_bin(), &strings(&["-e", "0"]), CliOptions::default()).unwrap();
        child.wait().await.unwrap();
        let tree = TreeHandle::for_pid(child.pid().unwrap());
        tree.mark_exited();
        kill_tree(KillTarget::Child(&tree), KillTreeOptions::default())
            .unwrap()
            .settled()
            .await;
        // With its job, an exited child's job is terminated instead (harmless: it is empty).
        kill_tree(KillTarget::Child(&child.tree), KillTreeOptions::default())
            .unwrap()
            .settled()
            .await;
    }

    /// U-116, the reason for Job Objects: the child exits after starting a detached grandchild,
    /// which Windows reparents. taskkill /T can't find it from the child's pid; terminating the
    /// child's job takes it.
    #[cfg(windows)]
    #[tokio::test]
    async fn win32_job_kills_a_detached_reparented_grandchild() {
        let (mut child, child_pid, grand_pid) = child_with_grandchild(false, true).await;
        let _reaper = Reaper(vec![grand_pid]);
        assert!(
            child.tree.has_job(),
            "spawn_cli put the child in a Job Object"
        );
        let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
        assert!(
            wait_for(|| !alive(child_pid), 10_000).await,
            "the child exits by itself"
        );
        assert!(
            alive(grand_pid),
            "the detached grandchild outlives its parent"
        );
        kill_tree(KillTarget::Child(&child.tree), KillTreeOptions::default())
            .unwrap()
            .settled()
            .await;
        assert!(
            wait_for(|| !alive(grand_pid), 10_000).await,
            "grandchild {grand_pid} survived"
        );
    }

    /// The same orphan on POSIX: the detached grandchild is in its own session, so the group kill
    /// misses it (TS parity, U-117). Recorded, not asserted as a goal.
    #[cfg(unix)]
    #[tokio::test]
    async fn posix_a_setsid_grandchild_escapes_the_group_kill_u117() {
        let (mut child, child_pid, grand_pid) = child_with_grandchild(false, true).await;
        let _reaper = Reaper(vec![grand_pid]);
        let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
        assert!(wait_for(|| !alive(child_pid), 10_000).await);
        kill_tree(KillTarget::Child(&child.tree), KillTreeOptions::default())
            .unwrap()
            .settled()
            .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            alive(grand_pid),
            "U-117: killpg does not reach a setsid grandchild"
        );
    }

    #[test]
    fn killed_exit_reports_the_sent_signal_on_windows_only() {
        assert_eq!(
            killed_exit_for(Some(1), None, Some(Signal::Term), Platform::Windows),
            KilledExit {
                code: None,
                signal: Some("SIGTERM".into())
            }
        );
        assert_eq!(
            killed_exit_for(Some(1), None, None, Platform::Windows),
            KilledExit {
                code: Some(1),
                signal: None
            }
        );
        assert_eq!(
            killed_exit_for(None, Some("SIGKILL"), Some(Signal::Term), Platform::Posix),
            KilledExit {
                code: None,
                signal: Some("SIGKILL".into())
            }
        );
        assert_eq!(
            killed_exit_for(Some(0), None, Some(Signal::Term), Platform::Posix).code,
            Some(0)
        );
    }

    #[test]
    fn signal_tree_of_a_missing_pid_is_false() {
        assert!(!signal_tree(0, Signal::Term));
        assert!(!signal_tree(i32::MAX as u32 - 7, Signal::Term));
    }
}
