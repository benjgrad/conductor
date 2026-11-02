//! Port of `packages/daemon/src/claude/driver.ts` (MR-T06): the Claude Code driver contract of
//! ADR-0005 §Contract.
//!
//! `claude/cli_driver` (MR-T09) implements it, `claude/fake_driver` is the scripted fake, and the
//! daemon core (MR-T12) consumes it. That makes this shape costly to change later: keep it
//! object-safe (`Arc<dyn DriverSession>`) and `Send + Sync`.
//!
//! Events: a session pushes [`DriverEvent`]s to listeners registered with
//! [`DriverSession::on`]. As in TS, `start` is synchronous (it fails only where the TS `start`
//! throws: a claude that isn't a native .exe on Windows, U-110, or the session's private files
//! can't be written) and every event is emitted
//! asynchronously (on a spawned task), so a listener attached right after `start` sees every
//! event, the first `claude_session_id` included. A listener is called from the session's task
//! with no session lock held, so it may call back into the session (`send_input` …). It must not
//! block. [`Listeners`] is the shared registry implementations use.
//!
//! Mapping to WS `session_event` kinds (03): `claude_session_id`, `ask_user`, `complete_state`,
//! `spend` and `exit` are forwarded as is (`spend` gains `claude_session_id`). `output` goes to the
//! WS `output` message. `turn_end` stays inside the daemon (park / end). `tools` is built from the
//! state's workflow `tools` list with `resolve_tool_policy`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conductor_protocol::{
    AgentTransitionOption, JsonObject, PermissionBehavior, PermissionScope, StartSessionPayloadMcp,
};

/// `--tools` / `--allowedTools` / `--disallowedTools` (the TS `ToolPolicy`).
pub use conductor_protocol::tool_policy::ToolPolicy;

/// `DriverStartOptions`.
#[derive(Clone, Debug, PartialEq)]
pub struct DriverStartOptions {
    /// The session worktree.
    pub cwd: PathBuf,
    /// The first user message (the answer, when resuming after ask_user).
    pub prompt: String,
    pub tools: ToolPolicy,
    /// Pre-assigned by the daemon (new) or the id to resume.
    pub claude_session_id: String,
    /// True → `--resume claude_session_id`, else `--session-id`.
    pub resume: bool,
    /// Merged over the daemon env (ports, git identity).
    pub env: BTreeMap<String, String>,
    pub model: Option<String>,
    pub max_turns: Option<u32>,
    /// The remaining workflow budget, passed as a hard backstop.
    pub max_budget_usd: Option<f64>,
    /// Conductor instructions (complete_state / ask_user / permission prompts).
    pub append_system_prompt: Option<String>,
    /// ADR-0009: a requirements reviewer (`--permission-mode dontAsk`).
    pub review: bool,
    /// ADR-0029: `start_session.mcp`. `None` = `none` (only conductor's servers).
    pub mcp: Option<StartSessionPayloadMcp>,
    /// ADR-0011: the names the outcome server accepts in `complete_state`. `None` or empty = any.
    pub transitions: Option<Vec<AgentTransitionOption>>,
}

impl DriverStartOptions {
    /// The required fields; every optional one absent (`review` false).
    pub fn new(
        cwd: impl Into<PathBuf>,
        prompt: impl Into<String>,
        tools: ToolPolicy,
        claude_session_id: impl Into<String>,
        resume: bool,
    ) -> Self {
        DriverStartOptions {
            cwd: cwd.into(),
            prompt: prompt.into(),
            tools,
            claude_session_id: claude_session_id.into(),
            resume,
            env: BTreeMap::new(),
            model: None,
            max_turns: None,
            max_budget_usd: None,
            append_system_prompt: None,
            review: false,
            mcp: None,
            transitions: None,
        }
    }
}

/// The `output` event's stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputStream {
    Assistant,
    ToolUse,
    ToolResult,
    Stderr,
    Debug,
}

impl OutputStream {
    /// The TS / wire name (`tool_use`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            OutputStream::Assistant => "assistant",
            OutputStream::ToolUse => "tool_use",
            OutputStream::ToolResult => "tool_result",
            OutputStream::Stderr => "stderr",
            OutputStream::Debug => "debug",
        }
    }
}

/// The `spend` event's token counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// `DriverEvent`: an in-process event, not a wire frame (the daemon core maps it to
/// `SessionEventPayload`).
#[derive(Clone, Debug, PartialEq)]
pub enum DriverEvent {
    /// Once, from the first system/init.
    ClaudeSessionId {
        id: String,
    },
    Output {
        stream: OutputStream,
        text: String,
    },
    AskUser {
        question: String,
    },
    /// ADR-0023: Claude called the `permission` prompt tool; the call is held until
    /// `resolve_permission` / `deny_permission`, its timeout at `expires_at`, or the exit.
    PermissionRequest {
        request_id: String,
        tool: String,
        input: JsonObject,
        suggestions: Option<Vec<JsonObject>>,
        tool_use_id: Option<String>,
        /// ISO 8601, as JS `toISOString()`.
        expires_at: String,
    },
    CompleteState {
        result: serde_json::Map<String, serde_json::Value>,
        /// ADR-0011: the transition the agent named (absent = `done`), and why.
        transition: Option<String>,
        reason: Option<String>,
    },
    /// The process is now idle.
    TurnEnd {
        is_error: bool,
        subtype: String,
        permission_denials: u32,
    },
    Spend {
        total_usd: f64,
        usage: Usage,
    },
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
}

impl DriverEvent {
    /// The TS `kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            DriverEvent::ClaudeSessionId { .. } => "claude_session_id",
            DriverEvent::Output { .. } => "output",
            DriverEvent::AskUser { .. } => "ask_user",
            DriverEvent::PermissionRequest { .. } => "permission_request",
            DriverEvent::CompleteState { .. } => "complete_state",
            DriverEvent::TurnEnd { .. } => "turn_end",
            DriverEvent::Spend { .. } => "spend",
            DriverEvent::Exit { .. } => "exit",
        }
    }
}

/// ADR-0023: a human's decision for a held permission prompt (the TS `PermissionDecision`).
#[derive(Clone, Debug, PartialEq)]
pub struct PermissionDecision {
    pub behavior: PermissionBehavior,
    pub scope: PermissionScope,
    pub message: Option<String>,
    pub rule: Option<String>,
}

/// What `resolve_permission` did: resolved now, already resolved by a decision, or not held
/// (timed out, denied, process gone).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionResolution {
    Resolved,
    Duplicate,
    Unknown,
}

/// `send_input` / `send_message` on a session whose process is gone.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DriverError {
    #[error("claude: the process has exited")]
    Exited,
    #[error("claude: {0}")]
    Other(String),
}

/// A listener for a session's events.
pub type DriverListener = Arc<dyn Fn(&DriverEvent) + Send + Sync>;

/// What `on` returns; pass it to `off` to detach (the TS unsubscribe closure).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ListenerId(u64);

/// `DriverSession`.
pub trait DriverSession: Send + Sync {
    /// The requested id, or the one the CLI's system/init reported if it differs (an owned
    /// `String`, because the CLI driver may update it while the session runs).
    fn claude_session_id(&self) -> String;
    /// BUG-1: the OS pid of the Claude process (its own group / job leader), when there is one.
    fn pid(&self) -> Option<u32>;
    fn on(&self, listener: DriverListener) -> ListenerId;
    fn off(&self, id: ListenerId);
    /// A live answer; queued by Claude if a turn is running.
    fn send_input(&self, text: &str) -> Result<(), DriverError>;
    /// ADR-0007: a human's message to the running agent. Not an answer: a pending ask_user stays.
    fn send_message(&self, text: &str) -> Result<(), DriverError>;
    /// ADR-0023: a human's decision for a held permission prompt. A driver without permission
    /// prompts holds none.
    fn resolve_permission(
        &self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> PermissionResolution {
        PermissionResolution::Unknown
    }
    /// ADR-0023: deny a held permission prompt with `message`. False when it isn't held.
    fn deny_permission(&self, _request_id: &str, _message: &str) -> bool {
        false
    }
    /// Graceful: close stdin → exit 0.
    fn end(&self);
    /// SIGTERM (or the job), then SIGKILL after `grace`.
    fn kill(&self, grace: Option<Duration>);
}

/// `ClaudeDriver`. `start` needs a tokio runtime (events are emitted on spawned tasks). An `Err`
/// is the TS `start()` throwing: nothing was registered or spawned.
pub trait ClaudeDriver: Send + Sync {
    fn start(&self, opts: DriverStartOptions) -> Result<Arc<dyn DriverSession>, DriverError>;
}

/// The listener registry of a session, in registration order.
#[derive(Default)]
pub struct Listeners {
    next: AtomicU64,
    list: Mutex<Vec<(ListenerId, DriverListener)>>,
}

impl std::fmt::Debug for Listeners {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Listeners")
            .field("count", &self.lock().len())
            .finish()
    }
}

impl Listeners {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(ListenerId, DriverListener)>> {
        self.list.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn add(&self, listener: DriverListener) -> ListenerId {
        let id = ListenerId(self.next.fetch_add(1, Ordering::Relaxed));
        self.lock().push((id, listener));
        id
    }

    pub fn remove(&self, id: ListenerId) {
        self.lock().retain(|(i, _)| *i != id);
    }

    /// Call every listener with `ev` (on a snapshot, so a listener may add or remove listeners).
    pub fn emit(&self, ev: &DriverEvent) {
        let snapshot: Vec<DriverListener> = self.lock().iter().map(|(_, l)| l.clone()).collect();
        for l in snapshot {
            l(ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listeners_are_called_in_order_and_can_be_removed() {
        let ls = Listeners::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (a, b) = (seen.clone(), seen.clone());
        let ia = ls.add(Arc::new(move |e: &DriverEvent| {
            a.lock().unwrap().push(("a", e.kind()))
        }));
        ls.add(Arc::new(move |e: &DriverEvent| {
            b.lock().unwrap().push(("b", e.kind()))
        }));
        let ev = DriverEvent::AskUser {
            question: "q?".into(),
        };
        ls.emit(&ev);
        ls.remove(ia);
        ls.emit(&ev);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![("a", "ask_user"), ("b", "ask_user"), ("b", "ask_user")]
        );
    }
}
