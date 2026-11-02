//! Port of `packages/daemon/src/commands/runner.ts` (MR-T06): the command-state runner contract.
//!
//! `commands/process_runner` (MR-T07) implements it and `commands/fake_runner` fakes it. The daemon
//! core (MR-T12) calls it for WS `run_cmd` and turns the result into `session_event` `cmd_exit`
//! (plus `build_slot` while queued, plus `output` chunks).
//!
//! No `async-trait` and no `tokio-util`: `run` returns a boxed future, so the trait stays
//! object-safe (`Box<dyn CommandRunner>`), and [`CancelToken`] stands in for the TS
//! `AbortSignal`. `run` registers the command (and queues it for a slot) **before** it returns,
//! so a caller sees the run counted without awaiting it, as in TS.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Notify;
use uuid::Uuid;

/// Which pipe a chunk came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputStreamKind {
    Stdout,
    Stderr,
}

impl OutputStreamKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OutputStreamKind::Stdout => "stdout",
            OutputStreamKind::Stderr => "stderr",
        }
    }
}

/// `CommandOutputChunk`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutputChunk {
    pub stream: OutputStreamKind,
    pub text: String,
}

/// Live output, forwarded as WS `output`.
pub type OnOutput = Arc<dyn Fn(CommandOutputChunk) + Send + Sync>;
/// `true` when the command must wait for a build slot, `false` when it gets one (only called with
/// `true` if it actually waits). Forwarded as `session_event` `build_slot`.
pub type OnWaitingForSlot = Arc<dyn Fn(bool) + Send + Sync>;

/// The TS `AbortSignal` for a run: clones share one flag. Cancelling twice is a no-op.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<CancelInner>);

#[derive(Debug, Default)]
struct CancelInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.0.cancelled.swap(true, Ordering::SeqCst) {
            self.0.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel` has been called (at once if it already was). Composes with
    /// `Semaphore::acquire_until`.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// `RunCommandOptions`.
#[derive(Clone)]
pub struct RunCommandOptions {
    /// The outbox command_id from `run_cmd`; echoed in `cmd_exit`.
    pub command_id: Uuid,
    pub session_id: Uuid,
    /// Shell command line, run with `sh -c` (07: through the build semaphore).
    pub cmd: String,
    /// Absolute cwd: the session worktree, joined with `run_cmd.cwd` if set.
    pub cwd: PathBuf,
    /// `None` = no timeout. On expiry: SIGTERM, then SIGKILL; result `timed_out: true`.
    pub timeout: Option<Duration>,
    /// Merged over the daemon env (session ports, etc.).
    pub env: BTreeMap<String, String>,
    /// Bytes of combined output kept for `output_tail`. `None` = `OUTPUT_TAIL_BYTES` (16 KB).
    pub tail_bytes: Option<usize>,
    pub on_output: Option<OnOutput>,
    pub on_waiting_for_slot: Option<OnWaitingForSlot>,
    /// Abort (e.g. WS `kill` for the session): kills the command; it resolves with a signal.
    pub cancel: Option<CancelToken>,
}

impl RunCommandOptions {
    /// The required fields, with no timeout, env, callbacks or cancel token.
    pub fn new(
        command_id: Uuid,
        session_id: Uuid,
        cmd: impl Into<String>,
        cwd: impl Into<PathBuf>,
    ) -> Self {
        RunCommandOptions {
            command_id,
            session_id,
            cmd: cmd.into(),
            cwd: cwd.into(),
            timeout: None,
            env: BTreeMap::new(),
            tail_bytes: None,
            on_output: None,
            on_waiting_for_slot: None,
            cancel: None,
        }
    }
}

impl std::fmt::Debug for RunCommandOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunCommandOptions")
            .field("command_id", &self.command_id)
            .field("session_id", &self.session_id)
            .field("cmd", &self.cmd)
            .field("cwd", &self.cwd)
            .field("timeout", &self.timeout)
            .field("env", &self.env)
            .field("tail_bytes", &self.tail_bytes)
            .field("on_output", &self.on_output.is_some())
            .field("on_waiting_for_slot", &self.on_waiting_for_slot.is_some())
            .field("cancel", &self.cancel)
            .finish()
    }
}

/// `CommandResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandResult {
    /// `None` when killed by a signal (timeout included).
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    /// From slot acquisition to exit (queue time excluded).
    pub duration_ms: u64,
    /// The last `tail_bytes` of stdout+stderr interleaved; `cmd_exit.output_tail`.
    pub output_tail: String,
}

/// Why a run produced no [`CommandResult`]. A failing command is never an error.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    /// The process could not be spawned.
    #[error("could not run the command: {0}")]
    Spawn(String),
    /// The runner was dropped before the command finished.
    #[error("the command runner went away")]
    Gone,
}

/// What [`CommandRunner::run`] returns.
pub type RunFuture<'a> = Pin<Box<dyn Future<Output = Result<CommandResult, RunError>> + Send + 'a>>;

/// `CommandRunner`.
pub trait CommandRunner: Send + Sync {
    /// The size of the build semaphore (`machine.max_concurrent_builds`, default 2).
    fn max_concurrent(&self) -> usize;
    /// Never fails for a failing command; fails only if the process could not be spawned.
    fn run(&self, opts: RunCommandOptions) -> RunFuture<'_>;
}

/// `CreateCommandRunner`: built once with `machine.max_concurrent_builds`.
pub type CreateCommandRunner = fn(max_concurrent: usize) -> Box<dyn CommandRunner>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cancel_token_wakes_every_waiter_and_stays_cancelled() {
        let t = CancelToken::new();
        let waiter = {
            let t = t.clone();
            tokio::spawn(async move { t.cancelled().await })
        };
        tokio::task::yield_now().await;
        assert!(!t.is_cancelled());
        t.cancel();
        waiter.await.unwrap();
        t.cancel();
        t.cancelled().await;
        assert!(t.clone().is_cancelled());
    }
}
