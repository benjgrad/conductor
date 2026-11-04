//! Port of `packages/daemon/src/claude/fake-driver.ts` (MR-T06): an in-memory, scripted
//! [`ClaudeDriver`] for unit tests of daemon logic above the driver (ADR-0005 §Fake Claude). The
//! process-boundary fake for e2e (`CONDUCTOR_CLAUDE_BIN`) stays `fake-claude.mjs`.
//!
//! Model: each user message (the start prompt, then every `send_input`) runs the next scripted
//! turn for that `claude_session_id`. Turn state and the cumulative cost are keyed by
//! `claude_session_id`, so a `resume: true` start continues the script and the spend total, as the
//! real CLI does. Every turn ends with `spend` (cumulative) then `turn_end`, unless the turn crashed
//! the process.
//!
//! TS defers each step to a microtask. Here each session has a FIFO step queue drained by one
//! spawned tokio task, so steps run in the order they were queued whatever the runtime, and
//! [`FakeDriverSession::idle`] waits until the queue is empty (the TS tests' `flush()`). The task
//! may run on another thread before the caller attaches a listener, so, as `CliDriverSession`
//! does, events emitted before the first listener are held and handed to it when it is attached
//! (MR-T12: the daemon core runs on the multi-threaded runtime). Needs a tokio runtime.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime};

use conductor_protocol::JsonObject;
use tokio::sync::Notify;

use crate::claude::driver::{
    ClaudeDriver, DriverError, DriverEvent, DriverListener, DriverSession, DriverStartOptions,
    ListenerId, Listeners, OutputStream, PermissionDecision, PermissionResolution, QuestionOptions,
    Usage,
};
use crate::claude::outcome_server::{
    PERMISSION_SESSION_ENDED, PermissionReply, iso_string, permission_reply, refuse_transition,
};

/// One scripted action of a turn.
#[derive(Clone, Debug, PartialEq)]
pub enum FakeTurnAction {
    Say(String),
    /// Questions UX: the question and the options the outcome server would forward.
    AskUser(String, Option<QuestionOptions>),
    /// ADR-0011: `transition` / `reason` as the agent names them. With `opts.transitions`, the
    /// first unknown name is refused like the outcome server does (a debug line, not emitted).
    CompleteState {
        result: serde_json::Map<String, serde_json::Value>,
        transition: Option<String>,
        reason: Option<String>,
    },
    /// Emit an arbitrary event (e.g. tool_use output).
    Emit(DriverEvent),
    /// The process dies mid-turn: emits `exit` and nothing after it.
    Crash {
        code: Option<i32>,
        signal: Option<String>,
    },
    /// ADR-0007: the turn pauses until a `send_message` arrives, then the rest of it plays.
    AwaitMessage,
    /// ADR-0023: Claude calls the permission prompt tool: emits `permission_request` and the call
    /// is held (the turn goes on, unlike the real CLI; tests read `permission_replies`).
    Permission {
        request_id: String,
        tool: String,
        input: JsonObject,
    },
}

impl FakeTurnAction {
    /// `{completeState: result}` with no transition or reason.
    pub fn complete(result: serde_json::Value) -> Self {
        FakeTurnAction::CompleteState {
            result: match result {
                serde_json::Value::Object(m) => m,
                other => panic!("complete_state result must be an object, got {other}"),
            },
            transition: None,
            reason: None,
        }
    }

    pub fn say(text: impl Into<String>) -> Self {
        FakeTurnAction::Say(text.into())
    }

    pub fn ask_user(question: impl Into<String>) -> Self {
        FakeTurnAction::AskUser(question.into(), None)
    }

    /// Questions UX: `ask_user` with (already bounded) options.
    pub fn ask_user_with_options(question: impl Into<String>, options: QuestionOptions) -> Self {
        FakeTurnAction::AskUser(question.into(), Some(options))
    }

    pub fn crash(code: Option<i32>) -> Self {
        FakeTurnAction::Crash { code, signal: None }
    }
}

/// A function of the user message that started the turn (`$answer`).
pub type FakeTurnFn = Arc<dyn Fn(&str) -> Vec<FakeTurnAction> + Send + Sync>;

/// Static actions, or a function of the user message.
#[derive(Clone)]
pub enum FakeTurn {
    Static(Vec<FakeTurnAction>),
    Dynamic(FakeTurnFn),
}

impl FakeTurn {
    pub fn dynamic(f: impl Fn(&str) -> Vec<FakeTurnAction> + Send + Sync + 'static) -> Self {
        FakeTurn::Dynamic(Arc::new(f))
    }

    fn actions(&self, input: &str) -> Vec<FakeTurnAction> {
        match self {
            FakeTurn::Static(a) => a.clone(),
            FakeTurn::Dynamic(f) => f(input),
        }
    }
}

impl From<Vec<FakeTurnAction>> for FakeTurn {
    fn from(a: Vec<FakeTurnAction>) -> Self {
        FakeTurn::Static(a)
    }
}

/// `FakeClaudeScript`.
#[derive(Clone)]
pub struct FakeClaudeScript {
    pub turns: Vec<FakeTurn>,
    /// Added to the cumulative total each turn. Default 0.01.
    pub cost_per_turn_usd: f64,
}

impl FakeClaudeScript {
    pub fn new(turns: Vec<FakeTurn>) -> Self {
        FakeClaudeScript {
            turns,
            cost_per_turn_usd: 0.01,
        }
    }

    pub fn cost_per_turn(mut self, usd: f64) -> Self {
        self.cost_per_turn_usd = usd;
        self
    }
}

#[derive(Debug, Default)]
struct Track {
    turn: usize,
    total_usd: f64,
}

type ScriptFn = Arc<dyn Fn(&DriverStartOptions) -> FakeClaudeScript + Send + Sync>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `FakeClaudeDriver`.
pub struct FakeClaudeDriver {
    script: ScriptFn,
    starts: Mutex<Vec<DriverStartOptions>>,
    sessions: Mutex<Vec<Arc<FakeDriverSession>>>,
    tracks: Mutex<HashMap<String, Arc<Mutex<Track>>>>,
}

impl FakeClaudeDriver {
    /// The same script for every start.
    pub fn new(script: FakeClaudeScript) -> Self {
        Self::with(move |_| script.clone())
    }

    /// A script chosen per start.
    pub fn with(
        script: impl Fn(&DriverStartOptions) -> FakeClaudeScript + Send + Sync + 'static,
    ) -> Self {
        FakeClaudeDriver {
            script: Arc::new(script),
            starts: Mutex::new(Vec::new()),
            sessions: Mutex::new(Vec::new()),
            tracks: Mutex::new(HashMap::new()),
        }
    }

    /// Start a session (the concrete type; [`ClaudeDriver::start`] returns it as a trait object).
    pub fn start_fake(&self, opts: DriverStartOptions) -> Arc<FakeDriverSession> {
        lock(&self.starts).push(opts.clone());
        let track = {
            let mut tracks = lock(&self.tracks);
            match tracks.get(&opts.claude_session_id) {
                Some(t) if opts.resume => t.clone(),
                _ => {
                    let t = Arc::new(Mutex::new(Track::default()));
                    tracks.insert(opts.claude_session_id.clone(), t.clone());
                    t
                }
            }
        };
        let script = (self.script)(&opts);
        let session = FakeDriverSession::new(opts, script, track);
        lock(&self.sessions).push(session.clone());
        session
    }

    /// Every start's options, in order.
    pub fn starts(&self) -> Vec<DriverStartOptions> {
        lock(&self.starts).clone()
    }

    pub fn sessions(&self) -> Vec<Arc<FakeDriverSession>> {
        lock(&self.sessions).clone()
    }

    /// The most recent session.
    pub fn last(&self) -> Option<Arc<FakeDriverSession>> {
        lock(&self.sessions).last().cloned()
    }
}

impl ClaudeDriver for FakeClaudeDriver {
    fn start(&self, opts: DriverStartOptions) -> Result<Arc<dyn DriverSession>, DriverError> {
        Ok(self.start_fake(opts))
    }
}

/// A turn paused at `AwaitMessage`: the actions, where to go on, and whether the script was
/// exhausted.
type Paused = (Vec<FakeTurnAction>, usize, bool);

enum Step {
    RunTurn(String),
    Resume(Paused),
    Exit(Option<i32>, Option<String>),
}

#[derive(Default)]
struct State {
    events: Vec<DriverEvent>,
    inputs: Vec<String>,
    messages: Vec<String>,
    paused: Option<Paused>,
    ended: bool,
    killed: bool,
    kill_calls: u32,
    pid: Option<u32>,
    exited: bool,
    permission_replies: HashMap<String, PermissionReply>,
    held_permissions: Vec<(String, JsonObject)>,
    decided_permissions: HashSet<String>,
    init_sent: bool,
    ask_pending: bool,
    completed: bool,
    nudged: bool,
    steps: VecDeque<Step>,
    pumping: bool,
    /// Events emitted before the first listener; None once one is attached.
    pending: Option<Vec<DriverEvent>>,
}

/// `FakeDriverSession`.
pub struct FakeDriverSession {
    claude_session_id: String,
    opts: DriverStartOptions,
    script: FakeClaudeScript,
    track: Arc<Mutex<Track>>,
    state: Mutex<State>,
    listeners: Listeners,
    /// Serialises deliveries (the pump's and the first listener's backlog), so listeners see
    /// events in order. Taken before `state`, never the other way round.
    delivery: Mutex<()>,
    idle: Notify,
    /// The `Arc` this session lives in (`start` returns it), for the queue's spawned task.
    this: Weak<FakeDriverSession>,
}

impl FakeDriverSession {
    fn new(
        opts: DriverStartOptions,
        script: FakeClaudeScript,
        track: Arc<Mutex<Track>>,
    ) -> Arc<Self> {
        let s = Arc::new_cyclic(|this| FakeDriverSession {
            claude_session_id: opts.claude_session_id.clone(),
            script,
            track,
            state: Mutex::new(State {
                pending: Some(Vec::new()),
                ..State::default()
            }),
            listeners: Listeners::default(),
            delivery: Mutex::new(()),
            idle: Notify::new(),
            this: this.clone(),
            opts,
        });
        let prompt = s.opts.prompt.clone();
        s.queue(Step::RunTurn(prompt));
        s
    }

    fn st(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    pub fn opts(&self) -> &DriverStartOptions {
        &self.opts
    }

    /// Every event emitted, in order.
    pub fn events(&self) -> Vec<DriverEvent> {
        self.st().events.clone()
    }

    /// Every `send_input` text, in order.
    pub fn inputs(&self) -> Vec<String> {
        self.st().inputs.clone()
    }

    /// Every `send_message` text, in order (ADR-0007).
    pub fn messages(&self) -> Vec<String> {
        self.st().messages.clone()
    }

    pub fn ended(&self) -> bool {
        self.st().ended
    }

    pub fn killed(&self) -> bool {
        self.st().killed
    }

    /// How many times `kill()` was called (BUG-1: the daemon kills a process once).
    pub fn kill_calls(&self) -> u32 {
        self.st().kill_calls
    }

    pub fn exited(&self) -> bool {
        self.st().exited
    }

    /// BUG-1: tests may set a pid to be persisted (none by default: there is no OS process).
    pub fn set_pid(&self, pid: Option<u32>) {
        self.st().pid = pid;
    }

    /// ADR-0023: the reply each held permission prompt got, by request id.
    pub fn permission_replies(&self) -> HashMap<String, PermissionReply> {
        self.st().permission_replies.clone()
    }

    /// ADR-0023: the request ids still held, in the order they were requested.
    pub fn pending_permissions(&self) -> Vec<String> {
        self.st()
            .held_permissions
            .iter()
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Resolve once every queued step has run (the TS tests' `flush()`).
    pub async fn idle(&self) {
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let s = self.st();
                if !s.pumping && s.steps.is_empty() {
                    return;
                }
            }
            notified.await;
        }
    }

    fn queue(&self, step: Step) {
        let start = {
            let mut s = self.st();
            s.steps.push_back(step);
            !std::mem::replace(&mut s.pumping, true)
        };
        if start && let Some(me) = self.this.upgrade() {
            tokio::spawn(async move { me.pump() });
        }
    }

    fn pump(&self) {
        loop {
            let step = {
                let mut s = self.st();
                match s.steps.pop_front() {
                    Some(step) => step,
                    None => {
                        s.pumping = false;
                        drop(s);
                        self.idle.notify_waiters();
                        return;
                    }
                }
            };
            let _order = lock(&self.delivery);
            let out = {
                let mut s = self.st();
                let mut out = Vec::new();
                self.run_step(&mut s, step, &mut out);
                match s.pending.as_mut() {
                    Some(held) => {
                        held.extend(out);
                        continue;
                    }
                    None => out,
                }
            };
            for ev in &out {
                self.listeners.emit(ev);
            }
        }
    }

    fn run_step(&self, s: &mut State, step: Step, out: &mut Vec<DriverEvent>) {
        match step {
            Step::Exit(code, signal) => self.exit(s, code, signal, out),
            Step::Resume((actions, from, exhausted)) => self.play(s, actions, from, exhausted, out),
            Step::RunTurn(input) => {
                if s.exited {
                    return;
                }
                if !s.init_sent {
                    s.init_sent = true;
                    Self::emit(
                        s,
                        out,
                        DriverEvent::ClaudeSessionId {
                            id: self.claude_session_id.clone(),
                        },
                    );
                }
                let turn = {
                    let mut t = lock(&self.track);
                    let i = t.turn;
                    t.turn += 1;
                    self.script.turns.get(i).cloned()
                };
                let exhausted = turn.is_none();
                let actions = turn.map(|t| t.actions(&input)).unwrap_or_default();
                if exhausted {
                    Self::emit(s, out, debug("fake claude: script exhausted"));
                }
                self.play(s, actions, 0, exhausted, out);
            }
        }
    }

    fn emit(s: &mut State, out: &mut Vec<DriverEvent>, ev: DriverEvent) {
        if s.exited {
            return;
        }
        s.events.push(ev.clone());
        out.push(ev);
    }

    fn exit(
        &self,
        s: &mut State,
        code: Option<i32>,
        signal: Option<String>,
        out: &mut Vec<DriverEvent>,
    ) {
        if s.exited {
            return;
        }
        for (id, _) in std::mem::take(&mut s.held_permissions) {
            s.permission_replies.insert(
                id,
                PermissionReply::Deny {
                    message: PERMISSION_SESSION_ENDED.into(),
                },
            );
        }
        Self::emit(s, out, DriverEvent::Exit { code, signal });
        s.exited = true;
    }

    fn play(
        &self,
        s: &mut State,
        actions: Vec<FakeTurnAction>,
        from: usize,
        exhausted: bool,
        out: &mut Vec<DriverEvent>,
    ) {
        if s.exited {
            return;
        }
        for i in from..actions.len() {
            match &actions[i] {
                FakeTurnAction::Crash { code, signal } => {
                    self.exit(s, *code, signal.clone(), out);
                    return;
                }
                FakeTurnAction::AwaitMessage => {
                    s.paused = Some((actions, i + 1, exhausted));
                    return;
                }
                a => self.act(s, a.clone(), out),
            }
        }
        let total_usd = {
            let mut t = lock(&self.track);
            t.total_usd += self.script.cost_per_turn_usd;
            t.total_usd
        };
        Self::emit(
            s,
            out,
            DriverEvent::Spend {
                total_usd,
                usage: Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
            },
        );
        Self::emit(
            s,
            out,
            DriverEvent::TurnEnd {
                is_error: exhausted,
                subtype: if exhausted {
                    "error_during_execution"
                } else {
                    "success"
                }
                .into(),
                permission_denials: 0,
            },
        );
    }

    fn act(&self, s: &mut State, a: FakeTurnAction, out: &mut Vec<DriverEvent>) {
        match a {
            FakeTurnAction::Say(text) => Self::emit(
                s,
                out,
                DriverEvent::Output {
                    stream: OutputStream::Assistant,
                    text,
                },
            ),
            FakeTurnAction::Permission {
                request_id,
                tool,
                input,
            } => {
                s.held_permissions.push((request_id.clone(), input.clone()));
                let expires_at = iso_string(SystemTime::now() + Duration::from_secs(30 * 60));
                Self::emit(
                    s,
                    out,
                    DriverEvent::PermissionRequest {
                        request_id,
                        tool,
                        input,
                        suggestions: None,
                        tool_use_id: None,
                        expires_at,
                    },
                );
            }
            FakeTurnAction::Emit(ev) => Self::emit(s, out, ev),
            FakeTurnAction::AskUser(question, options) => {
                s.ask_pending = true;
                Self::emit(s, out, DriverEvent::AskUser { question, options });
            }
            FakeTurnAction::CompleteState {
                result,
                transition,
                reason,
            } => {
                if s.completed || s.ask_pending {
                    // ADR-0005 outcome-server guard: a second complete_state, or one while a
                    // question is pending, gets a corrective tool result and is not emitted.
                    Self::emit(s, out, debug("complete_state refused"));
                } else if refuse_transition(
                    self.opts.transitions.as_deref(),
                    transition.as_deref(),
                    s.nudged,
                ) {
                    s.nudged = true;
                    let name = transition.as_deref().unwrap_or("(none)");
                    Self::emit(
                        s,
                        out,
                        debug(&format!(
                            "complete_state refused: unknown transition {name}"
                        )),
                    );
                } else {
                    s.completed = true;
                    Self::emit(
                        s,
                        out,
                        DriverEvent::CompleteState {
                            result,
                            transition,
                            reason,
                        },
                    );
                }
            }
            // Handled in `play`.
            FakeTurnAction::Crash { .. } | FakeTurnAction::AwaitMessage => {}
        }
    }
}

fn debug(text: &str) -> DriverEvent {
    DriverEvent::Output {
        stream: OutputStream::Debug,
        text: text.to_string(),
    }
}

impl DriverSession for FakeDriverSession {
    fn claude_session_id(&self) -> String {
        self.claude_session_id.clone()
    }

    fn pid(&self) -> Option<u32> {
        self.st().pid
    }

    fn on(&self, listener: DriverListener) -> ListenerId {
        // Only the first attach has a backlog; later ones (maybe from inside a listener, which
        // runs under `delivery`) must not take the delivery lock.
        if self.st().pending.is_none() {
            return self.listeners.add(listener);
        }
        let _order = lock(&self.delivery);
        let (id, backlog) = {
            let mut s = self.st();
            let backlog = s.pending.take().unwrap_or_default();
            (self.listeners.add(listener.clone()), backlog)
        };
        for ev in &backlog {
            listener(ev);
        }
        id
    }

    fn off(&self, id: ListenerId) {
        self.listeners.remove(id);
    }

    fn send_input(&self, text: &str) -> Result<(), DriverError> {
        {
            let mut s = self.st();
            if s.exited {
                return Err(DriverError::Exited);
            }
            s.inputs.push(text.to_string());
            s.ask_pending = false;
        }
        self.queue(Step::RunTurn(text.to_string()));
        Ok(())
    }

    fn send_message(&self, text: &str) -> Result<(), DriverError> {
        let resume = {
            let mut s = self.st();
            if s.exited {
                return Err(DriverError::Exited);
            }
            s.messages.push(text.to_string());
            s.paused.take()
        };
        if let Some(p) = resume {
            self.queue(Step::Resume(p));
        }
        Ok(())
    }

    fn resolve_permission(&self, request_id: &str, d: PermissionDecision) -> PermissionResolution {
        let mut s = self.st();
        let Some(i) = s
            .held_permissions
            .iter()
            .position(|(id, _)| id == request_id)
        else {
            return if s.decided_permissions.contains(request_id) {
                PermissionResolution::Duplicate
            } else {
                PermissionResolution::Unknown
            };
        };
        let (id, input) = s.held_permissions.remove(i);
        s.decided_permissions.insert(id.clone());
        s.permission_replies
            .insert(id, permission_reply(&input, &d));
        PermissionResolution::Resolved
    }

    fn deny_permission(&self, request_id: &str, message: &str) -> bool {
        let mut s = self.st();
        let Some(i) = s
            .held_permissions
            .iter()
            .position(|(id, _)| id == request_id)
        else {
            return false;
        };
        let (id, _) = s.held_permissions.remove(i);
        s.permission_replies.insert(
            id,
            PermissionReply::Deny {
                message: message.to_string(),
            },
        );
        true
    }

    fn end(&self) {
        {
            let mut s = self.st();
            if s.exited {
                return;
            }
            s.ended = true;
        }
        self.queue(Step::Exit(Some(0), None));
    }

    fn kill(&self, _grace: Option<Duration>) {
        {
            let mut s = self.st();
            s.kill_calls += 1;
            if s.exited {
                return;
            }
            s.killed = true;
        }
        self.queue(Step::Exit(None, Some("SIGTERM".into())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::driver::ToolPolicy;
    use conductor_protocol::{AgentTransitionOption, PermissionBehavior, PermissionScope};
    use serde_json::json;

    fn opts() -> DriverStartOptions {
        DriverStartOptions::new(
            "/tmp/wt",
            "implement the ticket",
            ToolPolicy {
                builtin: vec!["Read".into(), "Edit".into()],
                allow: vec!["Edit(./**)".into()],
                deny: vec!["Bash(git push:*)".into()],
            },
            "3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19",
            false,
        )
    }

    fn kinds(evs: &[DriverEvent]) -> Vec<&'static str> {
        evs.iter().map(DriverEvent::kind).collect()
    }

    fn collect(s: &FakeDriverSession) -> Arc<Mutex<Vec<DriverEvent>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        s.on(Arc::new(move |e: &DriverEvent| {
            sink.lock().unwrap().push(e.clone())
        }));
        seen
    }

    fn complete(result: serde_json::Value) -> DriverEvent {
        let FakeTurnAction::CompleteState {
            result,
            transition,
            reason,
        } = FakeTurnAction::complete(result)
        else {
            unreachable!()
        };
        DriverEvent::CompleteState {
            result,
            transition,
            reason,
        }
    }

    #[tokio::test]
    async fn runs_ask_user_live_answer_complete_state_then_exits_0_on_end() {
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![
                FakeTurnAction::say("looking"),
                FakeTurnAction::ask_user("Which DB?"),
            ]
            .into(),
            FakeTurn::dynamic(|answer| vec![FakeTurnAction::complete(json!({ "db": answer }))]),
        ]));
        let s = driver.start(opts()).unwrap();
        let fake = driver.last().unwrap();
        let seen = collect(&fake);
        fake.idle().await;
        assert_eq!(
            kinds(&seen.lock().unwrap()),
            [
                "claude_session_id",
                "output",
                "ask_user",
                "spend",
                "turn_end"
            ]
        );

        s.send_input("postgres").unwrap();
        fake.idle().await;
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .find(|e| e.kind() == "complete_state"),
            Some(&complete(json!({"db": "postgres"})))
        );
        s.end();
        fake.idle().await;
        assert_eq!(
            seen.lock().unwrap().last(),
            Some(&DriverEvent::Exit {
                code: Some(0),
                signal: None
            })
        );
        assert_eq!(s.send_input("late"), Err(DriverError::Exited));
    }

    #[tokio::test]
    async fn continues_the_script_and_cumulative_spend_on_resume() {
        let driver = FakeClaudeDriver::new(
            FakeClaudeScript::new(vec![
                vec![FakeTurnAction::ask_user("q?")].into(),
                FakeTurn::dynamic(|a| vec![FakeTurnAction::complete(json!({ "a": a }))]),
            ])
            .cost_per_turn(0.5),
        );
        let s1 = driver.start_fake(opts());
        s1.idle().await;
        s1.kill(None);
        s1.idle().await;
        assert_eq!(
            s1.events().last(),
            Some(&DriverEvent::Exit {
                code: None,
                signal: Some("SIGTERM".into())
            })
        );

        let s2 = driver.start_fake(DriverStartOptions {
            resume: true,
            prompt: "yes".into(),
            ..opts()
        });
        s2.idle().await;
        let evs = s2.events();
        assert!(evs.contains(&complete(json!({"a": "yes"}))));
        let spend = evs.iter().find_map(|e| match e {
            DriverEvent::Spend { total_usd, .. } => Some(*total_usd),
            _ => None,
        });
        assert_eq!(spend, Some(1.0));
    }

    #[tokio::test]
    async fn refuses_complete_state_while_a_question_is_pending_and_a_second_one() {
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![
                FakeTurnAction::ask_user("q?"),
                FakeTurnAction::complete(json!({"x": 1})),
            ]
            .into(),
            vec![
                FakeTurnAction::complete(json!({"x": 2})),
                FakeTurnAction::complete(json!({"x": 3})),
            ]
            .into(),
        ]));
        let s = driver.start_fake(opts());
        s.idle().await;
        s.send_input("a").unwrap();
        s.idle().await;
        let outcomes: Vec<DriverEvent> = s
            .events()
            .into_iter()
            .filter(|e| e.kind() == "complete_state")
            .collect();
        assert_eq!(outcomes, vec![complete(json!({"x": 2}))]);
    }

    #[tokio::test]
    async fn models_a_crash_mid_turn() {
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![FakeTurnAction::say("hi"), FakeTurnAction::crash(Some(1))].into(),
        ]));
        let s = driver.start_fake(opts());
        s.idle().await;
        assert_eq!(kinds(&s.events()), ["claude_session_id", "output", "exit"]);
        assert_eq!(driver.starts().len(), 1);
    }

    // Rust-only cases below: behaviour the TS fake has but its test file doesn't cover.

    #[tokio::test]
    async fn an_exhausted_script_ends_the_turn_with_an_error() {
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![]));
        let s = driver.start_fake(opts());
        s.idle().await;
        let evs = s.events();
        assert_eq!(
            kinds(&evs),
            ["claude_session_id", "output", "spend", "turn_end"]
        );
        assert_eq!(evs[1], debug("fake claude: script exhausted"));
        assert_eq!(
            evs[3],
            DriverEvent::TurnEnd {
                is_error: true,
                subtype: "error_during_execution".into(),
                permission_denials: 0
            }
        );
    }

    #[tokio::test]
    async fn refuses_an_unknown_transition_once_then_emits_the_next() {
        let named = |t: &str| FakeTurnAction::CompleteState {
            result: serde_json::Map::new(),
            transition: Some(t.into()),
            reason: Some("why".into()),
        };
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![named("nope"), named("also_nope")].into(),
        ]));
        let transitions: Vec<AgentTransitionOption> = vec![
            serde_json::from_value(json!({"name": "plan_ready", "when": null, "question": false}))
                .unwrap(),
        ];
        let s = driver.start_fake(DriverStartOptions {
            transitions: Some(transitions),
            ..opts()
        });
        s.idle().await;
        let evs = s.events();
        assert!(evs.contains(&debug("complete_state refused: unknown transition nope")));
        assert!(evs.contains(&DriverEvent::CompleteState {
            result: serde_json::Map::new(),
            transition: Some("also_nope".into()),
            reason: Some("why".into())
        }));
    }

    #[tokio::test]
    async fn holds_permission_prompts_until_decided_and_denies_the_rest_at_exit() {
        let input: JsonObject = serde_json::from_value(json!({"command": "ls"})).unwrap();
        let perm = |id: &str| FakeTurnAction::Permission {
            request_id: id.into(),
            tool: "Bash".into(),
            input: input.clone(),
        };
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![perm("r1"), perm("r2")].into(),
        ]));
        let s = driver.start_fake(opts());
        s.idle().await;
        assert_eq!(s.pending_permissions(), ["r1", "r2"]);
        let DriverEvent::PermissionRequest { expires_at, .. } = &s.events()[1] else {
            panic!("permission_request expected")
        };
        assert!(
            expires_at.ends_with('Z') && expires_at.len() == 24,
            "{expires_at}"
        );

        let allow = PermissionDecision {
            behavior: PermissionBehavior::Allow,
            scope: PermissionScope::Once,
            message: None,
            rule: None,
        };
        assert_eq!(
            s.resolve_permission("r1", allow.clone()),
            PermissionResolution::Resolved
        );
        assert_eq!(
            s.resolve_permission("r1", allow.clone()),
            PermissionResolution::Duplicate
        );
        assert_eq!(
            s.resolve_permission("zz", allow),
            PermissionResolution::Unknown
        );
        assert!(!s.deny_permission("zz", "no"));

        s.kill(None);
        s.idle().await;
        assert_eq!(s.kill_calls(), 1);
        assert!(s.pending_permissions().is_empty());
        let replies = s.permission_replies();
        assert_eq!(
            replies["r1"],
            PermissionReply::Allow {
                updated_input: input,
                updated_permissions: None
            }
        );
        assert_eq!(
            replies["r2"],
            PermissionReply::Deny {
                message: PERMISSION_SESSION_ENDED.into()
            }
        );
        s.kill(None);
        assert_eq!(s.kill_calls(), 2);
    }

    #[tokio::test]
    async fn await_message_pauses_the_turn_until_send_message() {
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![
                FakeTurnAction::say("before"),
                FakeTurnAction::AwaitMessage,
                FakeTurnAction::say("after"),
            ]
            .into(),
        ]));
        let s = driver.start_fake(opts());
        s.idle().await;
        assert_eq!(kinds(&s.events()), ["claude_session_id", "output"]);
        s.send_message("/compact").unwrap();
        s.idle().await;
        assert_eq!(
            kinds(&s.events()),
            ["claude_session_id", "output", "output", "spend", "turn_end"]
        );
        assert_eq!(s.messages(), ["/compact"]);
        assert!(s.inputs().is_empty());
    }

    #[tokio::test]
    async fn a_listener_may_answer_from_inside_the_callback() {
        let driver = FakeClaudeDriver::new(FakeClaudeScript::new(vec![
            vec![FakeTurnAction::ask_user("q?")].into(),
            FakeTurn::dynamic(|a| vec![FakeTurnAction::complete(json!({ "a": a }))]),
        ]));
        let s = driver.start_fake(opts());
        let weak = Arc::downgrade(&s);
        s.on(Arc::new(move |e: &DriverEvent| {
            if let (DriverEvent::AskUser { .. }, Some(s)) = (e, weak.upgrade()) {
                s.send_input("from the listener").unwrap();
            }
        }));
        s.idle().await;
        assert!(
            s.events()
                .contains(&complete(json!({"a": "from the listener"})))
        );
    }
}
