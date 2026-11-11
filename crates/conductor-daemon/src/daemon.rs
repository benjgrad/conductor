//! Port of `packages/daemon/src/daemon.ts` (MR-T12): the daemon core (M1-T05; 03 §Daemon ↔
//! orchestrator, 07, 10-contracts, ADR-0005).
//!
//! One outbound WS. On every (re)connect: `register` → wait for `registered` → replay buffered
//! durable messages after `registered.last_seq` → heartbeat, inventory (M2-T10), repo_inventory,
//! request_work. Commands (`start_session`, `run_cmd`, `run_action`, `send_input`,
//! `send_message`, `kill`, `permission_decision`) are deduped on command_id (persisted with the
//! ack they got, so a re-sent command is re-acked, never re-run). The Claude driver (ADR-0005)
//! and the command runner are injected.
//!
//! **Concurrency.** The TS class relies on the event loop for mutual exclusion; here one
//! `std::sync::Mutex<State>` plays that part. Every entry point (a WS frame, a driver event, a
//! timer, the end of an async step) locks it for one synchronous section, exactly where the TS
//! code runs without an `await`. The lock is never held across an `.await`. Lock order: state,
//! then the store (the workspace locks the store alone, from async tasks only). Driver listeners
//! never lock it: they queue each process's events for one task that handles them in order.
//!
//! **ADR-0033 P2 (FR-4, Rust only).** `register.features` advertises `assistant_job`. An
//! `assistant_job` is deduped like a command, admitted to the light slot (or refused
//! `light_slot_busy`), run by [`AssistantJobRunner`], and its `assistant_result` is a durable
//! machine-level message (buffered, sequenced and replayed like a session_event). A job never
//! counts toward `max_sessions` or `free_slots`.
//!
//! No OS `cfg` here (tests/seam.rs).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::attachments;
use conductor_protocol::tool_policy::resolve_tool_policy;
use conductor_protocol::{
    AssistantJobPayload, DAEMON_AUTH_HEADER, DAEMON_FEATURE_AGENT_ATTACHMENTS,
    DAEMON_FEATURE_ASSISTANT_JOB, DAEMON_FEATURE_PAGES, DAEMON_FEATURE_PERMISSION_MODE,
    DAEMON_FEATURE_TICKET_ATTACHMENTS, DaemonToOrchestrator, EvaluateConditionsArgs, KillPayload,
    NO_CONVERSATION_REASON, NO_OUTCOME_OUTPUT_CHARS, OrchestratorToDaemon, PROTOCOL_VERSION,
    PermissionDecisionPayload, RunActionPayload, RunActionPayloadAction, RunCmdPayload,
    STDERR_TAIL_CHARS, STDERR_TAIL_LINES, SendInputPayload, SendMessagePayload,
    SessionEventPayload, StartSessionPayload, TranscriptPayload, auth::daemon_auth_header_value,
};
use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::actions::checkout::{
    BaseCheckoutInput, BaseProbeNext, FreshCheckout, FreshCheckoutInput, ProbeSetupInput,
    SetupOnBase, changed_since_default, detect_setup, fetch_budget, fresh_checkout,
    managed_command, missing_manager, no_commits_ahead, prepare_base_probe, remove_checkout,
    skip_reason, sweep_private,
};
use crate::actions::condition_cmd::{CmdContext, CmdExec, CmdExecResult};
use crate::actions::conditions::{EvaluateConditionsInput, evaluate_conditions};
use crate::actions::open_pr::{
    GhCommand, OpenPrInput, OpenPrResult, check_clean, open_pr, resolve_head,
};
use crate::claude::driver::{
    ClaudeDriver, DriverEvent, DriverSession, DriverStartOptions, ListenerId, OutputStream,
    PermissionDecision, PermissionResolution, SKIP_PERMISSION_MODE,
};
use crate::claude::oneshot::{
    AssistantJobRunner, AssistantJobRunnerOptions, read_session_transcript,
};
use crate::claude::outcome_server::{PERMISSION_SHUTDOWN, PERMISSION_UNSUPPORTED_SERVER};
use crate::claude::transcript::{
    find_transcript, has_transcript_in_cwd, read_transcript_tail, transcript_chunks,
};
use crate::commands::runner::{
    CancelToken, CommandOutputChunk, CommandResult, CommandRunner, RunCommandOptions, RunError,
};
use crate::config::{DaemonConfig, machine_facts};
use crate::inventory::report::{
    InventoryReporter, InventoryScan, ONCE_LOG_CAP, RESCAN_POLL, ScanFn, once_log, scan_inventory,
    watch_rescan_trigger,
};
use crate::orphan::{ProcFacts, ProcInfo, StoredAgent, check_ours, read_proc_info};
use crate::platform::{self, Liveness, Platform, Signal, machine, mkdir_private, pid_liveness};
use crate::ports::{PortPool, port_env};
use crate::store::{
    AckRecord, AgentRecord, DaemonStore, DurableMessage, PersistedSession, PortRange,
};
use crate::sysinfo::{SysInfo, live_sysinfo};
use crate::system_prompt::build_append_system_prompt;
use crate::workspace::{EnsureWorktree, Workspace, WorkspaceOptions, inventory_digest};
use crate::ws_client::{ReconnectingWs, WsClientOptions, WsHandlers};

/// The crate version (without CONDUCTOR_BUILD_SHA); `register` sends `config.daemon_version`.
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// U-028 (ADR-0005 addendum): the one user message sent when a turn ends with neither
/// complete_state nor ask_user. A second outcome-less turn in a row emits `no_outcome`.
pub const NO_OUTCOME_NUDGE: &str =
    "You must finish by calling complete_state with your result, or ask_user if you need a human";

/// Give up waiting for a reply to request_work after this long.
pub const REQUEST_WORK_TIMEOUT_MS: u64 = 30_000;

/// A log sink.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
/// A pid's start time and command line (default: `orphan::read_proc_info`).
pub type ProcInfoFn = Arc<dyn Fn(u32) -> Option<ProcInfo> + Send + Sync>;
/// Is the Claude conversation `claude_session_id` (to be resumed in `cwd`) on this machine?
pub type HasConversation = Arc<dyn Fn(&Path, &str) -> bool + Send + Sync>;
/// The link can't recover (4001, 4003, 4005, HTTP 401/403): reconnecting has stopped.
pub type OnFatal = Arc<dyn Fn(u16, &str) + Send + Sync>;
/// Builds the command runner once (lazily, on the first run_cmd) with max_concurrent_builds.
pub type RunnerFactory = Arc<dyn Fn(usize) -> Arc<dyn CommandRunner> + Send + Sync>;
/// ADR-0021 §2.1: stage an announced build into `<root>/daemon/<version>`.
pub type StageUpdateFn = Arc<
    dyn Fn(
            crate::update::DaemonBuild,
        )
            -> futures_util::future::BoxFuture<'static, Result<PathBuf, crate::update::UpdateError>>
        + Send
        + Sync,
>;
/// ADR-0021 §2.4: `current` was switched (or a trial start failed): exit with
/// `EXIT_RESTART_FOR_UPDATE` so the service manager restarts the launcher.
pub type OnRestartForUpdate = Arc<dyn Fn() + Send + Sync>;

/// `DaemonOptions`.
pub struct DaemonOptions {
    pub config: DaemonConfig,
    pub driver: Arc<dyn ClaudeDriver>,
    /// Default: `commands::create_command_runner`.
    pub create_command_runner: Option<RunnerFactory>,
    pub sysinfo: Option<SysInfo>,
    /// Reported in `register` (U-015).
    pub claude_code_version: Option<String>,
    /// Test only: how open_pr / evaluate_conditions run gh (default `gh` from PATH).
    pub gh_command: Option<GhCommand>,
    /// Default: stderr, `[conductor-daemon] <msg>`.
    pub log: Option<Log>,
    /// Test seam: the inventory scan (default: `inventory::report::scan_inventory`).
    pub scan_inventory: Option<ScanFn>,
    /// BUG-1b: the Claude executable the driver runs; the startup orphan sweep only kills a
    /// process whose argv is this binary. Default $CONDUCTOR_CLAUDE_BIN, else `claude`. The
    /// assistant-job runner runs it too.
    pub claude_bin: Option<String>,
    pub proc_info: Option<ProcInfoFn>,
    /// Default: log `link failed (<code>); stopped`. `main` stops and exits non-zero.
    pub on_fatal: Option<OnFatal>,
    /// Default: the transcript is in the cwd's own project dir (`has_transcript_in_cwd`).
    pub has_conversation: Option<HasConversation>,
    /// The environment the inventory scan and assistant jobs run with (default: this process's).
    pub env: Option<Vec<(String, String)>>,
    /// ADR-0021: `CONDUCTOR_SUPERVISED` (launchd, systemd, schtasks), set by the service unit.
    /// None: run by hand, so an update is staged but never switched to.
    pub supervised: Option<String>,
    /// Default: `update::stage` from the orchestrator's HTTP origin.
    pub stage_update: Option<StageUpdateFn>,
    /// Default: log it. `run` exits 75.
    pub on_restart_for_update: Option<OnRestartForUpdate>,
    /// Test seams: `UPDATE_MAX_DRAIN_MS` and `UPDATE_TRIAL_REGISTER_MS` (the defaults).
    pub update_max_drain_ms: Option<u64>,
    pub update_trial_register_ms: Option<u64>,
}

impl DaemonOptions {
    /// Every seam at its default.
    pub fn new(config: DaemonConfig, driver: Arc<dyn ClaudeDriver>) -> Self {
        DaemonOptions {
            config,
            driver,
            create_command_runner: None,
            sysinfo: None,
            claude_code_version: None,
            gh_command: None,
            log: None,
            scan_inventory: None,
            claude_bin: None,
            proc_info: None,
            on_fatal: None,
            has_conversation: None,
            env: None,
            supervised: None,
            stage_update: None,
            on_restart_for_update: None,
            update_max_drain_ms: None,
            update_trial_register_ms: None,
        }
    }
}

/// Why the daemon could not be built.
#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("cannot make the daemon root private: {0}")]
    Root(String),
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
    #[error("assistant jobs: {0}")]
    Assistant(String),
}

// ---------------------------------------------------------------- state

/// A pending timer: its id (a stale fire is ignored) and its task.
struct Timer {
    id: u64,
    handle: AbortHandle,
}

impl Timer {
    fn cancel(self) {
        self.handle.abort();
    }
}

/// A Claude process this daemon started (the TS `AgentProc`), by its generation id.
struct AgentProc {
    sid: Uuid,
    /// command_id of the start_session that spawned it (`started` / `exit` correlation).
    command_id: Uuid,
    fencing_token: i64,
    claude_session_id: String,
    session: Arc<dyn DriverSession>,
    listener: Option<ListenerId>,
    completed: bool,
    /// Parked for a human: after ask_user, or after no_outcome. Cleared by send_input.
    ask_pending: bool,
    /// U-028: the nudge was sent for the current outcome-less streak. Cleared by send_input.
    nudged: bool,
    /// ADR-0035: background jobs the CLI last reported running (`background_tasks_changed`).
    background_tasks: u32,
    /// ADR-0021: its last turn ended (`turn_end`) and no new one was started since. With
    /// `ask_pending` it is parked, which doesn't hold up an update.
    turn_over: bool,
    /// Tail of the assistant text (NO_OUTCOME_OUTPUT_CHARS), attached to `no_outcome`.
    last_output: String,
    /// Last STDERR_TAIL_LINES lines of stderr (STDERR_TAIL_CHARS), sent on `exit`.
    stderr_tail: String,
    exited: bool,
    /// BUG-1: a kill was sent (stop_agent): later kills of the same process are no-ops.
    kill_requested: bool,
    end_timer: Option<Timer>,
}

/// A start_session preparing its worktree.
#[derive(Clone)]
struct Starting {
    command_id: Uuid,
    fencing_token: i64,
    /// A kill arrived while the worktree was being prepared: kill the process once it exists.
    cancelled: bool,
    /// BUG-1: a newer start_session for the session arrived while this one was preparing.
    superseded: bool,
}

struct RunningCmd {
    fencing_token: i64,
    cancel: CancelToken,
}

/// ADR-0010: an entry step's fresh checkout (the commit, its dir, the fencing token it runs
/// under). `id` stands in for the TS object identity.
#[derive(Clone, Debug)]
struct Checkout {
    id: u64,
    sha: String,
    dir: PathBuf,
    token: i64,
}

#[derive(Default)]
struct LiveSession {
    agent: Option<u64>,
    starting: Option<u64>,
    cmds: HashMap<Uuid, RunningCmd>,
}

/// ADR-0023: a `permission_request` this daemon sent, by its msg_id (for `protocol_error`).
struct SentPermission {
    msg_id: Uuid,
    agent: u64,
    request_id: String,
}

struct State {
    registered: bool,
    stopped: bool,
    heartbeat_ms: u64,
    heartbeat_timer: Option<Timer>,
    work_timer: Option<Timer>,
    awaiting_work: Option<Timer>,
    /// The last `no_work` reason logged (M2-T36: log only on a change).
    last_no_work: Option<String>,
    last_inventory_digest: String,
    live: HashMap<Uuid, LiveSession>,
    agents: HashMap<u64, AgentProc>,
    startings: HashMap<u64, Starting>,
    /// session_id → the timer that releases the slot a `work_assignment` holds.
    assignments: HashMap<Uuid, Timer>,
    in_flight: HashSet<Uuid>,
    checkouts: HashMap<Uuid, Checkout>,
    /// In the order they were sent.
    sent_permissions: Vec<SentPermission>,
    runner: Option<Arc<dyn CommandRunner>>,
    ports: PortPool,
    next_id: u64,
    rescan_watch: Option<AbortHandle>,
    /// ADR-0021 (MR-T14a): staging, draining, the trial timer.
    update: updating::UpdateState,
}

impl State {
    fn next(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// The session's live (not exited) agent.
    fn live_agent(&self, sid: &Uuid) -> Option<u64> {
        let id = self.live.get(sid)?.agent?;
        self.agents.get(&id).filter(|a| !a.exited).map(|_| id)
    }

    fn is_busy(&self, sid: &Uuid) -> bool {
        self.live.get(sid).is_some_and(|l| {
            self.live_agent(sid).is_some() || l.starting.is_some() || !l.cmds.is_empty()
        })
    }

    /// Sessions holding a slot: live or starting processes, plus fresh work assignments.
    fn slots_in_use(&self) -> usize {
        let mut used: HashSet<Uuid> = self.assignments.keys().copied().collect();
        for (sid, l) in &self.live {
            if self.live_agent(sid).is_some() || l.starting.is_some() {
                used.insert(*sid);
            }
        }
        used.len()
    }
}

/// What a command's ack goes back on.
#[derive(Clone, Copy)]
struct Meta {
    kind: &'static str,
    cid: Option<Uuid>,
    sid: Uuid,
    token: i64,
}

struct Core {
    me: Weak<Core>,
    config: DaemonConfig,
    store: Arc<Mutex<DaemonStore>>,
    workspace: Arc<Workspace>,
    driver: Arc<dyn ClaudeDriver>,
    create_runner: RunnerFactory,
    sysinfo: SysInfo,
    claude_code_version: Option<String>,
    gh: Option<GhCommand>,
    log: Log,
    on_fatal: OnFatal,
    claude_bin: String,
    proc_info: ProcInfoFn,
    has_conversation: HasConversation,
    ws: ReconnectingWs,
    inventory: InventoryReporter,
    assistant: AssistantJobRunner,
    /// ADR-0021 (MR-T14a): see `updating`.
    supervised: Option<String>,
    stage_update: StageUpdateFn,
    on_restart_for_update: OnRestartForUpdate,
    update_max_drain_ms: u64,
    update_trial_register_ms: u64,
    /// The update policy's clock (tokio time, so paused-clock tests can drive it).
    clock_start: tokio::time::Instant,
    state: Mutex<State>,
}

/// The WS handlers: a weak link back to the core.
struct Link(Weak<Core>);

impl WsHandlers for Link {
    fn on_open(&self) {
        if let Some(c) = self.0.upgrade() {
            c.on_open();
        }
    }
    fn on_message(&self, text: String) {
        if let Some(c) = self.0.upgrade() {
            c.on_message(&text);
        }
    }
    fn on_close(&self) {
        if let Some(c) = self.0.upgrade() {
            let mut st = c.lock();
            c.on_close(&mut st);
        }
    }
    fn on_fatal(&self, code: u16, reason: &str) {
        if let Some(c) = self.0.upgrade() {
            (c.on_fatal)(code, reason);
        }
    }
}

/// The daemon (the TS `Daemon` class). Cheap to clone: clones share one daemon. Needs a tokio
/// runtime from `new` on.
#[derive(Clone)]
pub struct Daemon {
    core: Arc<Core>,
}

fn send_frame(ws: &ReconnectingWs, msg: &DaemonToOrchestrator) {
    match serde_json::to_string(msg) {
        Ok(t) => {
            ws.send(&t);
        }
        Err(e) => tracing::error!("daemon frame does not serialise: {e}"),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Node's `os.platform()` / `os.arch()` names for `register`.
fn node_os() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".into(),
        "windows" => "win32".into(),
        other => other.into(),
    }
}

fn node_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64".into(),
        "aarch64" => "arm64".into(),
        "x86" => "ia32".into(),
        other => other.into(),
    }
}

/// JS `s.slice(-max)`: the last `max` UTF-16 code units (a surrogate pair cut in half is
/// dropped).
fn js_tail_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

/// JS `s.slice(0, max)` in UTF-16 code units.
fn js_head_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The TS `errText`: an error message, at most 300 characters.
fn err_text(e: impl std::fmt::Display) -> String {
    js_head_utf16(&e.to_string(), 300).to_string()
}

/// The last STDERR_TAIL_LINES lines (at most STDERR_TAIL_CHARS) of `prev` + `chunk`. Chunks are
/// raw stderr reads, so a line may span two of them; the tail keeps the text as it arrived.
pub fn append_tail(prev: &str, chunk: &str) -> String {
    let all = format!("{prev}{chunk}");
    let lines: Vec<&str> = all.split('\n').collect();
    // A trailing newline leaves an empty last element: it doesn't count as a line.
    let keep = if lines.last() == Some(&"") {
        STDERR_TAIL_LINES + 1
    } else {
        STDERR_TAIL_LINES
    };
    let kept = lines[lines.len().saturating_sub(keep)..].join("\n");
    js_tail_utf16(&kept, STDERR_TAIL_CHARS).to_string()
}

fn same_worktree(a: &Path, b: &Path) -> bool {
    a == b || platform::same_path(a, b)
}

/// `path.resolve(base, rel)` and whether it stays inside `base` (`path.relative` not `..` or
/// absolute).
fn resolve_inside(base: &Path, rel: Option<&str>) -> (PathBuf, bool) {
    let b = base.to_string_lossy();
    let at = platform::fs::resolve_for(Platform::current(), &b, rel.unwrap_or("."));
    let at = PathBuf::from(at);
    let base_norm = PathBuf::from(platform::fs::resolve_for(Platform::current(), &b, "."));
    let inside = at.strip_prefix(&base_norm).is_ok();
    (at, inside)
}

fn wire<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| e.to_string())
}

impl Core {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn store(&self) -> MutexGuard<'_, DaemonStore> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log(&self, msg: &str) {
        (self.log)(msg);
    }

    fn arc(&self) -> Option<Arc<Core>> {
        self.me.upgrade()
    }

    /// Run `f` with the state locked after `ms`, with the timer's id (to ignore a stale fire).
    fn after(
        &self,
        st: &mut State,
        ms: u64,
        f: impl FnOnce(&Core, &mut State, u64) + Send + 'static,
    ) -> Timer {
        let id = st.next();
        let weak = self.me.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if let Some(core) = weak.upgrade() {
                let mut st = core.lock();
                f(&core, &mut st, id);
            }
        })
        .abort_handle();
        Timer { id, handle }
    }

    // ============================================================ frames

    /// Validate a frame against the protocol types, then send it.
    fn send_json(&self, v: Value) {
        match wire::<DaemonToOrchestrator>(v) {
            Ok(m) => send_frame(&self.ws, &m),
            Err(e) => self.log(&format!("bug: an invalid daemon frame was not sent: {e}")),
        }
    }

    fn send_machine(&self, ty: &str, payload: Value) {
        self.send_json(json!({
            "type": ty,
            "msg_id": Uuid::new_v4(),
            "seq": null,
            "session_id": null,
            "fencing_token": null,
            "payload": payload,
        }));
    }

    /// Terminal output: not persisted, not replayed; dropped while disconnected.
    fn send_output(&self, st: &State, sid: Uuid, token: i64, stream: &str, text: &str) {
        if !st.registered {
            return;
        }
        self.send_json(json!({
            "type": "output",
            "msg_id": Uuid::new_v4(),
            "seq": null,
            "session_id": sid,
            "fencing_token": token,
            "payload": {
                "stream": stream,
                "text": text,
                "ts": crate::claude::outcome_server::iso_string(SystemTime::now()),
            },
        }));
    }

    /// A durable message: buffered on disk, sequenced when registered, replayed on reconnect.
    fn push_durable(&self, st: &State, msg: DurableMessage) {
        let ev = match self.store().push_event(msg, st.registered) {
            Ok(ev) => ev,
            Err(e) => {
                self.log(&format!("store: {e}"));
                return;
            }
        };
        if st.registered
            && let Some(seq) = ev.seq
        {
            send_frame(&self.ws, &ev.msg.with_seq(seq));
        }
    }

    /// A durable session_event (`{kind, data}`, checked against `SessionEventPayload`).
    fn emit(&self, st: &State, sid: Uuid, token: i64, payload: Value) {
        let payload: SessionEventPayload = match wire(payload) {
            Ok(p) => p,
            Err(e) => {
                self.log(&format!("bug: an invalid session_event was not sent: {e}"));
                return;
            }
        };
        self.push_durable(
            st,
            DurableMessage::SessionEvent {
                msg_id: Uuid::new_v4(),
                session_id: sid,
                fencing_token: token,
                payload,
            },
        );
    }

    fn send_ack(&self, m: Meta, ack: &AckRecord) {
        let Some(cid) = m.cid else {
            return;
        };
        let mut payload = json!({ "command_id": cid, "accepted": ack.accepted });
        if let Some(r) = ack.reason.as_ref().filter(|r| !r.is_empty()) {
            payload["reason"] = json!(r);
        }
        let (sid, token) = if m.kind == "assistant_job" {
            (Value::Null, Value::Null)
        } else {
            (json!(m.sid), json!(m.token))
        };
        self.send_json(json!({
            "type": "command_ack",
            "msg_id": Uuid::new_v4(),
            "seq": null,
            "session_id": sid,
            "fencing_token": token,
            "payload": payload,
        }));
    }

    /// Persist the command's ack (dedupe) and send it.
    fn finish(&self, m: Meta, accepted: bool, reason: Option<&str>) {
        let Some(cid) = m.cid else {
            return;
        };
        let ack = AckRecord {
            accepted,
            reason: reason.map(String::from),
        };
        if let Err(e) = self.store().record_ack(&cid.to_string(), ack.clone()) {
            self.log(&format!("store: {e}"));
        }
        self.send_ack(m, &ack);
    }

    fn has_ack(&self, cid: Option<Uuid>) -> bool {
        cid.is_some_and(|c| self.store().ack_for(&c.to_string()).is_some())
    }

    // ============================================================ link

    fn on_open(&self) {
        let facts = machine_facts();
        let res = (self.sysinfo)(&self.config.root_dir);
        let c = &self.config;
        let mut payload = json!({
            "machine_id": c.machine_id,
            "protocol_version": PROTOCOL_VERSION,
            "hostname": machine::hostname(),
            "os": node_os(),
            "arch": node_arch(),
            "tags": c.tags,
            "cpu_total": facts.cpu_total,
            "mem_total_mb": facts.mem_total_mb,
            "disk_free_mb": res.disk_free_mb,
            "budget_cpu": c.budget_cpu,
            "budget_mem_mb": c.budget_mem_mb,
            "max_sessions": c.max_sessions,
            "max_concurrent_builds": c.max_concurrent_builds,
            "daemon_version": c.daemon_version,
            "claude_code_version": self.claude_code_version,
            // ADR-0033 P2 (MR-T12 FR-4): this daemon runs assistant jobs. 06 §Attachments: it
            // downloads `start_session.attachments`, and its agents can `attach_file`.
            "features": [
                DAEMON_FEATURE_ASSISTANT_JOB,
                DAEMON_FEATURE_TICKET_ATTACHMENTS,
                DAEMON_FEATURE_AGENT_ATTACHMENTS,
                // ADR-0038: its outcome server has `publish_page`.
                DAEMON_FEATURE_PAGES,
                // ADR-0039: it honours `start_session.permission_mode` (skip permissions).
                DAEMON_FEATURE_PERMISSION_MODE,
            ],
        });
        // Local mode keeps M1's `enrollment_token: null`; an enrolled daemon authenticates on the
        // upgrade instead (10-contracts §Machines protocol v2).
        if c.credential.is_none() {
            payload["enrollment_token"] = Value::Null;
        }
        self.send_machine("register", payload);
        let mut st = self.lock();
        self.update_on_open(&mut st);
    }

    fn on_close(&self, st: &mut State) {
        st.registered = false;
        self.inventory.on_disconnected();
        for t in [
            st.heartbeat_timer.take(),
            st.work_timer.take(),
            st.awaiting_work.take(),
        ]
        .into_iter()
        .flatten()
        {
            t.cancel();
        }
    }

    fn on_message(&self, text: &str) {
        let msg: OrchestratorToDaemon = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                self.log(&format!(
                    "ignoring invalid orchestrator message: {}",
                    js_head_utf16(&e.to_string(), 200)
                ));
                return;
            }
        };
        let mut st = self.lock();
        match msg {
            OrchestratorToDaemon::Registered { payload, .. } => {
                if let Some(core) = self.arc() {
                    let hb = payload.heartbeat_interval_ms.get();
                    let last = payload.last_seq;
                    drop(st);
                    tokio::spawn(async move { core.on_registered(last, hb).await });
                }
            }
            OrchestratorToDaemon::WorkAssignment { payload, .. } => {
                st.last_no_work = None;
                self.hold_assignment(&mut st, payload.session_id);
                self.work_replied(&mut st, 0);
            }
            OrchestratorToDaemon::NoWork { payload, .. } => {
                // An older orchestrator sends no reason; log nothing then.
                let reason = payload.reason.map(|r| r.to_string());
                if let Some(r) = &reason
                    && st.last_no_work.as_ref() != Some(r)
                {
                    self.log(&format!("no work: {r}"));
                }
                st.last_no_work = reason;
                let poll = self.config.work_poll_ms;
                self.work_replied(&mut st, poll);
            }
            OrchestratorToDaemon::RetryAfter { payload, .. } => {
                self.work_replied(&mut st, payload.ms.get());
            }
            OrchestratorToDaemon::ProtocolError { payload, .. } => {
                self.log(&format!(
                    "protocol_error {}: {}",
                    payload.code, payload.message
                ));
                // ADR-0023 / 10-contracts §Versioning: a server that can't take a
                // permission_request answers it with protocol_error; deny the held call now
                // instead of after 30 min.
                if let Some(r) = payload.ref_msg_id
                    && let Some(i) = st.sent_permissions.iter().position(|p| p.msg_id == r)
                {
                    let sent = st.sent_permissions.remove(i);
                    if let Some(a) = st.agents.get(&sent.agent)
                        && a.session
                            .deny_permission(&sent.request_id, PERMISSION_UNSUPPORTED_SERVER)
                    {
                        let text = format!(
                            "conductor: the server refused permission request {}; denied",
                            sent.request_id
                        );
                        self.send_output(&st, a.sid, a.fencing_token, "debug", &text);
                    }
                }
            }
            OrchestratorToDaemon::AssistantJob { payload, .. } => {
                self.assistant_job(&mut st, payload);
            }
            OrchestratorToDaemon::UpdateAvailable { payload, .. } => {
                self.on_update_available(&mut st, payload);
            }
            OrchestratorToDaemon::FetchTranscript { payload, .. } => {
                drop(st);
                let t = self.transcript(payload.request_id, payload.session_id);
                self.send_machine("transcript", serde_json::to_value(t).unwrap_or_default());
            }
            OrchestratorToDaemon::StartSession {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "start_session",
                    cid: Some(payload.command_id),
                    sid: session_id,
                    token: fencing_token,
                };
                if !self.dedupe(&mut st, m) {
                    return;
                }
                // The refusals, supersede and `starting` run now, in arrival order (the TS
                // `startSession` up to its first `await`); the worktree and spawn follow.
                let Some(starting) = self.start_prepare(&mut st, m, &payload) else {
                    st.in_flight.remove(&payload.command_id);
                    return;
                };
                drop(st);
                if let Some(core) = self.arc() {
                    tokio::spawn(async move { core.start_session(m, payload, starting).await });
                }
            }
            OrchestratorToDaemon::RunCmd {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "run_cmd",
                    cid: Some(payload.command_id),
                    sid: session_id,
                    token: fencing_token,
                };
                self.sync_command(&mut st, m, |c, st| c.run_cmd(st, m, payload));
            }
            OrchestratorToDaemon::RunAction {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "run_action",
                    cid: Some(payload.command_id),
                    sid: session_id,
                    token: fencing_token,
                };
                self.sync_command(&mut st, m, |c, st| c.run_action(st, m, payload));
            }
            OrchestratorToDaemon::SendInput {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "send_input",
                    cid: Some(payload.command_id),
                    sid: session_id,
                    token: fencing_token,
                };
                self.sync_command(&mut st, m, |c, st| c.send_input(st, m, payload));
            }
            OrchestratorToDaemon::SendMessage {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "send_message",
                    cid: Some(payload.command_id),
                    sid: session_id,
                    token: fencing_token,
                };
                self.sync_command(&mut st, m, |c, st| c.send_message(st, m, payload));
            }
            OrchestratorToDaemon::Kill {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "kill",
                    cid: payload.command_id,
                    sid: session_id,
                    token: fencing_token,
                };
                self.sync_command(&mut st, m, |c, st| c.kill(st, m, payload));
            }
            OrchestratorToDaemon::PermissionDecision {
                session_id,
                fencing_token,
                payload,
                ..
            } => {
                let m = Meta {
                    kind: "permission_decision",
                    cid: Some(payload.command_id),
                    sid: session_id,
                    token: fencing_token,
                };
                self.sync_command(&mut st, m, |c, st| c.permission_decision(st, m, payload));
            }
        }
    }

    async fn on_registered(self: Arc<Self>, last_seq: Option<i64>, heartbeat_ms: u64) {
        {
            let mut st = self.lock();
            if st.stopped {
                return;
            }
            st.registered = true;
            self.ws.reset_backoff();
            st.heartbeat_ms = heartbeat_ms;
            let replay = self.store().on_registered(last_seq);
            match replay {
                Ok(events) => {
                    for ev in events {
                        if let Some(seq) = ev.seq {
                            send_frame(&self.ws, &ev.msg.with_seq(seq));
                        }
                    }
                }
                Err(e) => self.log(&format!("after registered: {e}")),
            }
            self.send_heartbeat(&mut st);
            self.update_on_registered(&mut st);
        }
        self.inventory.on_registered().await;
        self.send_repo_inventory(true).await;
        let mut st = self.lock();
        self.maybe_request_work(&mut st);
    }

    fn send_heartbeat(&self, st: &mut State) {
        if let Some(t) = st.heartbeat_timer.take() {
            t.cancel();
        }
        if !st.registered {
            return;
        }
        let res = (self.sysinfo)(&self.config.root_dir);
        let mut seen = HashSet::new();
        let mut sessions = Vec::new();
        let mut add = |sid: Uuid, token: i64| {
            if seen.insert((sid, token)) {
                sessions.push(json!({ "session_id": sid, "fencing_token": token }));
            }
        };
        for (sid, l) in &st.live {
            if let Some(a) = st.live_agent(sid).and_then(|id| st.agents.get(&id)) {
                add(*sid, a.fencing_token);
            }
            if let Some(s) = l.starting.and_then(|id| st.startings.get(&id)) {
                add(*sid, s.fencing_token);
            }
            for c in l.cmds.values() {
                add(*sid, c.fencing_token);
            }
        }
        let mut payload = json!({
            "cpu_free": res.cpu_free,
            "mem_free_mb": res.mem_free_mb,
            "disk_free_mb": res.disk_free_mb,
            "sessions": sessions,
        });
        // ADR-0021 §2.2: the orchestrator shows the machine as draining (updating).
        if let Some(d) = self.draining_payload(st) {
            payload["draining"] = d;
        }
        self.send_machine("heartbeat", payload);
        let ms = st.heartbeat_ms;
        st.heartbeat_timer = Some(self.after(st, ms, |c, st, id| {
            if st.heartbeat_timer.as_ref().is_some_and(|t| t.id == id) {
                st.heartbeat_timer = None;
                c.send_heartbeat(st);
            }
        }));
    }

    // TD-110: the legacy repo_inventory (the shared clones), sent alongside `inventory` until T16
    // switches the gateway; removed in M2-T21.
    async fn send_repo_inventory(&self, force: bool) {
        let repos = self.workspace.inventory().await;
        let digest = inventory_digest(&repos);
        let mut st = self.lock();
        if st.stopped || (!force && digest == st.last_inventory_digest) {
            return;
        }
        st.last_inventory_digest = digest;
        self.send_machine("repo_inventory", json!({ "repos": repos }));
    }

    // ============================================================ pull scheduling

    /// Hold a slot for an assigned session until its start_session arrives (or the hold expires).
    fn hold_assignment(&self, st: &mut State, sid: Uuid) {
        if let Some(prev) = st.assignments.remove(&sid) {
            prev.cancel();
        }
        let ms = self.config.assignment_hold_ms;
        let t = self.after(st, ms, move |c, st, id| {
            if !st.assignments.get(&sid).is_some_and(|t| t.id == id) {
                return;
            }
            st.assignments.remove(&sid);
            // The start_session never came: the slot is free again.
            c.maybe_request_work(st);
        });
        st.assignments.insert(sid, t);
    }

    /// Drop an assignment's hold. Returns whether one existed.
    fn release_assignment(&self, st: &mut State, sid: &Uuid) -> bool {
        match st.assignments.remove(sid) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// A start_session was refused: release its hold and re-arm the pull loop. With no live
    /// process left, nothing else would ever send request_work again. `delay_ms` > 0
    /// (memory_pressure) waits before asking, so claim/refuse doesn't spin.
    fn start_refused(&self, st: &mut State, sid: &Uuid, delay_ms: u64) {
        self.release_assignment(st, sid);
        if delay_ms == 0 || st.awaiting_work.is_some() || st.work_timer.is_some() {
            self.maybe_request_work(st);
            return;
        }
        st.work_timer = Some(self.after(st, delay_ms, |c, st, id| {
            if st.work_timer.as_ref().is_some_and(|t| t.id == id) {
                st.work_timer = None;
                c.maybe_request_work(st);
            }
        }));
    }

    // TD-027: request_work is sent even under memory pressure (07 only defines the start_session
    // veto); each claim is then refused and requeued, at most once per work_poll_ms.
    fn maybe_request_work(&self, st: &mut State) {
        if st.update.holds_work() {
            // ADR-0021 §2.2: draining asks for no new work; whatever just ended may make it idle.
            self.check_drained(st);
            return;
        }
        if !st.registered || st.stopped || st.awaiting_work.is_some() || st.work_timer.is_some() {
            return;
        }
        let free = self.config.max_sessions as i64 - st.slots_in_use() as i64;
        if free <= 0 {
            return;
        }
        let res = (self.sysinfo)(&self.config.root_dir);
        self.send_machine(
            "request_work",
            json!({
                "free_slots": free,
                // 10-contracts §Inventory: the hash of the last `inventory` sent.
                "repos_digest": self.inventory.hash(),
                "cpu_free": res.cpu_free,
                "mem_free_mb": res.mem_free_mb,
            }),
        );
        st.awaiting_work = Some(self.after(st, REQUEST_WORK_TIMEOUT_MS, |c, st, id| {
            if st.awaiting_work.as_ref().is_some_and(|t| t.id == id) {
                st.awaiting_work = None;
                c.maybe_request_work(st);
            }
        }));
    }

    fn work_replied(&self, st: &mut State, delay_ms: u64) {
        if let Some(t) = st.awaiting_work.take() {
            t.cancel();
        }
        if delay_ms == 0 {
            self.maybe_request_work(st);
            return;
        }
        if let Some(t) = st.work_timer.take() {
            t.cancel();
        }
        st.work_timer = Some(self.after(st, delay_ms, |c, st, id| {
            if st.work_timer.as_ref().is_some_and(|t| t.id == id) {
                st.work_timer = None;
                c.maybe_request_work(st);
            }
        }));
    }

    // ============================================================ commands

    /// The command_id dedupe: true when the command should run (and is now in flight).
    fn dedupe(&self, st: &mut State, m: Meta) -> bool {
        let Some(cid) = m.cid else {
            return true;
        };
        let prev = self.store().ack_for(&cid.to_string()).cloned();
        if let Some(prev) = prev {
            self.send_ack(m, &prev);
            return false;
        }
        // Still being executed (e.g. a start_session preparing its worktree): its ack follows.
        if st.in_flight.contains(&cid) {
            return false;
        }
        st.in_flight.insert(cid);
        true
    }

    /// The TS `.catch`: a command that failed before it was acked is refused `error: …`.
    fn failed(&self, st: &mut State, m: Meta, e: &str) {
        self.log(&format!("{} failed: {e}", m.kind));
        if m.cid.is_some() && !self.has_ack(m.cid) {
            self.finish(m, false, Some(&format!("error: {}", err_text(e))));
            if m.kind == "start_session" {
                self.start_refused(st, &m.sid, 0);
            }
        }
    }

    /// A command that runs (or starts its async part) without an `await` before its ack.
    fn sync_command(
        &self,
        st: &mut State,
        m: Meta,
        f: impl FnOnce(&Core, &mut State) -> Result<(), String>,
    ) {
        if !self.dedupe(st, m) {
            return;
        }
        if let Err(e) = f(self, st) {
            self.failed(st, m, &e);
        }
        if let Some(cid) = m.cid {
            st.in_flight.remove(&cid);
        }
    }

    fn under_memory_pressure(&self) -> bool {
        (self.sysinfo)(&self.config.root_dir).mem_free_mb < self.config.min_free_mem_mb
    }

    /// Remove a session's fresh checkout. With `only`, remove just that one: the map entry is
    /// cleared only if it is still that checkout (an old visit can't drop a newer one).
    fn drop_checkout(&self, st: &mut State, sid: &Uuid, only: Option<&Checkout>) {
        let held = st.checkouts.get(sid).cloned();
        let Some(target) = only.cloned().or_else(|| held.clone()) else {
            return;
        };
        remove_checkout(&target.dir);
        if held.is_some_and(|h| h.id == target.id) {
            st.checkouts.remove(sid);
        }
    }

    /// The rest of start_session after [`Core::start_prepare`]: the worktree, then the spawn.
    async fn start_session(self: Arc<Self>, m: Meta, mut p: StartSessionPayload, starting: u64) {
        {
            // TD-181: working_copy has no default_branch yet, so the base is the clone's
            // origin/HEAD. TD-200: the ack waits for this (a first clone can outlast the
            // orchestrator's ack window).
            let wt = self
                .workspace
                .ensure_worktree(&EnsureWorktree {
                    repo: p.repo.clone(),
                    session_id: m.sid.to_string(),
                    branch: p.branch.clone(),
                    base_ref: p.base_ref.clone(),
                    default_branch: None,
                })
                .await
                .map_err(|e| e.to_string());
            // 06 §Attachments: download the ticket's files before the spawn (never under the
            // state lock); the prompt lists them and Claude may read their directory.
            let mut add_dirs = Vec::new();
            if wt.is_ok() && !p.attachments.is_empty() {
                let (dir, block) = self.deliver_attachments(&m, &p).await;
                if let Some(block) = block {
                    p.prompt = format!("{}\n\n{block}", p.prompt);
                }
                add_dirs.push(dir);
            }
            let started = {
                let mut st = self.lock();
                self.start_spawn(&mut st, m, &p, starting, wt, add_dirs)
            };
            if started {
                // TD-110: legacy repo_inventory refresh, removed in M2-T21.
                self.send_repo_inventory(false).await;
            }
        }
        let mut st = self.lock();
        if let Some(cid) = m.cid {
            st.in_flight.remove(&cid);
        }
    }

    /// 06 §Attachments: fetch `p.attachments` into the session's attachments dir. The block for
    /// the prompt: every file on a fresh conversation, only the newly fetched ones on a resume.
    async fn deliver_attachments(
        &self,
        m: &Meta,
        p: &StartSessionPayload,
    ) -> (PathBuf, Option<String>) {
        // TD-214: nothing removes `<root>/artifacts/<session>/` yet.
        let dir = attachments::attachments_dir(&self.config.root_dir, &m.sid.to_string());
        let delivered = match attachments::http_base(&self.config.orchestrator_url) {
            None => p
                .attachments
                .iter()
                .map(|a| attachments::Delivered {
                    name: attachments::safe_name(a.name.as_str()),
                    mime: a.mime.as_str().to_string(),
                    size: a.size.get(),
                    fetched: attachments::Fetched::Failed("no orchestrator URL".into()),
                })
                .collect(),
            Some(base) => {
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap_or_default();
                let fetch = attachments::fetch_all(
                    &client,
                    &base,
                    self.config.credential.as_deref(),
                    &p.attachments,
                    &dir,
                );
                match tokio::time::timeout(attachments::FETCH_TIMEOUT, fetch).await {
                    Ok(d) => d,
                    Err(_) => p
                        .attachments
                        .iter()
                        .map(|a| attachments::Delivered {
                            name: attachments::safe_name(a.name.as_str()),
                            mime: a.mime.as_str().to_string(),
                            size: a.size.get(),
                            fetched: attachments::Fetched::Failed("the download timed out".into()),
                        })
                        .collect(),
                }
            }
        };
        for d in &delivered {
            if let attachments::Fetched::Failed(why) = &d.fetched {
                self.log(&format!("session {}: attachment {}: {why}", m.sid, d.name));
            }
        }
        let resume = p.resume_claude_session_id.is_some();
        (dir, attachments::prompt_block(&delivered, resume))
    }

    /// The part of start_session before the worktree: refusals, supersede, `starting`.
    fn start_prepare(&self, st: &mut State, m: Meta, p: &StartSessionPayload) -> Option<u64> {
        let sid = m.sid;
        let token = m.token;
        let live = st.live.entry(sid).or_default();
        let starting_id = live.starting;
        let current = st.live_agent(&sid);
        let current_token = current
            .and_then(|id| st.agents.get(&id))
            .map(|a| a.fencing_token);
        let starting_token = starting_id
            .and_then(|id| st.startings.get(&id))
            .map(|s| s.fencing_token);
        if current_token.is_some_and(|t| t > token) || starting_token.is_some_and(|t| t > token) {
            self.finish(m, false, Some("stale_fencing_token"));
            self.start_refused(st, &sid, 0);
            return None;
        }
        let holds_slot =
            current.is_some() || starting_id.is_some() || st.assignments.contains_key(&sid);
        if !holds_slot && st.slots_in_use() as u64 >= self.config.max_sessions {
            self.finish(m, false, Some("max_sessions"));
            self.start_refused(st, &sid, 0);
            return None;
        }
        if self.under_memory_pressure() {
            self.log(&format!(
                "session {sid}: refusing start (memory_pressure: {} MB available < CONDUCTOR_MIN_FREE_MEM_MB={})",
                (self.sysinfo)(&self.config.root_dir).mem_free_mb,
                self.config.min_free_mem_mb
            ));
            self.finish(m, false, Some("memory_pressure"));
            let poll = self.config.work_poll_ms;
            self.start_refused(st, &sid, poll);
            return None;
        }
        self.release_assignment(st, &sid);
        // A new agent start means any entry step's checks are over: drop a checkout an older
        // visit left behind.
        if let Some(stale) = st.checkouts.get(&sid).cloned()
            && stale.token <= token
        {
            self.drop_checkout(st, &sid, Some(&stale));
        }
        if let Some(cur) = current {
            let old = st.agents.get(&cur).map(|a| a.command_id);
            if let Some(old) = old {
                // A newer start for the same session supersedes the running process.
                self.log(&format!(
                    "session {sid}: start {} supersedes {old}",
                    p.command_id
                ));
                self.stop_agent(st, cur, &format!("superseded by start {}", p.command_id));
            }
        }
        if let Some(sid_starting) = starting_id
            && let Some(s) = st.startings.get_mut(&sid_starting)
        {
            // BUG-1: an older start is still preparing its worktree. It must not spawn: it sees
            // `superseded` before spawning and is refused.
            let old = s.command_id;
            s.superseded = true;
            self.log(&format!(
                "session {sid}: start {} supersedes {old}",
                p.command_id
            ));
        }
        let id = st.next();
        st.startings.insert(
            id,
            Starting {
                command_id: p.command_id,
                fencing_token: token,
                cancelled: false,
                superseded: false,
            },
        );
        st.live.entry(sid).or_default().starting = Some(id);
        Some(id)
    }

    /// Clear `starting` (if it is still this one) and forget it.
    fn end_starting(&self, st: &mut State, sid: &Uuid, id: u64) -> Option<Starting> {
        if let Some(l) = st.live.get_mut(sid)
            && l.starting == Some(id)
        {
            l.starting = None;
        }
        st.startings.remove(&id)
    }

    /// The part of start_session after the worktree. True when a process was started.
    fn start_spawn(
        &self,
        st: &mut State,
        m: Meta,
        p: &StartSessionPayload,
        starting: u64,
        wt: Result<PathBuf, String>,
        add_dirs: Vec<PathBuf>,
    ) -> bool {
        match self.start_spawn_inner(st, m, p, starting, wt, add_dirs) {
            Ok(started) => started,
            Err(e) => {
                self.end_starting(st, &m.sid, starting);
                self.finish(m, false, Some(&format!("start_failed: {}", err_text(&e))));
                self.start_refused(st, &m.sid, 0);
                false
            }
        }
    }

    fn start_spawn_inner(
        &self,
        st: &mut State,
        m: Meta,
        p: &StartSessionPayload,
        starting_id: u64,
        wt: Result<PathBuf, String>,
        add_dirs: Vec<PathBuf>,
    ) -> Result<bool, String> {
        let sid = m.sid;
        let token = m.token;
        let worktree = wt?;
        // ADR-0008: a reopened session reuses the earlier session's worktree. Never while a
        // process of another session still runs in it.
        if worktree != self.workspace.worktree_path(&sid.to_string()) {
            let others: Vec<(String, String)> = self
                .store()
                .sessions()
                .iter()
                .map(|(id, s)| (id.clone(), s.worktree_path.clone()))
                .collect();
            let busy = others.into_iter().find(|(id, path)| {
                *id != sid.to_string()
                    && same_worktree(Path::new(path), &worktree)
                    && Uuid::parse_str(id).is_ok_and(|u| st.is_busy(&u))
            });
            if let Some((id, _)) = busy {
                return Err(format!(
                    "worktree {} is in use by session {id}",
                    worktree.display()
                ));
            }
            self.log(&format!(
                "session {sid}: reusing worktree {} (branch {})",
                worktree.display(),
                p.branch
            ));
        }
        let starting = st
            .startings
            .get(&starting_id)
            .cloned()
            .ok_or("lost start")?;
        // BUG-1: superseded or killed while the worktree was prepared: never spawn.
        if starting.superseded || starting.cancelled {
            self.end_starting(st, &sid, starting_id);
            let why = if starting.superseded {
                "superseded"
            } else {
                "killed"
            };
            self.finish(m, false, Some(why));
            self.release_assignment(st, &sid);
            return Ok(false);
        }
        // A resume whose conversation isn't here (it ran on another machine): `claude --resume`
        // would exit 1. Refuse; apply forgets the id and the re-claim starts a fresh one.
        if let Some(resume_id) = &p.resume_claude_session_id
            && !(self.has_conversation)(&worktree, resume_id)
        {
            self.log(&format!(
                "session {sid}: refusing start {} ({NO_CONVERSATION_REASON}: Claude conversation {resume_id} is not on this machine)",
                p.command_id
            ));
            self.end_starting(st, &sid, starting_id);
            self.finish(m, false, Some(NO_CONVERSATION_REASON));
            self.start_refused(st, &sid, 0);
            return Ok(false);
        }
        let range = self.allocate_ports(st, &sid)?;
        let tools = resolve_tool_policy(&p.tools).map_err(|e| e.to_string())?;
        let append =
            build_append_system_prompt(self.workspace.read_claude_md(&worktree).as_deref());
        let resume = p.resume_claude_session_id.is_some();
        let claude_session_id = p
            .resume_claude_session_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let review = p.review == Some(true);
        // Persist the (pre-assigned) Claude session id before spawning (ADR-0005 §Spawn).
        // ADR-0009: a requirements reviewer's conversation is not the session's.
        {
            let mut store = self.store();
            let prior = store.session(&sid.to_string()).cloned();
            let stored_id = if review {
                prior.as_ref().and_then(|x| x.claude_session_id.clone())
            } else {
                Some(claude_session_id.clone())
            };
            store
                .put_session(
                    &sid.to_string(),
                    PersistedSession {
                        ticket_id: p.ticket_id.to_string(),
                        repo: p.repo.clone(),
                        worktree_path: worktree.to_string_lossy().into_owned(),
                        branch: p.branch.clone(),
                        port_range: Some(range),
                        claude_session_id: stored_id,
                        last_used_at: now_ms(),
                        agent: None,
                    },
                )
                .map_err(|e| e.to_string())?;
        }
        let mut env: BTreeMap<String, String> = p.env.clone();
        env.extend(port_env(range));
        env.extend(self.git_env());
        // TD-022: max_budget_usd is not passed (U-018).
        let mut opts = DriverStartOptions::new(
            worktree.clone(),
            p.prompt.clone(),
            tools,
            claude_session_id.clone(),
            resume,
        );
        opts.env = env;
        opts.append_system_prompt = Some(append);
        opts.model = p.model.clone();
        opts.max_turns = p
            .max_turns
            .map(|n| u32::try_from(n.get()).unwrap_or(u32::MAX));
        // ADR-0009: a reviewer runs in dontAsk (the driver forces the mode).
        opts.review = review;
        // ADR-0029: the user's MCP servers the agent gets (absent = only conductor's).
        opts.mcp = p.mcp.clone();
        // ADR-0011: the names complete_state accepts.
        opts.transitions = (!p.transitions.is_empty()).then(|| p.transitions.clone());
        // 06 §Attachments: the dir the ticket's files were downloaded to, and where the agent's
        // `attach_file` uploads go (the driver gives a reviewer none).
        let mut roots = vec![worktree.clone(), std::env::temp_dir()];
        roots.extend(add_dirs.iter().cloned());
        opts.add_dirs = add_dirs;
        opts.attach = attachments::http_base(&self.config.orchestrator_url).map(|base| {
            attachments::upload::AttachTarget {
                base,
                credential: self.config.credential.clone(),
                session_id: sid.to_string(),
                roots,
            }
        });
        // ADR-0038: a state with the `pages` tool gets `publish_page` (posting to the same server).
        opts.publish_pages = p.tools.iter().any(|t| t == "pages");
        // ADR-0039: skip permissions, for a working agent only (the driver ignores it for a
        // reviewer, which keeps dontAsk).
        opts.skip_permissions =
            !review && p.permission_mode.as_deref() == Some(SKIP_PERMISSION_MODE);
        let session = self.driver.start(opts).map_err(|e| e.to_string())?;
        let aid = st.next();
        // The listener only queues: a driver may call it inside `on` (the CLI driver hands the
        // first listener its backlog there), and this section holds the state lock. One task per
        // process handles its events in order; `exit` is the last.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DriverEvent>();
        let listener = session.on(Arc::new(move |ev: &DriverEvent| {
            let _ = tx.send(ev.clone());
        }));
        let weak = self.me.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                let Some(c) = weak.upgrade() else {
                    return;
                };
                let mut st = c.lock();
                let exit = matches!(ev, DriverEvent::Exit { .. });
                c.on_driver_event(&mut st, sid, aid, &ev);
                if matches!(ev, DriverEvent::TurnEnd { .. }) {
                    // ADR-0021: a turn that parked may be the last work a drain waits for.
                    c.check_drained(&mut st);
                }
                if exit {
                    return;
                }
            }
        });
        st.agents.insert(
            aid,
            AgentProc {
                sid,
                command_id: p.command_id,
                fencing_token: token,
                claude_session_id: claude_session_id.clone(),
                session: session.clone(),
                listener: Some(listener),
                completed: false,
                ask_pending: false,
                nudged: false,
                turn_over: false,
                background_tasks: 0,
                last_output: String::new(),
                stderr_tail: String::new(),
                exited: false,
                kill_requested: false,
                end_timer: None,
            },
        );
        let starting = self.end_starting(st, &sid, starting_id).unwrap_or(starting);
        let prev = st.live.get(&sid).and_then(|l| l.agent);
        if let Some(prev) = prev
            && prev != aid
            && st
                .agents
                .get(&prev)
                .is_some_and(|a| !a.exited && a.fencing_token <= token)
        {
            // Defensive (BUG-1): never drop a live process from `live` without killing it.
            self.stop_agent(st, prev, &format!("superseded by start {}", p.command_id));
        }
        st.live.entry(sid).or_default().agent = Some(aid);
        {
            // BUG-1b: the startup sweep needs the pid, the Claude session id and the start time
            // to recognise this process; without a readable start time it is never a target.
            let pid = session.pid();
            let info = pid.and_then(|p| (self.proc_info)(p));
            if let (Some(pid), None) = (pid, &info) {
                self.log(&format!(
                    "session {sid}: cannot read start time of process {pid}; not tracked for the orphan sweep"
                ));
            }
            let mut store = self.store();
            if let Some(persisted) = store.session(&sid.to_string()).cloned() {
                let mut rec = AgentRecord {
                    command_id: p.command_id.to_string(),
                    fencing_token: token,
                    pid: None,
                    claude_session_id: None,
                    started_at: None,
                };
                if let (Some(pid), Some(info)) = (pid, info) {
                    rec.pid = Some(pid);
                    rec.claude_session_id = Some(claude_session_id.clone());
                    rec.started_at = Some(info.started_at_ms);
                }
                let _ = store.put_session(
                    &sid.to_string(),
                    PersistedSession {
                        agent: Some(Some(rec)),
                        ..persisted
                    },
                );
            }
        }
        self.finish(m, true, None);
        self.emit(
            st,
            sid,
            token,
            json!({
                "kind": "started",
                "data": {
                    "command_id": p.command_id,
                    "worktree_path": worktree.to_string_lossy(),
                    "branch": p.branch,
                    "port_range": { "base": range.base, "count": range.count },
                },
            }),
        );
        if starting.cancelled {
            self.stop_agent(st, aid, "killed while starting");
        }
        Ok(true)
    }

    /// ADR-0023 / 10-contracts §Permission prompts: resolve the held call `request_id` of the
    /// session's live process, at most once. Already resolved by a decision → accepted, ignored.
    /// Not held → `unknown_permission_request`.
    fn permission_decision(
        &self,
        st: &mut State,
        m: Meta,
        p: PermissionDecisionPayload,
    ) -> Result<(), String> {
        let request_id = p.request_id.to_string();
        let agent = st.live_agent(&m.sid);
        let result = match agent.and_then(|id| st.agents.get(&id)) {
            Some(a) => a.session.resolve_permission(
                &request_id,
                PermissionDecision {
                    behavior: p.behavior,
                    scope: p.scope,
                    message: p.message.as_ref().map(|x| x.to_string()),
                    rule: p.rule.as_ref().map(|x| x.to_string()),
                },
            ),
            None => PermissionResolution::Unknown,
        };
        if result == PermissionResolution::Unknown {
            self.finish(m, false, Some("unknown_permission_request"));
            return Ok(());
        }
        if result == PermissionResolution::Resolved
            && let Some(id) = agent
        {
            st.sent_permissions
                .retain(|s| !(s.agent == id && s.request_id == request_id));
            let behavior = serde_json::to_value(p.behavior)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            let scope = serde_json::to_value(p.scope)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            let what = if behavior == "allow" {
                format!("allowed ({scope})")
            } else {
                "denied".into()
            };
            if let Some(a) = st.agents.get(&id) {
                let text =
                    format!("conductor: permission request {request_id}: {what} on the board");
                self.send_output(st, m.sid, a.fencing_token, "debug", &text);
            }
        }
        self.finish(m, true, None);
        Ok(())
    }

    fn on_driver_event(&self, st: &mut State, sid: Uuid, aid: u64, ev: &DriverEvent) {
        let Some(a) = st.agents.get_mut(&aid) else {
            return;
        };
        let token = a.fencing_token;
        match ev {
            DriverEvent::ClaudeSessionId { id } => {
                self.emit(
                    st,
                    sid,
                    token,
                    json!({ "kind": "claude_session_id", "data": { "id": id } }),
                );
            }
            DriverEvent::Output { stream, text } => {
                match stream {
                    OutputStream::Assistant => {
                        let joined = if a.last_output.is_empty() {
                            text.clone()
                        } else {
                            format!("{}\n{text}", a.last_output)
                        };
                        a.last_output = js_tail_utf16(&joined, NO_OUTCOME_OUTPUT_CHARS).to_string();
                    }
                    OutputStream::Stderr => a.stderr_tail = append_tail(&a.stderr_tail, text),
                    _ => {}
                }
                self.send_output(st, sid, token, stream.as_str(), text);
            }
            DriverEvent::AskUser {
                question,
                options,
                proposed_checks,
            } => {
                a.ask_pending = true;
                // Questions UX: the options travel as given (absent when none).
                let mut data = json!({ "question": question });
                if let Some(o) = options {
                    data["options"] = json!(o);
                }
                if let Some(c) = proposed_checks {
                    data["proposed_checks"] = c.clone();
                }
                self.emit(st, sid, token, json!({ "kind": "ask_user", "data": data }));
            }
            DriverEvent::PermissionRequest {
                request_id,
                tool,
                input,
                suggestions,
                tool_use_id,
                expires_at,
            } => {
                // ADR-0023: durable like a session_event (buffered, replayed, deduped on seq);
                // the request_id is the idempotency key end to end.
                let msg_id = Uuid::new_v4();
                st.sent_permissions.push(SentPermission {
                    msg_id,
                    agent: aid,
                    request_id: request_id.clone(),
                });
                let mut payload = json!({
                    "request_id": request_id,
                    "session_id": sid,
                    "tool": tool,
                    "input": input,
                    "expires_at": expires_at,
                });
                if let Some(s) = suggestions {
                    payload["suggestions"] = json!(s);
                }
                if let Some(t) = tool_use_id {
                    payload["tool_use_id"] = json!(t);
                }
                match wire(payload) {
                    Ok(payload) => self.push_durable(
                        st,
                        DurableMessage::PermissionRequest {
                            msg_id,
                            session_id: sid,
                            fencing_token: token,
                            payload,
                        },
                    ),
                    Err(e) => self.log(&format!("bug: an invalid permission_request: {e}")),
                }
                let text = format!(
                    "conductor: {tool} needs permission; asked on the board (request {request_id}, expires {expires_at})"
                );
                self.send_output(st, sid, token, "debug", &text);
            }
            DriverEvent::CompleteState {
                result,
                transition,
                reason,
            } => {
                a.completed = true;
                let mut data = json!({ "result": result });
                if let Some(t) = transition {
                    data["transition"] = json!(t);
                }
                if let Some(r) = reason {
                    data["reason"] = json!(r);
                }
                self.emit(
                    st,
                    sid,
                    token,
                    json!({ "kind": "complete_state", "data": data }),
                );
            }
            DriverEvent::Spend { total_usd, usage } => {
                let data = json!({
                    "claude_session_id": a.claude_session_id,
                    "total_usd": total_usd,
                    "usage": {
                        "input_tokens": usage.input_tokens,
                        "output_tokens": usage.output_tokens,
                        "cache_read_tokens": usage.cache_read_tokens,
                        "cache_creation_tokens": usage.cache_creation_tokens,
                    },
                });
                self.emit(st, sid, token, json!({ "kind": "spend", "data": data }));
            }
            DriverEvent::TurnEnd { subtype, .. } => {
                a.turn_over = true;
                // ADR-0005: turn_end stays in the daemon. After complete_state → end() (kill
                // after a grace period); after ask_user → parked, alive and idle.
                if a.completed {
                    if a.end_timer.is_none() {
                        a.session.end();
                        let grace = self.config.kill_grace_ms;
                        let t = self.after(st, self.config.end_grace_ms, move |_, st, _| {
                            if let Some(a) = st.agents.get(&aid)
                                && !a.exited
                            {
                                a.session.kill(Some(Duration::from_millis(grace)));
                            }
                        });
                        if let Some(a) = st.agents.get_mut(&aid) {
                            a.end_timer = Some(t);
                        }
                    }
                } else if a.ask_pending {
                    // Parked: nothing to do.
                } else if a.background_tasks > 0 {
                    // ADR-0035: the agent left jobs running and ended its turn to wait for them.
                    // Not an outcome-less turn: the CLI starts a turn of its own when a job
                    // finishes, and a message written now runs as a turn at once. The nudge
                    // state is left as it is; the state's timeout bounds a job that never ends.
                    let text = format!(
                        "conductor: turn ended with {} background job(s) running; waiting for them (messages reach the agent now)",
                        a.background_tasks
                    );
                    self.send_output(st, sid, token, "debug", &text);
                } else {
                    let subtype = subtype.clone();
                    self.no_outcome(st, sid, aid, &subtype);
                }
            }
            DriverEvent::BackgroundTasks { running } => a.background_tasks = *running,
            DriverEvent::Exit { code, signal } => {
                a.exited = true;
                if let Some(t) = a.end_timer.take() {
                    t.cancel();
                }
                if let Some(l) = a.listener.take() {
                    a.session.off(l);
                }
                let command_id = a.command_id;
                let stderr_tail = a.stderr_tail.clone();
                st.sent_permissions.retain(|s| s.agent != aid);
                let mut data = json!({ "command_id": command_id, "code": code, "signal": signal });
                if !stderr_tail.trim().is_empty() {
                    data["stderr_tail"] = json!(stderr_tail);
                }
                self.emit(st, sid, token, json!({ "kind": "exit", "data": data }));
                if let Some(l) = st.live.get_mut(&sid)
                    && l.agent == Some(aid)
                {
                    l.agent = None;
                }
                st.agents.remove(&aid);
                {
                    let mut store = self.store();
                    if let Some(s) = store.session(&sid.to_string()).cloned() {
                        let owned = s
                            .agent
                            .as_ref()
                            .and_then(|a| a.as_ref())
                            .is_some_and(|a| a.command_id == command_id.to_string());
                        let agent = if owned { Some(None) } else { s.agent.clone() };
                        let _ = store.put_session(
                            &sid.to_string(),
                            PersistedSession {
                                last_used_at: now_ms(),
                                agent,
                                ..s
                            },
                        );
                    }
                }
                self.maybe_request_work(st);
            }
        }
    }

    /// U-028 (ADR-0005 addendum): a turn ended with neither complete_state nor ask_user. The
    /// first time, nudge with one user message; if the next turn also ends without an outcome,
    /// park the session and emit `no_outcome`. A human answer (send_input) re-arms the nudge.
    fn no_outcome(&self, st: &mut State, sid: Uuid, aid: u64, subtype: &str) {
        let Some(a) = st.agents.get_mut(&aid) else {
            return;
        };
        let token = a.fencing_token;
        if !a.nudged {
            a.nudged = true;
            let session = a.session.clone();
            self.send_output(
                st,
                sid,
                token,
                "debug",
                &format!(
                    "conductor: turn ended ({subtype}) without complete_state or ask_user; nudging"
                ),
            );
            if let Err(e) = session.send_input(NO_OUTCOME_NUDGE) {
                // The process is gone; its `exit` event follows and the engine handles that.
                self.log(&format!("session {sid}: nudge not sent: {}", err_text(e)));
            }
            return;
        }
        a.ask_pending = true;
        let last_output = a.last_output.clone();
        self.send_output(
            st,
            sid,
            token,
            "debug",
            &format!(
                "conductor: turn ended ({subtype}) without an outcome after the nudge; asking a human"
            ),
        );
        self.emit(
            st,
            sid,
            token,
            json!({ "kind": "no_outcome", "data": { "last_output": last_output } }),
        );
    }

    fn send_input(&self, st: &mut State, m: Meta, p: SendInputPayload) -> Result<(), String> {
        let a = st.live_agent(&m.sid).and_then(|id| st.agents.get_mut(&id));
        let Some(a) = a.filter(|a| !a.completed) else {
            self.finish(m, false, Some("no_live_process"));
            return Ok(());
        };
        if a.session.send_input(&p.text).is_err() {
            self.finish(m, false, Some("no_live_process"));
            return Ok(());
        }
        a.ask_pending = false;
        a.nudged = false;
        a.turn_over = false;
        self.finish(m, true, None);
        Ok(())
    }

    /// ADR-0007: a human's message to the running agent, written to stdin as a user message.
    /// Only the process it was meant for (`target_command_id`, at or below the envelope token),
    /// and only while it is working. It leaves `ask_pending` and `nudged` alone (U-028).
    fn send_message(&self, st: &mut State, m: Meta, p: SendMessagePayload) -> Result<(), String> {
        let a = st.live_agent(&m.sid).and_then(|id| st.agents.get(&id));
        let Some(a) = a.filter(|a| {
            !a.completed && a.command_id == p.target_command_id && a.fencing_token <= m.token
        }) else {
            self.finish(m, false, Some("no_live_process"));
            return Ok(());
        };
        if a.ask_pending {
            self.finish(m, false, Some("agent_parked"));
            return Ok(());
        }
        if a.session.send_message(&p.text).is_err() {
            self.finish(m, false, Some("no_live_process"));
            return Ok(());
        }
        self.finish(m, true, None);
        Ok(())
    }

    fn command_runner(&self, st: &mut State) -> Arc<dyn CommandRunner> {
        st.runner
            .get_or_insert_with(|| (self.create_runner)(self.config.max_concurrent_builds as usize))
            .clone()
    }

    fn run_cmd(&self, st: &mut State, m: Meta, p: RunCmdPayload) -> Result<(), String> {
        let sid = m.sid;
        let token = m.token;
        let s = self.store().session(&sid.to_string()).cloned();
        let Some(s) = s.filter(|s| Path::new(&s.worktree_path).exists()) else {
            self.finish(m, false, Some("unknown_session"));
            return Ok(());
        };
        let wt = PathBuf::from(&s.worktree_path);
        let (cwd, inside) = resolve_inside(&wt, p.cwd.as_deref());
        if !inside {
            self.finish(m, false, Some("invalid_cwd"));
            return Ok(());
        }
        if self.under_memory_pressure() {
            self.finish(m, false, Some("memory_pressure"));
            return Ok(());
        }
        let runner = self.command_runner(st);
        let range = match self.allocate_ports(st, &sid) {
            Ok(r) => r,
            Err(e) => {
                self.finish(m, false, Some(&format!("error: {}", err_text(e))));
                return Ok(());
            }
        };
        let cancel = CancelToken::new();
        st.live.entry(sid).or_default().cmds.insert(
            p.command_id,
            RunningCmd {
                fencing_token: token,
                cancel: cancel.clone(),
            },
        );
        self.finish(m, true, None);
        self.touch(&sid);
        let Some(core) = self.arc() else {
            return Ok(());
        };
        tokio::spawn(async move {
            let started = Instant::now();
            let mut out = RunOutcome::default();
            let r = core
                .run_cmd_work(&mut out, sid, token, &p, &s, &cwd, range, runner, cancel)
                .await;
            let mut data = match r {
                Ok(r) => json!({
                    "exit_code": r.exit_code,
                    "signal": r.signal,
                    "timed_out": r.timed_out,
                    "duration_ms": r.duration_ms,
                    "output_tail": r.output_tail,
                }),
                Err(e) => json!({
                    "exit_code": null,
                    "signal": null,
                    "timed_out": false,
                    "duration_ms": started.elapsed().as_millis() as u64,
                    "output_tail": format!("conductor: command could not be spawned: {}", err_text(e)),
                }),
            };
            data["command_id"] = json!(p.command_id);
            data["head_sha"] = json!(out.head_sha);
            if let Some(d) = out.dirty {
                data["dirty"] = json!(d);
            }
            if out.setup_failed {
                data["setup_failed"] = json!(true);
            }
            if let Some(c) = &out.setup_cmd {
                data["setup_cmd"] = json!(c);
            }
            if let Some(v) = out.setup_on_base {
                data["setup_on_base"] = json!(v.as_str());
            }
            if let Some(b) = &out.base_ref {
                data["base_ref"] = json!(b);
            }
            if let Some(why) = &out.not_run {
                data["not_run"] = json!(why);
            }
            if out.no_commits {
                data["no_commits"] = json!(true);
            }
            if let Some(why) = &out.skipped {
                data["skipped"] = json!(why);
            }
            let mut st = core.lock();
            if let Some(l) = st.live.get_mut(&sid) {
                l.cmds.remove(&p.command_id);
            }
            core.emit(&st, sid, token, json!({ "kind": "cmd_exit", "data": data }));
        });
        Ok(())
    }

    /// The command as the runner gets it.
    #[allow(clippy::too_many_arguments)]
    fn exec_opts(
        &self,
        sid: Uuid,
        token: i64,
        p: &RunCmdPayload,
        s: &PersistedSession,
        range: PortRange,
        cancel: &CancelToken,
        cmd: &str,
        at: &Path,
    ) -> RunCommandOptions {
        let mut o = RunCommandOptions::new(p.command_id, sid, cmd, at);
        o.timeout = p.timeout_ms.map(|ms| Duration::from_millis(ms.get()));
        let mut env = BTreeMap::new();
        env.insert("CONDUCTOR_SESSION_ID".into(), sid.to_string());
        env.insert("CONDUCTOR_TICKET_ID".into(), s.ticket_id.clone());
        env.extend(port_env(range));
        env.extend(self.git_env());
        o.env = env;
        o.cancel = Some(cancel.clone());
        let weak = self.me.clone();
        o.on_output = Some(Arc::new(move |c: CommandOutputChunk| {
            if let Some(core) = weak.upgrade() {
                let st = core.lock();
                core.send_output(&st, sid, token, c.stream.as_str(), &c.text);
            }
        }));
        let weak = self.me.clone();
        o.on_waiting_for_slot = Some(Arc::new(move |waiting: bool| {
            if let Some(core) = weak.upgrade() {
                let st = core.lock();
                core.emit(
                    &st,
                    sid,
                    token,
                    json!({ "kind": "build_slot", "data": { "waiting": waiting } }),
                );
            }
        }));
        o
    }

    /// `notRun`: a result for a check that was not run, with the reason on stderr.
    fn not_run(&self, sid: Uuid, token: i64, text: &str) -> CommandResult {
        let st = self.lock();
        self.send_output(&st, sid, token, "stderr", &format!("conductor: {text}\n"));
        CommandResult {
            exit_code: None,
            signal: None,
            timed_out: false,
            duration_ms: 0,
            output_tail: text.to_string(),
        }
    }

    fn debug_line(&self, sid: Uuid, token: i64, text: &str) {
        let st = self.lock();
        self.send_output(&st, sid, token, "debug", text);
    }

    /// The TS `work()` of run_cmd: ADR-0010 require_clean / fresh checkout / setup, then the
    /// command.
    #[allow(clippy::too_many_arguments)]
    async fn run_cmd_work(
        &self,
        out: &mut RunOutcome,
        sid: Uuid,
        token: i64,
        p: &RunCmdPayload,
        s: &PersistedSession,
        cwd: &Path,
        range: PortRange,
        runner: Arc<dyn CommandRunner>,
        cancel: CancelToken,
    ) -> Result<CommandResult, RunError> {
        let wt = PathBuf::from(&s.worktree_path);
        let exec = |cmd: String, at: PathBuf| {
            let o = self.exec_opts(sid, token, p, s, range, &cancel, &cmd, &at);
            let runner = runner.clone();
            async move { runner.run(o).await }
        };
        if p.require_clean == Some(true) {
            let c = check_clean(&wt, None).await;
            out.head_sha = c.head.clone();
            out.dirty = c.dirty.clone();
            if let Some(d) = &c.dirty {
                return Ok(self.not_run(
                    sid,
                    token,
                    &format!(
                        "uncommitted changes, not running `{}`:\n{}",
                        p.cmd,
                        d.join("\n")
                    ),
                ));
            }
        } else {
            out.head_sha = resolve_head(&wt, None).await;
        }
        let Some(co) = &p.checkout else {
            return exec(p.cmd.clone(), cwd.to_path_buf()).await;
        };
        let Some(want) = co.sha.clone().or_else(|| out.head_sha.clone()) else {
            let why = "could not resolve the commit to check";
            out.not_run = Some(why.into());
            return Ok(self.not_run(sid, token, why));
        };
        if let Some(head) = &out.head_sha
            && *head != want
        {
            let why =
                format!("the branch moved: the checks are for {want}, the worktree is at {head}");
            out.not_run = Some(why.clone());
            return Ok(self.not_run(sid, token, &why));
        }
        out.head_sha = Some(want.clone());
        // Nothing to check when the branch adds no commits to origin's default branch (a no-code
        // spike): say so up front, before a fresh checkout and setup. Once per gate: a held
        // checkout means an earlier check of this gate already got past it.
        let holding = self
            .lock()
            .checkouts
            .get(&sid)
            .is_some_and(|h| h.sha == want);
        if !holding && let Some(base) = no_commits_ahead(&wt, &want, None).await {
            let why = format!(
                "the session branch `{}` has no commits ahead of {base} (it is at {want})",
                s.branch
            );
            out.no_commits = true;
            out.not_run = Some(why.clone());
            return Ok(self.not_run(sid, token, &format!("{why}, so there is nothing to check")));
        }
        // R3: a check with `paths` runs only when the branch's diff from its merge base with
        // origin's default branch touches one; anything unknown runs it. A skip makes no
        // checkout and runs no setup; as the last check it still removes the gate's checkout.
        if !co.paths.is_empty() {
            let paths = co.paths.as_slice();
            let changed = changed_since_default(&wt, &want, None).await;
            let (base, files) = match &changed {
                Some((b, f)) => (Some(b.as_str()), Some(f.as_slice())),
                None => (None, None),
            };
            if let Some(why) = skip_reason(files, paths, base) {
                self.debug_line(
                    sid,
                    token,
                    &format!("conductor: skipped `{}`: {why}", p.cmd),
                );
                if co.last {
                    let mut st = self.lock();
                    let held = st.checkouts.get(&sid).filter(|h| h.sha == want).cloned();
                    if let Some(h) = held {
                        self.drop_checkout(&mut st, &sid, Some(&h));
                    }
                }
                out.skipped = Some(why.clone());
                return Ok(CommandResult {
                    exit_code: Some(0),
                    signal: None,
                    timed_out: false,
                    duration_ms: 0,
                    output_tail: why,
                });
            }
        }
        let mut ok = false;
        // The checkout this run uses: its cleanup only ever removes this one.
        let mut mine: Option<Checkout> = None;
        let r: Result<CommandResult, RunError> = async {
            let mut held = {
                let mut st = self.lock();
                let held = st.checkouts.get(&sid).cloned();
                if held.as_ref().is_some_and(|h| h.sha != want) {
                    self.drop_checkout(&mut st, &sid, None);
                    None
                } else {
                    held
                }
            };
            if held.is_none() {
                let fresh = fresh_checkout(&FreshCheckoutInput {
                    root: self.config.root_dir.clone(),
                    worktree: wt.clone(),
                    branch: s.branch.clone(),
                    sha: want.clone(),
                    env: None,
                    // The fetch of a large repo takes minutes: the check's own budget.
                    timeout: Some(fetch_budget(
                        p.timeout_ms.map(|ms| Duration::from_millis(ms.get())),
                    )),
                })
                .await;
                let dir = match fresh {
                    FreshCheckout::Err { error, head } => {
                        if head.is_some() {
                            out.head_sha = head;
                        }
                        out.not_run = Some(error.clone());
                        return Ok(self.not_run(sid, token, &error));
                    }
                    FreshCheckout::Ok { dir, .. } => dir,
                };
                let c = {
                    let mut st = self.lock();
                    let c = Checkout {
                        id: st.next(),
                        sha: want.clone(),
                        dir,
                        token,
                    };
                    st.checkouts.insert(sid, c.clone());
                    c
                };
                mine = Some(c.clone());
                held = Some(c.clone());
                // TD-177: the missing-manager guards here are unit-tested only.
                if let Some(setup) = detect_setup(&c.dir, co.setup.as_deref()) {
                    let failed = if let Some(missing) = missing_manager(&setup, None) {
                        Some(self.not_run(sid, token, &missing))
                    } else {
                        self.debug_line(
                            sid,
                            token,
                            &format!("conductor: setup `{setup}` in a fresh checkout of {want}"),
                        );
                        let sr = exec(setup.clone(), c.dir.clone()).await?;
                        (sr.exit_code != Some(0) || sr.timed_out).then_some(sr)
                    };
                    if let Some(r) = failed {
                        // A failed setup: the same setup once on the base branch's tip says
                        // whose problem it is (05 §Requirements to enter a column).
                        out.setup_failed = true;
                        out.setup_cmd = Some(setup);
                        let probe = prepare_base_probe(&ProbeSetupInput {
                            base: BaseCheckoutInput {
                                root: self.config.root_dir.clone(),
                                worktree: wt.clone(),
                                env: None,
                            },
                            sha: want.clone(),
                            configured: co.setup.clone(),
                        })
                        .await;
                        for line in &probe.log {
                            self.debug_line(sid, token, &format!("conductor: base probe: {line}"));
                        }
                        let verdict = match probe.next {
                            BaseProbeNext::Verdict(v) => v,
                            BaseProbeNext::Run { setup, dir } => {
                                let ok = matches!(
                                    exec(setup, dir.clone()).await,
                                    Ok(x) if x.exit_code == Some(0) && !x.timed_out
                                );
                                remove_checkout(&dir);
                                let branch = probe.branch.clone().unwrap_or_default();
                                self.debug_line(
                                    sid,
                                    token,
                                    &if ok {
                                        format!(
                                            "conductor: base probe: it passes on origin/{branch}"
                                        )
                                    } else {
                                        format!(
                                            "conductor: base probe: it fails on origin/{branch} too"
                                        )
                                    },
                                );
                                if ok {
                                    SetupOnBase::Pass
                                } else {
                                    SetupOnBase::Fail
                                }
                            }
                        };
                        out.setup_on_base = Some(if cancel.is_cancelled() {
                            SetupOnBase::Unknown
                        } else {
                            verdict
                        });
                        out.base_ref = probe.branch;
                        return Ok(r);
                    }
                }
            }
            let held = held.expect("set above");
            mine = Some(held.clone());
            let (at, inside) = resolve_inside(&held.dir, p.cwd.as_deref());
            if !inside {
                out.not_run = Some("invalid cwd".into());
                return Ok(self.not_run(sid, token, "invalid cwd"));
            }
            // M2-T30: `npm run build` runs as `pnpm run build` in a pnpm repo.
            let cmd = managed_command(&held.dir, &p.cmd);
            if let Some(missing) = missing_manager(&cmd, None) {
                out.not_run = Some(missing.clone());
                return Ok(self.not_run(sid, token, &missing));
            }
            self.debug_line(
                sid,
                token,
                &format!("conductor: `{cmd}` in a fresh checkout of {want}"),
            );
            let r = exec(cmd, at).await?;
            ok = r.exit_code == Some(0) && !r.timed_out;
            Ok(r)
        }
        .await;
        // Any failure, or the last check: this run's checkout goes (and nothing newer).
        if (!ok || co.last)
            && let Some(mine) = &mine
        {
            let mut st = self.lock();
            self.drop_checkout(&mut st, &sid, Some(mine));
        }
        r
    }

    /// ADR-0010: an entry action, performed by this daemon in the session's worktree with the
    /// machine's own git / gh credentials. Acked at once; the outcome follows as `action_result`.
    fn run_action(&self, st: &mut State, m: Meta, p: RunActionPayload) -> Result<(), String> {
        if p.action == RunActionPayloadAction::EvaluateConditions {
            return self.evaluate_conditions(st, m, p);
        }
        let sid = m.sid;
        let token = m.token;
        let s = self.store().session(&sid.to_string()).cloned();
        let Some(s) = s.filter(|s| Path::new(&s.worktree_path).exists()) else {
            self.finish(m, false, Some("unknown_session"));
            return Ok(());
        };
        let cancel = CancelToken::new();
        st.live.entry(sid).or_default().cmds.insert(
            p.command_id,
            RunningCmd {
                fencing_token: token,
                cancel: cancel.clone(),
            },
        );
        self.finish(m, true, None);
        self.touch(&sid);
        let action = p.action.to_string();
        self.send_output(
            st,
            sid,
            token,
            "debug",
            &format!("conductor: {action} for {}", p.target_state),
        );
        let Some(core) = self.arc() else {
            return Ok(());
        };
        tokio::spawn(async move {
            let r = if p.action == RunActionPayloadAction::OpenPr {
                let str_arg = |k: &str, fallback: &str| {
                    p.args
                        .get(k)
                        .and_then(|v| v.as_str())
                        .unwrap_or(fallback)
                        .to_string()
                };
                let input = OpenPrInput {
                    worktree: PathBuf::from(&s.worktree_path),
                    // The daemon's own records (not the message): the branch it created the
                    // worktree on and the repo it cloned.
                    branch: s.branch.clone(),
                    repo: s.repo.clone(),
                    policy: core.workspace.policy().clone(),
                    title: str_arg("title", &s.branch),
                    body: str_arg("body", "Opened by conductor."),
                    root: core.config.root_dir.clone(),
                    expected_sha: p.expected_sha.clone(),
                    gh: core.gh.clone(),
                    after_fetch: None,
                    env: None,
                };
                // TD-205: a kill drops the future (its git / gh child runs to its own timeout).
                tokio::select! {
                    r = open_pr(input) => r,
                    () = cancel.cancelled() => OpenPrResult::Err { error: "aborted".into() },
                }
            } else {
                // TD-209: inspect_pr / merge_pr / close_pr are MR-T17b (M2-T28d).
                OpenPrResult::Err {
                    error: format!("{action} is not supported by this daemon"),
                }
            };
            let st = &mut core.lock();
            if let Some(l) = st.live.get_mut(&sid) {
                l.cmds.remove(&p.command_id);
            }
            let (result, error, line) = match r {
                OpenPrResult::Ok { url, reused } => (
                    json!({ "pr_url": url }),
                    Value::Null,
                    format!(
                        "conductor: pull request {url}{}",
                        if reused { " (existing)" } else { "" }
                    ),
                ),
                OpenPrResult::Err { error } => (
                    Value::Null,
                    json!(error),
                    format!("conductor: {action} failed: {error}"),
                ),
            };
            core.send_output(st, sid, token, "debug", &line);
            core.emit(
                st,
                sid,
                token,
                json!({
                    "kind": "action_result",
                    "data": {
                        "command_id": p.command_id,
                        "action": action,
                        "result": result,
                        "error": error,
                    },
                }),
            );
        });
        Ok(())
    }

    /// ADR-0011 `evaluate_conditions`: read-only, needs no worktree, so it is accepted for a
    /// session this daemon doesn't hold (ADR-0016). gh runs in the daemon root with the open_pr
    /// hardening. A kill aborts it like a command.
    fn evaluate_conditions(
        &self,
        st: &mut State,
        m: Meta,
        p: RunActionPayload,
    ) -> Result<(), String> {
        let sid = m.sid;
        let token = m.token;
        let args = wire::<EvaluateConditionsArgs>(Value::Object(p.args.0.clone())).and_then(|a| {
            // zod's `.min(1)` (TD-196: the generated type doesn't check it).
            if a.conditions.is_empty() {
                Err("conditions: Too small: expected array to have >=1 items".into())
            } else {
                Ok(a)
            }
        });
        let had_live = st.live.contains_key(&sid);
        let cancel = CancelToken::new();
        st.live.entry(sid).or_default().cmds.insert(
            p.command_id,
            RunningCmd {
                fencing_token: token,
                cancel: cancel.clone(),
            },
        );
        self.finish(m, true, None);
        self.touch(&sid);
        let cmd_id = p.command_id;
        let report = move |c: &Core, st: &mut State, result: Value, error: Value| {
            let remove = match st.live.get_mut(&sid) {
                Some(l) => {
                    l.cmds.remove(&cmd_id);
                    // Don't keep an empty entry for a session that only came here to be
                    // evaluated.
                    !had_live && l.agent.is_none() && l.starting.is_none() && l.cmds.is_empty()
                }
                None => false,
            };
            if remove {
                st.live.remove(&sid);
            }
            c.emit(
                st,
                sid,
                token,
                json!({
                    "kind": "action_result",
                    "data": {
                        "command_id": cmd_id,
                        "action": "evaluate_conditions",
                        "result": result,
                        "error": error,
                    },
                }),
            );
        };
        let args = match args {
            Ok(a) => a,
            Err(e) => {
                let first = e.lines().next().unwrap_or("").to_string();
                report(
                    self,
                    st,
                    Value::Null,
                    json!(format!("evaluate_conditions: invalid args: {first}")),
                );
                return Ok(());
            }
        };
        self.send_output(
            st,
            sid,
            token,
            "debug",
            &format!("conductor: evaluating conditions for {}", p.target_state),
        );
        let Some(core) = self.arc() else {
            return Ok(());
        };
        // ADR-0037 P2: a `cmd` condition runs in a fresh checkout fetched from the session's
        // worktree (this daemon's own record of it and its branch, never the message's), through
        // the command runner; a session this daemon doesn't hold leaves it pending.
        let session = self
            .store()
            .session(&sid.to_string())
            .cloned()
            .filter(|s| Path::new(&s.worktree_path).exists());
        let runner = self.command_runner(st);
        let ticket = session.as_ref().map(|s| s.ticket_id.clone());
        let exec_cancel = cancel.clone();
        let exec: CmdExec = Arc::new(move |cmd: String, cwd: PathBuf, limit: Duration| {
            let mut o = RunCommandOptions::new(cmd_id, sid, cmd, cwd);
            o.timeout = Some(limit);
            let mut env = BTreeMap::new();
            env.insert("CONDUCTOR_SESSION_ID".into(), sid.to_string());
            if let Some(t) = &ticket {
                env.insert("CONDUCTOR_TICKET_ID".into(), t.clone());
            }
            o.env = env;
            o.cancel = Some(exec_cancel.clone());
            let runner = runner.clone();
            Box::pin(async move {
                match runner.run(o).await {
                    Ok(r) => CmdExecResult {
                        exit_code: r.exit_code,
                        timed_out: r.timed_out,
                        output_tail: r.output_tail,
                    },
                    Err(e) => CmdExecResult {
                        exit_code: None,
                        timed_out: false,
                        output_tail: format!("conductor: command could not be spawned: {e}"),
                    },
                }
            })
        });
        let input = EvaluateConditionsInput {
            conditions: args.conditions,
            pr_url: args.pr_url,
            head_sha: args.head_sha.map(|h| h.to_string()),
            root: self.config.root_dir.clone(),
            gh: self.gh.clone(),
            env: None,
            timeout_ms: None,
            short_circuit: args.short_circuit == Some(true),
            cmd: Some(CmdContext {
                root: self.config.root_dir.clone(),
                worktree: session.map(|s| (PathBuf::from(&s.worktree_path), s.branch.clone())),
                setup: args.setup.flatten().map(String::from),
                exec,
                env: None,
                checkout: None,
                resolve_head: None,
                path: None,
            }),
        };
        tokio::spawn(async move {
            // TD-205: a kill drops the future.
            let r = tokio::select! {
                r = evaluate_conditions(input) => Ok(r),
                () = cancel.cancelled() => Err("aborted".to_string()),
            };
            let mut st = core.lock();
            match r {
                Ok(r) => {
                    let v = serde_json::to_value(r).unwrap_or_default();
                    report(&core, &mut st, v, Value::Null);
                }
                Err(e) => report(
                    &core,
                    &mut st,
                    Value::Null,
                    json!(format!("evaluate_conditions failed: {e}")),
                ),
            }
        });
        Ok(())
    }

    /// 10-contracts §Orphaned processes, rule 5.
    fn kill(&self, st: &mut State, m: Meta, p: KillPayload) -> Result<(), String> {
        let sid = m.sid;
        let agent = st.live_agent(&sid);
        let agent_info = agent
            .and_then(|id| st.agents.get(&id))
            .map(|a| (a.command_id, a.fencing_token));
        if let Some(starting) = st.live.get(&sid).map(|l| l.starting) {
            match p.target_command_id {
                Some(target) => {
                    if let (Some(id), Some((cid, _))) = (agent, agent_info)
                        && cid == target
                    {
                        self.stop_agent(st, id, &p.reason);
                    }
                    if let Some(s) = starting.and_then(|id| st.startings.get_mut(&id))
                        && s.command_id == target
                    {
                        s.cancelled = true;
                    }
                }
                None => {
                    if let (Some(id), Some((_, tok))) = (agent, agent_info)
                        && tok <= m.token
                    {
                        self.stop_agent(st, id, &p.reason);
                    }
                    if let Some(s) = starting.and_then(|id| st.startings.get_mut(&id))
                        && s.fencing_token <= m.token
                    {
                        s.cancelled = true;
                    }
                    if let Some(l) = st.live.get(&sid) {
                        for c in l.cmds.values() {
                            if c.fencing_token <= m.token {
                                c.cancel.cancel();
                            }
                        }
                    }
                }
            }
        }
        // A session kill ends any entry step: its checkout goes too.
        if p.target_command_id.is_none()
            && let Some(held) = st.checkouts.get(&sid).cloned()
            && held.token <= m.token
        {
            self.drop_checkout(st, &sid, Some(&held));
        }
        self.finish(m, true, None);
        Ok(())
    }

    /// BUG-1: the one way an agent process is killed (kill command, supersede, daemon stop).
    /// Signals once and logs once, however often the same kill arrives.
    fn stop_agent(&self, st: &mut State, id: u64, reason: &str) {
        let Some(a) = st.agents.get_mut(&id) else {
            return;
        };
        if a.exited || a.kill_requested {
            return;
        }
        a.kill_requested = true;
        let msg = format!(
            "session {}: kill ({reason}) stops process {}",
            a.sid, a.command_id
        );
        let session = a.session.clone();
        self.log(&msg);
        session.kill(Some(Duration::from_millis(self.config.kill_grace_ms)));
    }

    /// BUG-1/BUG-1b: kill a Claude process a previous daemon left running, only if it is
    /// provably ours (orphan `check_ours`). Anything else is logged and left alone. SIGTERM to
    /// the group; the check is repeated before the SIGKILL after the grace period.
    fn kill_orphan(&self, sid: &str, agent: &AgentRecord) {
        let Some(pid) = agent.pid else {
            return;
        };
        if agent.started_at.is_none() {
            // FR-4: written by BUG-1's build; the caller clears the entry.
            self.log(&format!(
                "orphan sweep: pid {pid} of session {sid} has no recorded start time (old entry); left alone"
            ));
            return;
        }
        let log = self.log.clone();
        let not_ours = move |reason: &str, extra: &str| {
            log(&format!(
                "orphan sweep: pid {pid} alive but not ours ({reason}); left alone{extra}"
            ));
        };
        let check = {
            let proc_info = self.proc_info.clone();
            let bin = self.claude_bin.clone();
            let agent = agent.clone();
            move || -> Result<(), &'static str> {
                let info = proc_info(pid);
                let facts = info.as_ref().map(ProcFacts::from);
                check_ours(
                    facts.as_ref(),
                    &StoredAgent {
                        started_at_ms: agent.started_at,
                        claude_session_id: agent.claude_session_id.as_deref(),
                    },
                    &bin,
                )
            }
        };
        match pid_liveness(pid) {
            Liveness::Gone => return,
            Liveness::NotSignalable => return not_ours("not signalable", ""),
            Liveness::Alive => {}
        }
        if let Err(reason) = check() {
            return not_ours(reason, "");
        }
        // POSIX the process group (ESRCH: gone); win32 taskkill /T (TD-189).
        if !platform::signal_tree(pid, Signal::Term) {
            return;
        }
        self.log(&format!(
            "startup: killed orphaned claude process {pid} of session {sid}"
        ));
        let grace = Duration::from_millis(self.config.kill_grace_ms);
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            if pid_liveness(pid) != Liveness::Alive {
                return;
            }
            if let Err(reason) = check() {
                return not_ours(reason, " (no SIGKILL)");
            }
            platform::signal_tree(pid, Signal::Kill);
        });
    }

    // ============================================================ ADR-0033 P2: assistant jobs

    fn assistant_job(&self, st: &mut State, job: AssistantJobPayload) {
        let m = Meta {
            kind: "assistant_job",
            cid: Some(job.command_id),
            sid: Uuid::nil(),
            token: 0,
        };
        if !self.dedupe(st, m) {
            return;
        }
        st.in_flight.remove(&job.command_id);
        let Some(admission) = self.assistant.admit() else {
            self.finish(m, false, Some("light_slot_busy"));
            return;
        };
        self.finish(m, true, None);
        let Some(core) = self.arc() else {
            return;
        };
        // TD-210: a job still running when the daemon stops is not killed (its claude exits at
        // the job timeout, at most 120 s), and its result is lost with the process.
        tokio::spawn(async move {
            let payload = core.assistant.run(admission, &job).await;
            let st = core.lock();
            core.push_durable(
                &st,
                DurableMessage::AssistantResult {
                    msg_id: Uuid::new_v4(),
                    session_id: (),
                    fencing_token: (),
                    payload,
                },
            );
        });
    }

    // ============================================================ transcripts (ADR-0008)

    /// The reply to `fetch_transcript`, located only from this daemon's store (never from the
    /// request). Read-only: no ack, no dedupe, nothing persisted.
    fn transcript(&self, request_id: Uuid, session_id: Uuid) -> TranscriptPayload {
        let err = |e: &str| {
            wire::<TranscriptPayload>(json!({ "request_id": request_id, "error": e }))
                .expect("a transcript error payload")
        };
        let s = self.store().session(&session_id.to_string()).cloned();
        let Some(s) = s else {
            return err("unknown_session");
        };
        let Some(claude_id) = s.claude_session_id else {
            return err("no_transcript");
        };
        let Some(path) = find_transcript(
            &self.config.claude_config_dir,
            Path::new(&s.worktree_path),
            &claude_id,
        ) else {
            return err("no_transcript");
        };
        // TD-089: a synchronous read (at most TRANSCRIPT_READ_BYTES).
        match read_transcript_tail(&path) {
            Ok((text, cut)) => {
                let (chunks, truncated) = transcript_chunks(&text);
                wire(json!({
                    "request_id": request_id,
                    "chunks": chunks,
                    "truncated": truncated || cut,
                }))
                .unwrap_or_else(|e| {
                    self.log(&format!("transcript for session {session_id}: {e}"));
                    err("read_failed")
                })
            }
            Err(e) => {
                self.log(&format!(
                    "transcript for session {session_id}: {}",
                    err_text(e)
                ));
                err("read_failed")
            }
        }
    }

    // ============================================================ helpers

    /// The session's port range; on exhaustion, reclaim the least recently used idle session's.
    fn allocate_ports(&self, st: &mut State, sid: &Uuid) -> Result<PortRange, String> {
        let key = sid.to_string();
        if let Some(r) = st.ports.range_of(&key) {
            return Ok(r);
        }
        if st.ports.allocated() as u32 >= st.ports.capacity() {
            // TD-024: ranges are only freed by reclaiming the least recently used session that
            // has no live process or command.
            let mut store = self.store();
            let idle = store
                .sessions()
                .iter()
                .filter(|(id, s)| {
                    **id != key
                        && s.port_range.is_some()
                        && !Uuid::parse_str(id).is_ok_and(|u| st.is_busy(&u))
                })
                .min_by_key(|(_, s)| s.last_used_at)
                .map(|(id, s)| (id.clone(), s.clone()));
            if let Some((id, s)) = idle {
                st.ports.release(&id);
                let _ = store.put_session(
                    &id,
                    PersistedSession {
                        port_range: None,
                        ..s
                    },
                );
            }
        }
        st.ports
            .allocate(&key)
            .map_err(|_| "port pool exhausted".to_string())
    }

    fn touch(&self, sid: &Uuid) {
        let mut store = self.store();
        if let Some(s) = store.session(&sid.to_string()).cloned() {
            let _ = store.put_session(
                &sid.to_string(),
                PersistedSession {
                    last_used_at: now_ms(),
                    ..s
                },
            );
        }
    }

    fn git_env(&self) -> Vec<(String, String)> {
        let c = &self.config;
        vec![
            ("GIT_AUTHOR_NAME".into(), c.git_name.clone()),
            ("GIT_AUTHOR_EMAIL".into(), c.git_email.clone()),
            ("GIT_COMMITTER_NAME".into(), c.git_name.clone()),
            ("GIT_COMMITTER_EMAIL".into(), c.git_email.clone()),
        ]
    }

    fn stop(&self, kill_sessions: bool) {
        self.ws.stop();
        let mut st = self.lock();
        st.stopped = true;
        self.on_close(&mut st);
        self.inventory.stop();
        if let Some(w) = st.rescan_watch.take() {
            w.abort();
        }
        for (_, t) in st.assignments.drain() {
            t.cancel();
        }
        self.update_stop(&mut st);
        if kill_sessions {
            // ADR-0023: every held permission prompt is denied before its process is stopped.
            for p in &st.sent_permissions {
                if let Some(a) = st.agents.get(&p.agent) {
                    a.session
                        .deny_permission(&p.request_id, PERMISSION_SHUTDOWN);
                }
            }
            let ids: Vec<u64> = st
                .live
                .keys()
                .filter_map(|sid| st.live_agent(sid))
                .collect();
            for id in ids {
                self.stop_agent(&mut st, id, "daemon stopping");
            }
            for l in st.live.values() {
                for c in l.cmds.values() {
                    c.cancel.cancel();
                }
            }
        }
    }
}

/// What run_cmd's `work()` learnt on the way (`cmd_exit` fields).
#[derive(Default)]
struct RunOutcome {
    head_sha: Option<String>,
    dirty: Option<Vec<String>>,
    setup_failed: bool,
    /// With `setup_failed`: the setup that ran, its verdict on the base branch, and that branch.
    setup_cmd: Option<String>,
    setup_on_base: Option<SetupOnBase>,
    base_ref: Option<String>,
    /// The command did not run, and why (`cmd_exit.not_run`).
    not_run: Option<String>,
    /// No commits ahead of origin's default branch (`cmd_exit.no_commits`).
    no_commits: bool,
    /// R3: no change matched the check's `paths`, so it did not run: why (`cmd_exit.skipped`).
    skipped: Option<String>,
}

impl Daemon {
    /// Build the daemon (the TS constructor): make `<root>` private, open the store, sweep
    /// leftover checkouts, adopt port ranges, and settle processes a previous daemon left (BUG-1:
    /// kill the provable orphans, report `exit {signal: daemon_restart}`). Needs a tokio runtime.
    pub fn new(o: DaemonOptions) -> Result<Daemon, DaemonError> {
        let config = o.config;
        let log: Log = o
            .log
            .unwrap_or_else(|| Arc::new(|m: &str| eprintln!("[conductor-daemon] {m}")));
        // Private (0700 / owner-only DACL): <root>/private and machine.json live under it.
        mkdir_private(&config.root_dir).map_err(|e| DaemonError::Root(e.to_string()))?;
        let store = Arc::new(Mutex::new(DaemonStore::for_root(&config.root_dir)?));
        // Fresh checkouts / push repos a previous daemon left behind (ADR-0010).
        sweep_private(&config.root_dir);
        // ADR-0021: a download a previous daemon was staging when it stopped.
        crate::update::layout::sweep_staging(&config.root_dir);
        let workspace = Arc::new(Workspace::new(
            config.root_dir.clone(),
            store.clone(),
            WorkspaceOptions {
                policy: (&config).into(),
                log: Some({
                    let log = log.clone();
                    Box::new(move |m: &str| log(m))
                }),
                env: None,
            },
        ));
        let env = o.env.unwrap_or_else(platform::spawn::process_env);
        let claude_bin = o.claude_bin.unwrap_or_else(|| {
            std::env::var("CONDUCTOR_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
        });
        let sysinfo = o.sysinfo.unwrap_or_else(live_sysinfo);
        let claude_dir = config.claude_config_dir.clone();
        let transcripts = {
            let store = store.clone();
            let dir = claude_dir.clone();
            Arc::new(move |sid: Uuid| {
                let (wt, id) = {
                    let s = store.lock().unwrap_or_else(|e| e.into_inner());
                    let x = s.session(&sid.to_string())?;
                    (x.worktree_path.clone(), x.claude_session_id.clone()?)
                };
                read_session_transcript(&dir, Path::new(&wt), &id)
            })
        };
        let assistant = AssistantJobRunner::new(AssistantJobRunnerOptions {
            bin: claude_bin.clone(),
            base_env: env.clone(),
            light_slots: config.light_slots.max(1) as usize,
            tmp_parent: std::env::temp_dir(),
            transcripts,
        })
        .map_err(DaemonError::Assistant)?;
        let headers = match &config.credential {
            // M2-T04: the machine credential on every upgrade; local mode sends no header.
            Some(c) => vec![(DAEMON_AUTH_HEADER.to_string(), daemon_auth_header_value(c))],
            None => Vec::new(),
        };
        let scan: ScanFn = match o.scan_inventory {
            Some(s) => s,
            None => {
                let config = config.clone();
                let env = env.clone();
                // Scan warnings repeat on every rescan: print each one once per process.
                let log = once_log(log.clone(), ONCE_LOG_CAP);
                Arc::new(move || {
                    let (config, env, log) = (config.clone(), env.clone(), log.clone());
                    async move { Ok::<InventoryScan, String>(scan_inventory(&config, &env, log).await) }
                        .boxed()
                })
            }
        };
        let has_conversation = o.has_conversation.unwrap_or_else(|| {
            let dir = claude_dir.clone();
            Arc::new(move |cwd: &Path, id: &str| has_transcript_in_cwd(&dir, cwd, id))
        });
        let on_fatal = o.on_fatal.unwrap_or_else(|| {
            let log = log.clone();
            Arc::new(move |code: u16, _: &str| log(&format!("link failed ({code}); stopped")))
        });
        let create_runner = o.create_command_runner.unwrap_or_else(|| {
            Arc::new(|n: usize| Arc::from(crate::commands::create_command_runner(n)))
        });
        let ports = PortPool::new(config.port_pool);
        let core = Arc::new_cyclic(|me: &Weak<Core>| {
            let ws = ReconnectingWs::new(
                config.orchestrator_url.clone(),
                config.reconnect,
                Arc::new(Link(me.clone())),
                WsClientOptions {
                    headers,
                    log: Some(log.clone()),
                    ..WsClientOptions::default()
                },
            );
            let inventory = {
                let ws = ws.clone();
                let log2 = log.clone();
                InventoryReporter::new(
                    scan,
                    Arc::new(move |payload| {
                        let v = json!({
                            "type": "inventory",
                            "msg_id": Uuid::new_v4(),
                            "seq": null,
                            "session_id": null,
                            "fencing_token": null,
                            "payload": payload,
                        });
                        match wire::<DaemonToOrchestrator>(v) {
                            Ok(m) => send_frame(&ws, &m),
                            Err(e) => log2(&format!("bug: an invalid inventory frame: {e}")),
                        }
                    }),
                    Duration::from_millis(config.inventory_interval_ms),
                    log.clone(),
                )
            };
            Core {
                me: me.clone(),
                config: config.clone(),
                store: store.clone(),
                workspace,
                driver: o.driver,
                create_runner,
                sysinfo,
                claude_code_version: o.claude_code_version,
                gh: o.gh_command,
                log: log.clone(),
                on_fatal,
                claude_bin,
                proc_info: o.proc_info.unwrap_or_else(|| Arc::new(read_proc_info)),
                has_conversation,
                ws,
                inventory,
                assistant,
                supervised: o.supervised,
                stage_update: o.stage_update.unwrap_or_else(|| {
                    updating::default_stage(
                        config.root_dir.clone(),
                        config.orchestrator_url.clone(),
                    )
                }),
                on_restart_for_update: o.on_restart_for_update.unwrap_or_else(|| {
                    let log = log.clone();
                    Arc::new(move || log("update: restart requested (exit 75)"))
                }),
                update_max_drain_ms: o
                    .update_max_drain_ms
                    .unwrap_or(conductor_protocol::UPDATE_MAX_DRAIN_MS),
                update_trial_register_ms: o
                    .update_trial_register_ms
                    .unwrap_or(conductor_protocol::UPDATE_TRIAL_REGISTER_MS),
                clock_start: tokio::time::Instant::now(),
                state: Mutex::new(State {
                    registered: false,
                    stopped: false,
                    heartbeat_ms: config.heartbeat_interval_ms,
                    heartbeat_timer: None,
                    work_timer: None,
                    awaiting_work: None,
                    last_no_work: None,
                    last_inventory_digest: String::new(),
                    live: HashMap::new(),
                    agents: HashMap::new(),
                    startings: HashMap::new(),
                    assignments: HashMap::new(),
                    in_flight: HashSet::new(),
                    checkouts: HashMap::new(),
                    sent_permissions: Vec::new(),
                    runner: None,
                    ports,
                    next_id: 0,
                    rescan_watch: None,
                    update: updating::UpdateState::default(),
                }),
            }
        });
        {
            let mut st = core.lock();
            let sessions: Vec<(String, PersistedSession)> = core
                .store()
                .sessions()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for (sid, s) in sessions {
                if let Some(r) = s.port_range {
                    st.ports.adopt(&sid, r);
                }
                if let Some(Some(agent)) = &s.agent {
                    // BUG-1: the previous daemon stopped with this process running. It may still
                    // be alive: kill it, then report the exit, so the orchestrator resumes
                    // instead of waiting for the lease to expire.
                    core.kill_orphan(&sid, agent);
                    match (Uuid::parse_str(&sid), Uuid::parse_str(&agent.command_id)) {
                        (Ok(u), Ok(cid)) => core.emit(
                            &st,
                            u,
                            agent.fencing_token,
                            json!({
                                "kind": "exit",
                                "data": { "command_id": cid, "code": null, "signal": "daemon_restart" },
                            }),
                        ),
                        _ => core.log(&format!("store: session {sid} has an invalid id")),
                    }
                    let _ = core.store().put_session(
                        &sid,
                        PersistedSession {
                            agent: Some(None),
                            ..s.clone()
                        },
                    );
                }
            }
            drop(st);
        }
        Ok(Daemon { core })
    }

    /// Start the inventory reporter, the rescan trigger watcher and the link.
    pub fn start(&self) {
        let c = &self.core;
        c.inventory.start();
        {
            let mut st = c.lock();
            if st.rescan_watch.is_none() {
                st.rescan_watch = Some(watch_rescan_trigger(
                    &c.config.root_dir,
                    c.inventory.clone(),
                    RESCAN_POLL,
                ));
            }
        }
        c.ws.start();
    }

    /// SIGHUP / the rescan trigger: rescan the inventory and send it if it changed.
    pub async fn rescan_inventory(&self) {
        self.core.inventory.rescan().await;
    }

    /// Stop the link and timers. `kill_sessions` also kills every live process (after denying
    /// every held permission prompt) and aborts every command.
    pub fn stop(&self, kill_sessions: bool) {
        self.core.stop(kill_sessions);
    }

    pub fn is_registered(&self) -> bool {
        self.core.lock().registered
    }

    pub fn config(&self) -> &DaemonConfig {
        &self.core.config
    }

    /// The daemon's store (locked: keep the guard short).
    pub fn store(&self) -> MutexGuard<'_, DaemonStore> {
        self.core.store()
    }

    pub fn workspace(&self) -> &Workspace {
        &self.core.workspace
    }

    /// M2-T10: the `inventory` message's reporter.
    pub fn inventory(&self) -> &InventoryReporter {
        &self.core.inventory
    }

    /// Claude Code's config dir (where its transcripts are), as the agents see it.
    pub fn claude_config_dir(&self) -> &Path {
        &self.core.config.claude_config_dir
    }

    /// The reply to `fetch_transcript` for `session_id`.
    pub fn transcript(&self, request_id: Uuid, session_id: Uuid) -> TranscriptPayload {
        self.core.transcript(request_id, session_id)
    }
}

mod updating;

#[cfg(test)]
mod tests;
