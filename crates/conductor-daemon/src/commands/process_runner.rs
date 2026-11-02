//! Port of `packages/daemon/src/commands/process-runner.ts` (MR-T07): the real [`CommandRunner`]
//! (M1-T06, 07 §Compute).
//!
//! Each `run` takes a slot on the per-machine build semaphore (FIFO; `on_waiting_for_slot(true)`
//! and later `(false)` only when it actually waits), then runs `sh -c <cmd>` (Git Bash on Windows,
//! ADR-0024 §4) in its own process group (POSIX) or Job Object (Windows) in `cwd` with the daemon
//! env + `opts.env`. Timeout and cancel send SIGTERM to the whole tree, then SIGKILL after
//! `kill_grace` (Windows: the job is terminated at once). When the shell exits, anything it left
//! in its group or job is killed, so no build escapes the semaphore. On Windows the job takes Git
//! Bash background jobs too, which the TS daemon's `taskkill /T` missed (TD-189). Output streams
//! to `on_output` and the last `tail_bytes` of stdout+stderr (interleaved) become `output_tail`.
//!
//! As the contract in `runner.rs` requires, `run` takes the slot (or joins the queue) and calls
//! `on_waiting_for_slot(true)` before it returns. The command then runs on a spawned task:
//! dropping the returned future does **not** stop it (it still runs and frees its slot); cancel it
//! with the [`CancelToken`](crate::commands::runner::CancelToken).

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use conductor_protocol::OUTPUT_TAIL_BYTES;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::oneshot;

use crate::commands::runner::{
    CommandOutputChunk, CommandResult, CommandRunner, OnOutput, OutputStreamKind,
    RunCommandOptions, RunError, RunFuture,
};
use crate::commands::semaphore::Semaphore;
use crate::commands::tail::TailBuffer;
use crate::platform::spawn::{Env, process_env};
use crate::platform::{
    CliOptions, KillTarget, KillTreeOptions, Platform, Signal, StdioKind, exit_parts, kill_tree,
    killed_exit, spawn_cli, workflow_shell,
};

/// SIGTERM → SIGKILL grace on timeout/cancel (the daemon's kill grace).
pub const DEFAULT_KILL_GRACE: Duration = Duration::from_secs(5);
/// After the shell exits, how long its output may keep draining before the pipes are closed.
const DRAIN: Duration = Duration::from_secs(2);

/// `ProcessCommandRunnerOptions`.
#[derive(Debug, Clone, Default)]
pub struct ProcessCommandRunnerOptions {
    /// Build semaphore size (`machine.max_concurrent_builds`).
    pub max_concurrent: usize,
    /// Default [`DEFAULT_KILL_GRACE`].
    pub kill_grace: Option<Duration>,
    /// Run as `<shell> -c <cmd>`. Default `/bin/sh`; Git Bash on Windows (`workflow_shell`).
    pub shell: Option<PathBuf>,
}

struct Inner {
    max_concurrent: usize,
    slots: Semaphore,
    kill_grace: Duration,
    /// Resolved on first use, so a machine without Git Bash fails the command, not the daemon.
    shell: Mutex<Option<PathBuf>>,
}

/// `ProcessCommandRunner`. Clones share the semaphore. Needs a tokio runtime.
#[derive(Clone)]
pub struct ProcessCommandRunner(Arc<Inner>);

/// Gives the build slot back however the run ends (panic and abort included).
struct SlotGuard(Semaphore);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

fn aborted_before_start() -> CommandResult {
    CommandResult {
        exit_code: None,
        signal: Some(Signal::Term.as_str().to_string()),
        timed_out: false,
        duration_ms: 0,
        output_tail: String::new(),
    }
}

type Acquire = Pin<Box<dyn Future<Output = bool> + Send>>;

impl ProcessCommandRunner {
    /// Errs for a semaphore of size 0 (TS: a `RangeError`).
    pub fn new(opts: ProcessCommandRunnerOptions) -> Result<Self, String> {
        Ok(ProcessCommandRunner(Arc::new(Inner {
            max_concurrent: opts.max_concurrent,
            slots: Semaphore::new(opts.max_concurrent)?,
            kill_grace: opts.kill_grace.unwrap_or(DEFAULT_KILL_GRACE),
            shell: Mutex::new(opts.shell),
        })))
    }

    /// Commands currently holding a build slot.
    pub fn running_count(&self) -> usize {
        self.0.slots.in_use()
    }

    /// Commands queued for a build slot.
    pub fn waiting_count(&self) -> usize {
        self.0.slots.waiting()
    }

    fn shell(&self) -> Result<PathBuf, RunError> {
        let mut shell = self.0.shell.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = shell.as_ref() {
            return Ok(s.clone());
        }
        let file = workflow_shell(Platform::current())
            .map_err(RunError::Spawn)?
            .file;
        *shell = Some(file.clone());
        Ok(file)
    }

    async fn exec(&self, opts: RunCommandOptions) -> Result<CommandResult, RunError> {
        let started = Instant::now();
        let shell = self.shell()?;
        let mut child = spawn_cli(
            &shell.to_string_lossy(),
            &["-c".to_string(), opts.cmd.clone()],
            CliOptions {
                cwd: Some(opts.cwd.clone()),
                env: Some(merge_env(process_env(), &opts.env, Platform::current())),
                detached: true, // own process group, so kills reach the whole tree
                stdin: Some(StdioKind::Null),
                stdout: Some(StdioKind::Piped),
                stderr: Some(StdioKind::Piped),
                timeout: None,
            },
        )
        .map_err(|e| RunError::Spawn(e.to_string()))?;
        // Held until the end: on Windows the last TreeHandle's drop kills the job.
        let tree = child.tree.clone();

        let tail = Arc::new(Mutex::new(TailBuffer::new(
            opts.tail_bytes.unwrap_or(OUTPUT_TAIL_BYTES),
        )));
        let readers = [
            child.child.stdout.take().map(|s| {
                pipe(
                    Box::new(s),
                    OutputStreamKind::Stdout,
                    tail.clone(),
                    opts.on_output.clone(),
                )
            }),
            child.child.stderr.take().map(|s| {
                pipe(
                    Box::new(s),
                    OutputStreamKind::Stderr,
                    tail.clone(),
                    opts.on_output.clone(),
                )
            }),
        ];

        let far = Duration::from_secs(365 * 24 * 3600);
        let timeout_sleep = tokio::time::sleep(opts.timeout.unwrap_or(far));
        let kill_sleep = tokio::time::sleep(far);
        let cancel = opts.cancel.clone();
        let cancelled = async move {
            match cancel {
                Some(c) => c.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(timeout_sleep, kill_sleep, cancelled);
        // The last signal a timeout/cancel sent (Windows reports a killed command as it).
        let mut sent: Option<Signal> = None;
        let mut timed_out = false;
        let kill = |sig: Signal| {
            let _ = kill_tree(
                KillTarget::Child(&tree),
                KillTreeOptions {
                    signal: Some(sig),
                    grace: None,
                },
            );
        };
        let status = loop {
            let terminating = sent.is_some();
            let escalated = sent == Some(Signal::Kill);
            tokio::select! {
                st = child.child.wait() => break st,
                () = &mut timeout_sleep, if opts.timeout.is_some() && !terminating => {
                    timed_out = true;
                    sent = Some(Signal::Term);
                    kill(Signal::Term);
                    kill_sleep.as_mut().reset(tokio::time::Instant::now() + self.0.kill_grace);
                }
                () = &mut cancelled, if !terminating => {
                    sent = Some(Signal::Term);
                    kill(Signal::Term);
                    kill_sleep.as_mut().reset(tokio::time::Instant::now() + self.0.kill_grace);
                }
                () = &mut kill_sleep, if terminating && !escalated => {
                    sent = Some(Signal::Kill);
                    kill(Signal::Kill);
                }
            }
        };
        tree.mark_exited();
        // Reap anything the shell left behind in its group or job (it would hold the pipes open
        // and keep running outside the semaphore).
        kill(Signal::Kill);
        let status = status.map_err(|e| RunError::Spawn(e.to_string()))?;
        // A leftover that survived keeps the pipes open: stop reading after a drain period so the
        // build slot is always released.
        let aborts: Vec<_> = readers.iter().flatten().map(|h| h.abort_handle()).collect();
        let drained = tokio::time::timeout(DRAIN, async {
            for h in readers.into_iter().flatten() {
                let _ = h.await;
            }
        })
        .await;
        if drained.is_err() {
            for a in aborts {
                a.abort();
            }
        }

        let (code, signal) = exit_parts(&status);
        let k = killed_exit(code, signal.as_deref(), sent);
        let output_tail = tail.lock().unwrap_or_else(|e| e.into_inner()).to_string();
        Ok(CommandResult {
            exit_code: if k.signal.is_some() { None } else { k.code },
            signal: k.signal,
            timed_out,
            duration_ms: started.elapsed().as_millis() as u64,
            output_tail,
        })
    }
}

/// Read one pipe to its end: every chunk goes to the tail and, decoded, to `on_output`.
fn pipe(
    mut stream: Box<dyn AsyncRead + Send + Unpin>,
    kind: OutputStreamKind,
    tail: Arc<Mutex<TailBuffer>>,
    on_output: Option<OnOutput>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut decoder = Utf8Decoder::default();
        let mut buf = vec![0u8; 8192];
        let emit = |text: String| {
            if let (false, Some(cb)) = (text.is_empty(), &on_output) {
                cb(CommandOutputChunk { stream: kind, text });
            }
        };
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tail.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(&buf[..n]);
                    emit(decoder.write(&buf[..n]));
                }
            }
        }
        emit(decoder.end());
    })
}

impl CommandRunner for ProcessCommandRunner {
    fn max_concurrent(&self) -> usize {
        self.0.max_concurrent
    }

    fn run(&self, opts: RunCommandOptions) -> RunFuture<'_> {
        if opts.cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            return Box::pin(async { Ok(aborted_before_start()) });
        }
        // Take a free slot, or join the FIFO queue, now: `acquire_until` enqueues on its first
        // poll, so poll it once here (a no-op waker; the task polls it again with a real one).
        let slots = self.0.slots.clone();
        let cancel = opts.cancel.clone();
        let mut acquire: Acquire = Box::pin(async move {
            match cancel {
                Some(c) => {
                    slots
                        .acquire_until(async move { c.cancelled().await })
                        .await
                }
                None => {
                    slots.acquire().await;
                    true
                }
            }
        });
        let waiting = match acquire
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(true) => None,
            Poll::Ready(false) => return Box::pin(async { Ok(aborted_before_start()) }),
            Poll::Pending => {
                if let Some(cb) = &opts.on_waiting_for_slot {
                    cb(true);
                }
                Some(acquire)
            }
        };
        let (tx, rx) = oneshot::channel();
        let me = self.clone();
        tokio::spawn(async move {
            if let Some(acquire) = waiting {
                if !acquire.await {
                    let _ = tx.send(Ok(aborted_before_start()));
                    return;
                }
                if let Some(cb) = &opts.on_waiting_for_slot {
                    cb(false);
                }
            }
            let _slot = SlotGuard(me.0.slots.clone());
            let r = me.exec(opts).await;
            drop(_slot);
            let _ = tx.send(r);
        });
        Box::pin(async move { rx.await.map_err(|_| RunError::Gone)? })
    }
}

/// `{...process.env, ...opts.env}`: `over` replaces any `base` entry of the same name (any case on
/// Windows, where env names are case-insensitive) and is appended in its own order.
pub fn merge_env(base: Env, over: &BTreeMap<String, String>, platform: Platform) -> Env {
    let same = |a: &str, b: &str| {
        if platform.is_windows() {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut env: Env = base
        .into_iter()
        .filter(|(k, _)| !over.keys().any(|o| same(k, o)))
        .collect();
    env.extend(over.iter().map(|(k, v)| (k.clone(), v.clone())));
    env
}

/// Node's `StringDecoder('utf8')`: decodes chunks without splitting a multi-byte character across
/// them. Invalid bytes become U+FFFD; an incomplete character left at the end is flushed by `end`.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn write(&mut self, chunk: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);
        let keep = incomplete_tail_len(&buf);
        self.pending = buf.split_off(buf.len() - keep);
        String::from_utf8_lossy(&buf).into_owned()
    }

    pub fn end(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned()
    }
}

/// Bytes at the end of `buf` that start a character the chunk cut off (0 when none).
fn incomplete_tail_len(buf: &[u8]) -> usize {
    let mut start = 0;
    loop {
        match std::str::from_utf8(&buf[start..]) {
            Ok(_) => return 0,
            Err(e) => match e.error_len() {
                None => return buf.len() - (start + e.valid_up_to()),
                Some(bad) => start += e.valid_up_to() + bad,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    // Real `sh` (Git Bash on Windows) processes: spawning, process groups/jobs and kills are what's
    // under test, so these can't be faked.
    use super::*;
    use crate::commands::create_command_runner;
    use crate::commands::runner::CancelToken;
    use crate::platform::read_proc_info;
    use uuid::Uuid;

    fn on_windows() -> bool {
        Platform::current().is_windows()
    }

    /// A path as written inside a POSIX shell script (Git Bash on Windows takes C:/…).
    fn sh_path(p: &std::path::Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    /// Shell that prints the OS pid of the last background job (MSYS `$!` is not a Windows pid).
    fn last_bg_pid() -> &'static str {
        if on_windows() {
            "cat /proc/$!/winpid"
        } else {
            "echo $!"
        }
    }

    fn opts(cmd: &str, wt: &std::path::Path) -> RunCommandOptions {
        RunCommandOptions::new(
            Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
            cmd,
            wt,
        )
    }

    fn runner(max: usize, grace_ms: Option<u64>) -> ProcessCommandRunner {
        ProcessCommandRunner::new(ProcessCommandRunnerOptions {
            max_concurrent: max,
            kill_grace: grace_ms.map(Duration::from_millis),
            shell: None,
        })
        .unwrap()
    }

    type Chunks = Arc<Mutex<Vec<CommandOutputChunk>>>;

    fn record_output(o: &mut RunCommandOptions) -> Chunks {
        let chunks: Chunks = Arc::default();
        let c = chunks.clone();
        o.on_output = Some(Arc::new(move |ch| c.lock().unwrap().push(ch)));
        chunks
    }

    fn record_waits(o: &mut RunCommandOptions) -> Arc<Mutex<Vec<bool>>> {
        let waits: Arc<Mutex<Vec<bool>>> = Arc::default();
        let w = waits.clone();
        o.on_waiting_for_slot = Some(Arc::new(move |b| w.lock().unwrap().push(b)));
        waits
    }

    fn text(chunks: &Chunks, kind: Option<OutputStreamKind>) -> String {
        chunks
            .lock()
            .unwrap()
            .iter()
            .filter(|c| kind.is_none_or(|k| c.stream == k))
            .map(|c| c.text.as_str())
            .collect()
    }

    async fn wait_for(pred: impl Fn() -> bool, ms: u64) {
        let end = Instant::now() + Duration::from_millis(ms);
        while !pred() {
            assert!(Instant::now() < end, "wait_for timed out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn create_command_runner_returns_the_real_runner_with_the_given_semaphore_size() {
        let _: crate::commands::runner::CreateCommandRunner = create_command_runner;
        let r = create_command_runner(3);
        assert_eq!(r.max_concurrent(), 3);
        assert!(ProcessCommandRunner::new(ProcessCommandRunnerOptions::default()).is_err());
    }

    #[tokio::test]
    async fn exit_0_runs_in_cwd_with_merged_env_and_streams_output() {
        let wt = tempfile::tempdir().unwrap();
        let r = runner(2, None);
        let mut o = opts(
            "(pwd -W 2>/dev/null || pwd); echo \"port=$PORT\"; echo oops >&2",
            wt.path(),
        );
        o.env.insert("PORT".into(), "41000".into());
        let chunks = record_output(&mut o);
        let res = r.run(o).await.unwrap();
        assert_eq!(
            (res.exit_code, res.signal.as_deref(), res.timed_out),
            (Some(0), None, false)
        );
        assert!(res.output_tail.contains("port=41000"));
        assert!(res.output_tail.contains("oops"));
        // macOS tmpdir may resolve through /private.
        let wt_sh = sh_path(wt.path());
        let wt_sh = wt_sh.strip_prefix("/private").unwrap_or(&wt_sh);
        assert!(
            res.output_tail.contains(wt_sh),
            "{} in {}",
            wt_sh,
            res.output_tail
        );
        assert!(text(&chunks, Some(OutputStreamKind::Stdout)).contains("port=41000"));
        assert_eq!(text(&chunks, Some(OutputStreamKind::Stderr)), "oops\n");
        assert_eq!(r.running_count(), 0);
    }

    #[tokio::test]
    async fn non_zero_exit_is_a_result_not_an_error() {
        let wt = tempfile::tempdir().unwrap();
        let res = runner(2, None)
            .run(opts("echo FAIL; exit 3", wt.path()))
            .await
            .unwrap();
        assert_eq!(
            (
                res.exit_code,
                res.signal,
                res.timed_out,
                res.output_tail.as_str()
            ),
            (Some(3), None, false, "FAIL\n")
        );
    }

    #[tokio::test]
    async fn timeout_kills_the_whole_process_group_and_reports_timed_out() {
        let wt = tempfile::tempdir().unwrap();
        let r = runner(2, Some(200));
        let pid_file = wt.path().join("grandchild.pid");
        let started = Instant::now();
        // A grandchild that would outlive a plain child kill.
        let mut o = opts(
            &format!(
                "sleep 30 & {} > \"{}\"; echo started; wait",
                last_bg_pid(),
                sh_path(&pid_file)
            ),
            wt.path(),
        );
        o.timeout = Some(Duration::from_millis(300));
        let res = r.run(o).await.unwrap();
        assert_eq!((res.exit_code, res.timed_out), (None, true));
        // Windows: the 200 ms grace can end before the job is gone, so the escalation is reported.
        let sig = res.signal.as_deref().unwrap();
        if on_windows() {
            assert!(sig == "SIGTERM" || sig == "SIGKILL", "{sig}");
        } else {
            assert_eq!(sig, "SIGTERM");
        }
        assert_eq!(res.output_tail, "started\n");
        assert!(started.elapsed() < Duration::from_secs(5));
        let gpid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // The group (POSIX) or the job (Windows: the case TD-189 left alive in TS) takes it.
        wait_for(|| read_proc_info(gpid).is_none(), 5_000).await;
        assert_eq!(r.running_count(), 0);
    }

    #[tokio::test]
    async fn timeout_escalates_to_sigkill_when_sigterm_is_ignored() {
        // Windows has no grace step: the job is terminated at once (TS `skipIf(onWin32)`).
        if on_windows() {
            return;
        }
        let wt = tempfile::tempdir().unwrap();
        let r = runner(1, Some(200));
        let mut o = opts(
            "trap '' TERM; echo ready; while :; do sleep 0.05; done",
            wt.path(),
        );
        o.timeout = Some(Duration::from_millis(200));
        let res = r.run(o).await.unwrap();
        assert_eq!(
            (res.exit_code, res.signal.as_deref(), res.timed_out),
            (None, Some("SIGKILL"), true)
        );
    }

    #[tokio::test]
    async fn abort_ws_kill_terminates_a_running_command() {
        let wt = tempfile::tempdir().unwrap();
        let r = runner(1, Some(200));
        let token = CancelToken::new();
        let mut o = opts("echo go; sleep 30", wt.path());
        o.cancel = Some(token.clone());
        let chunks = record_output(&mut o);
        let p = r.run(o);
        wait_for(|| text(&chunks, None).contains("go"), 5_000).await;
        token.cancel();
        let res = p.await.unwrap();
        assert_eq!(
            (res.exit_code, res.signal.as_deref(), res.timed_out),
            (None, Some("SIGTERM"), false)
        );
        assert_eq!(r.running_count(), 0);
    }

    #[tokio::test]
    async fn semaphore_3_concurrent_requests_with_limit_2_queue_the_third() {
        let wt = tempfile::tempdir().unwrap();
        let r = runner(2, None);
        let gate = wt.path().join("gate");
        let cmd = |name: &str| {
            format!(
                "echo {name}; while [ ! -f \"{}\" ]; do sleep 0.02; done",
                sh_path(&gate)
            )
        };
        let mut runs = Vec::new();
        let mut waits = Vec::new();
        let mut outs = Vec::new();
        for name in ["a", "b", "c"] {
            let mut o = opts(&cmd(name), wt.path());
            waits.push(record_waits(&mut o));
            outs.push(record_output(&mut o));
            runs.push(r.run(o));
        }
        assert_eq!(r.running_count(), 2);
        assert_eq!(r.waiting_count(), 1);
        let w = |i: usize| waits[i].lock().unwrap().clone();
        assert_eq!((w(0), w(1), w(2)), (vec![], vec![], vec![true]));
        wait_for(
            || !text(&outs[0], None).is_empty() && !text(&outs[1], None).is_empty(),
            5_000,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(text(&outs[2], None), ""); // still queued: not spawned
        std::fs::write(&gate, "").unwrap();
        let mut codes = Vec::new();
        for run in runs {
            codes.push(run.await.unwrap().exit_code);
        }
        assert_eq!(codes, [Some(0), Some(0), Some(0)]);
        assert_eq!(w(2), [true, false]);
        assert_eq!(text(&outs[2], None), "c\n");
        assert_eq!(r.running_count(), 0);
        assert_eq!(r.waiting_count(), 0);
    }

    #[tokio::test]
    async fn aborting_a_queued_command_resolves_sigterm_without_spawning_or_taking_a_slot() {
        let wt = tempfile::tempdir().unwrap();
        let r = runner(1, None);
        let gate = wt.path().join("gate2");
        let a = r.run(opts(
            &format!("while [ ! -f \"{}\" ]; do sleep 0.02; done", sh_path(&gate)),
            wt.path(),
        ));
        let token = CancelToken::new();
        let mut ob = opts("echo should-not-run", wt.path());
        ob.cancel = Some(token.clone());
        let waits = record_waits(&mut ob);
        let out = record_output(&mut ob);
        let b = r.run(ob);
        token.cancel();
        let rb = b.await.unwrap();
        assert_eq!(
            (rb.exit_code, rb.signal.as_deref(), rb.duration_ms),
            (None, Some("SIGTERM"), 0)
        );
        assert_eq!(*waits.lock().unwrap(), [true]);
        assert_eq!(r.waiting_count(), 0);
        std::fs::write(&gate, "").unwrap();
        assert_eq!(a.await.unwrap().exit_code, Some(0));
        assert_eq!(text(&out, None), "");
        assert_eq!(r.running_count(), 0);
    }

    #[tokio::test]
    async fn keeps_only_the_last_tail_bytes_of_combined_output() {
        let wt = tempfile::tempdir().unwrap();
        let mut o = opts(
            "i=0; while [ $i -lt 100 ]; do echo line$i; i=$((i+1)); done",
            wt.path(),
        );
        o.tail_bytes = Some(20);
        let res = runner(1, None).run(o).await.unwrap();
        assert!(res.output_tail.len() <= 20);
        assert!(res.output_tail.ends_with("line99\n"), "{}", res.output_tail);
    }

    #[tokio::test]
    async fn defaults_the_tail_to_output_tail_bytes() {
        let wt = tempfile::tempdir().unwrap();
        let cmd = format!("head -c {} /dev/zero | tr '\\0' x", OUTPUT_TAIL_BYTES * 2);
        let res = runner(1, None).run(opts(&cmd, wt.path())).await.unwrap();
        assert_eq!(res.output_tail.len(), OUTPUT_TAIL_BYTES);
    }

    #[tokio::test]
    async fn fails_when_the_process_cannot_be_spawned_and_frees_the_slot() {
        let wt = tempfile::tempdir().unwrap();
        let r = runner(1, None);
        let err = r
            .run(opts("true", &wt.path().join("missing")))
            .await
            .unwrap_err();
        assert!(matches!(err, RunError::Spawn(_)), "{err:?}");
        assert_eq!(r.running_count(), 0);
        assert_eq!(
            r.run(opts("true", wt.path())).await.unwrap().exit_code,
            Some(0)
        );
    }

    #[test]
    fn utf8_decoder_keeps_a_split_character_for_the_next_chunk() {
        let mut d = Utf8Decoder::default();
        let bytes = "aé€".as_bytes(); // 1 + 2 + 3 bytes
        assert_eq!(d.write(&bytes[..2]), "a");
        assert_eq!(d.write(&bytes[2..4]), "é");
        assert_eq!(d.write(&bytes[4..]), "€");
        assert_eq!(d.end(), "");
    }

    #[test]
    fn utf8_decoder_replaces_invalid_bytes_and_flushes_an_incomplete_end() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.write(b"x\xffy\xe2\x82"), "x\u{fffd}y");
        assert_eq!(d.end(), "\u{fffd}");
        assert_eq!(d.write(b"\x80ok"), "\u{fffd}ok");
    }

    #[test]
    fn merge_env_overrides_by_name_case_insensitively_on_windows_only() {
        let base: Env = vec![
            ("Path".into(), "C:\\x".into()),
            ("PORT".into(), "1".into()),
            ("HOME".into(), "/h".into()),
        ];
        let mut over = BTreeMap::new();
        over.insert("PATH".to_string(), "/p".to_string());
        over.insert("PORT".to_string(), "2".to_string());
        let posix = merge_env(base.clone(), &over, Platform::Posix);
        assert_eq!(
            posix,
            vec![
                ("Path".to_string(), "C:\\x".to_string()),
                ("HOME".to_string(), "/h".to_string()),
                ("PATH".to_string(), "/p".to_string()),
                ("PORT".to_string(), "2".to_string()),
            ]
        );
        let win = merge_env(base, &over, Platform::Windows);
        assert_eq!(
            win,
            vec![
                ("HOME".to_string(), "/h".to_string()),
                ("PATH".to_string(), "/p".to_string()),
                ("PORT".to_string(), "2".to_string()),
            ]
        );
    }
}
