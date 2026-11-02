//! Port of `packages/daemon/src/commands/fake-runner.ts` (MR-T06): a scripted [`CommandRunner`]
//! for daemon-core tests (no processes).
//!
//! Results are scripted per `cmd` (default: exit 0). It honours the build semaphore
//! (`max_concurrent`), calling `on_waiting_for_slot(true/false)` only when a run actually waits,
//! streams the scripted output, and resolves a run with signal SIGTERM when its cancel token
//! fires. Runs finish when `release(cmd)` / `release_all()` is called, or at once with
//! `auto_release`. Callbacks are called with no lock held. Needs a tokio runtime (cancel watchers
//! and auto-release are spawned tasks).
//!
//! One difference from TS: a token already cancelled when `run` is called aborts the run (TS
//! adds an `abort` listener, which never fires for a signal that already aborted).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::oneshot;

use crate::commands::runner::{
    CommandOutputChunk, CommandResult, CommandRunner, OnWaitingForSlot, OutputStreamKind,
    RunCommandOptions, RunError, RunFuture,
};

/// `FakeCommandScript`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FakeCommandScript {
    /// `None` = exit 0; `Some(None)` = no exit code.
    pub exit_code: Option<Option<i32>>,
    pub timed_out: bool,
    pub output: Option<String>,
}

impl FakeCommandScript {
    pub fn exit(code: i32) -> Self {
        FakeCommandScript {
            exit_code: Some(Some(code)),
            ..Self::default()
        }
    }

    pub fn timed_out() -> Self {
        FakeCommandScript {
            timed_out: true,
            ..Self::default()
        }
    }

    pub fn output(mut self, text: impl Into<String>) -> Self {
        self.output = Some(text.into());
        self
    }
}

struct Pending {
    id: u64,
    opts: RunCommandOptions,
    finish: oneshot::Sender<CommandResult>,
}

#[derive(Default)]
struct State {
    calls: Vec<RunCommandOptions>,
    scripts: HashMap<String, FakeCommandScript>,
    queue: VecDeque<Pending>,
    /// In start order (the TS `Set`'s insertion order).
    running: Vec<Pending>,
    next_id: u64,
}

/// What to do once the lock is released.
enum Effect {
    Waiting(OnWaitingForSlot, bool),
    Output(crate::commands::runner::OnOutput, String),
    Finish(oneshot::Sender<CommandResult>, CommandResult),
    AutoRelease(u64),
}

struct Inner {
    max_concurrent: usize,
    auto_release: bool,
    state: Mutex<State>,
}

/// `FakeCommandRunner`.
#[derive(Clone)]
pub struct FakeCommandRunner(Arc<Inner>);

impl Default for FakeCommandRunner {
    fn default() -> Self {
        Self::new(2, false)
    }
}

impl FakeCommandRunner {
    pub fn new(max_concurrent: usize, auto_release: bool) -> Self {
        FakeCommandRunner(Arc::new(Inner {
            max_concurrent,
            auto_release,
            state: Mutex::new(State::default()),
        }))
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Script the result of `cmd`.
    pub fn script(self, cmd: impl Into<String>, s: FakeCommandScript) -> Self {
        self.st().scripts.insert(cmd.into(), s);
        self
    }

    /// Every `run`'s options, in order.
    pub fn calls(&self) -> Vec<RunCommandOptions> {
        self.st().calls.clone()
    }

    pub fn running_count(&self) -> usize {
        self.st().running.len()
    }

    /// Finish the oldest running command whose cmd matches. False if none.
    pub fn release(&self, cmd: &str) -> bool {
        let id = self
            .st()
            .running
            .iter()
            .find(|p| p.opts.cmd == cmd)
            .map(|p| p.id);
        match id {
            Some(id) => {
                self.end(id, false);
                true
            }
            None => false,
        }
    }

    pub fn release_all(&self) {
        let ids: Vec<u64> = self.st().running.iter().map(|p| p.id).collect();
        for id in ids {
            self.end(id, false);
        }
    }

    fn begin(&self, s: &mut State, p: Pending, effects: &mut Vec<Effect>) {
        let out = s.scripts.get(&p.opts.cmd).and_then(|sc| sc.output.clone());
        if let (Some(out), Some(cb)) = (out, p.opts.on_output.clone())
            && !out.is_empty()
        {
            effects.push(Effect::Output(cb, out));
        }
        if self.0.auto_release {
            effects.push(Effect::AutoRelease(p.id));
        }
        s.running.push(p);
    }

    fn end(&self, id: u64, abort: bool) {
        let mut effects = Vec::new();
        {
            let mut s = self.st();
            let p = if let Some(i) = s.running.iter().position(|p| p.id == id) {
                s.running.remove(i)
            } else if let Some(i) = s.queue.iter().position(|p| p.id == id) {
                s.queue.remove(i).expect("index from position")
            } else {
                return;
            };
            let sc = s.scripts.get(&p.opts.cmd).cloned().unwrap_or_default();
            let timed_out = !abort && sc.timed_out;
            let killed = abort || timed_out;
            effects.push(Effect::Finish(
                p.finish,
                CommandResult {
                    exit_code: if killed {
                        None
                    } else {
                        sc.exit_code.unwrap_or(Some(0))
                    },
                    signal: killed.then(|| "SIGTERM".to_string()),
                    timed_out,
                    duration_ms: 0,
                    output_tail: sc.output.unwrap_or_default(),
                },
            ));
            // Only a freed slot starts a waiter; ending a still-queued run (abort) frees none.
            if s.running.len() < self.0.max_concurrent
                && let Some(next) = s.queue.pop_front()
            {
                if let Some(cb) = next.opts.on_waiting_for_slot.clone() {
                    effects.push(Effect::Waiting(cb, false));
                }
                self.begin(&mut s, next, &mut effects);
            }
        }
        self.apply(effects);
    }

    fn apply(&self, effects: Vec<Effect>) {
        for e in effects {
            match e {
                Effect::Waiting(cb, w) => cb(w),
                Effect::Output(cb, text) => cb(CommandOutputChunk {
                    stream: OutputStreamKind::Stdout,
                    text,
                }),
                Effect::Finish(tx, r) => {
                    let _ = tx.send(r);
                }
                Effect::AutoRelease(id) => {
                    let me = self.clone();
                    tokio::spawn(async move { me.end(id, false) });
                }
            }
        }
    }
}

impl CommandRunner for FakeCommandRunner {
    fn max_concurrent(&self) -> usize {
        self.0.max_concurrent
    }

    fn run(&self, opts: RunCommandOptions) -> RunFuture<'_> {
        let (tx, rx) = oneshot::channel();
        let cancel = opts.cancel.clone();
        let mut effects = Vec::new();
        let id = {
            let mut s = self.st();
            s.calls.push(opts.clone());
            let id = s.next_id;
            s.next_id += 1;
            let p = Pending {
                id,
                opts,
                finish: tx,
            };
            if s.running.len() < self.0.max_concurrent {
                self.begin(&mut s, p, &mut effects);
            } else {
                if let Some(cb) = p.opts.on_waiting_for_slot.clone() {
                    effects.push(Effect::Waiting(cb, true));
                }
                s.queue.push_back(p);
            }
            id
        };
        self.apply(effects);
        if let Some(token) = cancel {
            let me = self.clone();
            tokio::spawn(async move {
                token.cancelled().await;
                me.end(id, true);
            });
        }
        Box::pin(async move { rx.await.map_err(|_| RunError::Gone) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::runner::CancelToken;
    use std::sync::atomic::{AtomicBool, Ordering};
    use uuid::Uuid;

    fn opts(cmd: &str) -> RunCommandOptions {
        RunCommandOptions::new(
            Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
            cmd,
            "/tmp/wt",
        )
    }

    fn recording_waits(o: &mut RunCommandOptions) -> Arc<Mutex<Vec<bool>>> {
        let waits = Arc::new(Mutex::new(Vec::new()));
        let w = waits.clone();
        o.on_waiting_for_slot = Some(Arc::new(move |b| w.lock().unwrap().push(b)));
        waits
    }

    #[tokio::test]
    async fn scripts_exit_codes_output_and_timeouts() {
        let r = FakeCommandRunner::new(2, true)
            .script("npm test", FakeCommandScript::exit(1).output("FAIL"))
            .script("slow", FakeCommandScript::timed_out());
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let mut o = opts("npm test");
        let c = chunks.clone();
        o.on_output = Some(Arc::new(move |ch| c.lock().unwrap().push(ch.text)));
        let t = r.run(o).await.unwrap();
        assert_eq!(
            (t.exit_code, t.timed_out, t.output_tail.as_str()),
            (Some(1), false, "FAIL")
        );
        assert_eq!(*chunks.lock().unwrap(), ["FAIL"]);
        let slow = r.run(opts("slow")).await.unwrap();
        assert_eq!((slow.exit_code, slow.timed_out), (None, true));
        assert_eq!(
            r.run(opts("npm run build")).await.unwrap().exit_code,
            Some(0)
        );
    }

    #[tokio::test]
    async fn queues_the_third_of_three_commands_with_limit_2_and_reports_build_slot() {
        let r = FakeCommandRunner::new(2, false);
        let a = r.run(opts("a"));
        let b = r.run(opts("b"));
        let mut oc = opts("c");
        let waits = recording_waits(&mut oc);
        let c = r.run(oc);
        assert_eq!(r.running_count(), 2);
        assert_eq!(*waits.lock().unwrap(), [true]);
        r.release("a");
        a.await.unwrap();
        assert_eq!(*waits.lock().unwrap(), [true, false]);
        assert_eq!(r.running_count(), 2);
        r.release_all();
        b.await.unwrap();
        c.await.unwrap();
        assert_eq!(r.running_count(), 0);
    }

    #[tokio::test]
    async fn resolves_with_sigterm_on_abort() {
        let r = FakeCommandRunner::new(1, false);
        let token = CancelToken::new();
        let mut o = opts("x");
        o.cancel = Some(token.clone());
        let p = r.run(o);
        token.cancel();
        let res = p.await.unwrap();
        assert_eq!(
            (res.exit_code, res.signal.as_deref(), res.timed_out),
            (None, Some("SIGTERM"), false)
        );
    }

    #[tokio::test]
    async fn aborting_a_queued_run_keeps_the_next_waiter_queued_until_a_slot_frees() {
        let r = FakeCommandRunner::new(1, false);
        let token = CancelToken::new();
        let a = r.run(opts("a"));
        let mut ob = opts("b");
        ob.cancel = Some(token.clone());
        let b = r.run(ob);
        let mut oc = opts("c");
        let c_waits = recording_waits(&mut oc);
        let c_done = Arc::new(AtomicBool::new(false));
        let c = {
            let fut = r.run(oc);
            let done = c_done.clone();
            // The TS `.then(() => cDone = true)`; boxed futures borrow the runner, so drive it here.
            async move {
                let res = fut.await;
                done.store(true, Ordering::SeqCst);
                res
            }
        };
        tokio::pin!(c);
        token.cancel();
        let rb = b.await.unwrap();
        assert_eq!(
            (rb.exit_code, rb.signal.as_deref()),
            (None, Some("SIGTERM"))
        );
        assert_eq!(r.running_count(), 1);
        assert_eq!(*c_waits.lock().unwrap(), [true]);
        r.release("a");
        a.await.unwrap();
        assert_eq!(r.running_count(), 1);
        assert_eq!(*c_waits.lock().unwrap(), [true, false]);
        // c is running, not finished: polling it now must not complete it.
        assert!(futures_util::poll!(c.as_mut()).is_pending());
        assert!(!c_done.load(Ordering::SeqCst));
        assert!(r.release("c"));
        let rc = c.await.unwrap();
        assert_eq!((rc.exit_code, rc.signal), (Some(0), None));
        assert_eq!(r.running_count(), 0);
    }
}
