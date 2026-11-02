//! Port of `packages/daemon/src/claude/outcome-server.ts` (MR-T08): the daemon-hosted MCP outcome
//! server (ADR-0005 §Decision › Outcome server).
//!
//! One streamable-HTTP listener per daemon, bound to 127.0.0.1 (`rmcp` behind `axum`, ADR-0026
//! §5). Each driver session registers a random 128-bit path token (`/mcp/<32 hex>`), which
//! attributes every tool call to exactly one session; the token is dropped when the session's
//! process exits. The server is stateless: no session id, JSON replies, no GET SSE stream.
//!
//! Tools: `complete_state({transition?, reason?, result})` and `ask_user({question})`. Both return
//! immediately with the ADR's texts. Guards live here, per registration, so a refused call never
//! reaches the driver:
//!   - complete_state while a question is pending → corrective text, not emitted
//!   - complete_state a second time → corrective text, not emitted
//!   - ADR-0011: complete_state naming a transition outside the registration's list (absent =
//!     `done`) → corrective text listing the allowed names, not emitted, ONCE; a second unknown
//!     name is emitted as is and the engine routes it to a human. No list = any name passes.
//!   - ask_user after complete_state, or while a question is already pending → corrective text
//!
//! The driver clears the pending question when it delivers the answer (`answered()`).
//!
//! ADR-0023: a third tool, `permission`, is Claude's `--permission-prompt-tool`
//! (`mcp__conductor__permission`). The call is HELD: the registration hands the request to the
//! driver (`on_permission_request`, which the daemon sends as a durable `permission_request`) and
//! the tool returns only when the request is resolved: `resolve_permission` (a human's decision,
//! at most once), `deny_permission`, the timeout (default 30 min, = `expires_at`), or
//! `unregister()` / `close()`, which deny every held call. Input over PERMISSION_INPUT_MAX_BYTES is
//! denied at once and never sent (U-101); suggestions over their bounds are dropped.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use conductor_protocol::json::json_byte_length;
use conductor_protocol::{
    AgentTransitionOption, DEFAULT_PERMISSION_TIMEOUT_MS, JsonObject, PERMISSION_INPUT_MAX_BYTES,
    PERMISSION_MESSAGE_MAX, PERMISSION_SUGGESTIONS_MAX, PERMISSION_SUGGESTIONS_MAX_BYTES,
    PERMISSION_TOOL_MAX, TRANSITION_NAME_MAX, TRANSITION_REASON_MAX,
};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, MetaObject, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tower::ServiceExt;

use crate::claude::driver::{PermissionDecision, PermissionResolution};
use conductor_protocol::{PermissionBehavior, PermissionScope};

// ---- Pure helpers (MR-T06; MR-T08 adds the server below) ----

pub const OUTCOME_SERVER_NAME: &str = "conductor";
pub const COMPLETE_STATE_TOOL: &str = "mcp__conductor__complete_state";
pub const ASK_USER_TOOL: &str = "mcp__conductor__ask_user";
/// ADR-0023: the `--permission-prompt-tool`. Not in OUTCOME_TOOL_NAMES: Claude's permission system
/// calls it, the model never needs to.
pub const PERMISSION_TOOL: &str = "mcp__conductor__permission";
/// The `--allowedTools` entries the driver always adds to the state's allow-list.
pub const OUTCOME_TOOL_NAMES: [&str; 2] = [COMPLETE_STATE_TOOL, ASK_USER_TOOL];

/// The transition `complete_state` takes when it names none (old prompts, ADR-0011).
pub const DEFAULT_TRANSITION: &str = "done";

/// A deny without a note. The decision frame names no user, so "a human" (10-contracts).
pub const PERMISSION_DENIED_ON_BOARD: &str = "Permission denied by a human on the board.";
/// The agent's process went away while the call was held (unregister).
pub const PERMISSION_SESSION_ENDED: &str = "Permission denied: the agent session ended.";
/// An old conductor server answered the request with `protocol_error`.
pub const PERMISSION_UNSUPPORTED_SERVER: &str =
    "Permission denied: this conductor server can't show permission prompts.";
/// The daemon can't forward prompts at all (no handler wired, or forwarding failed).
pub const PERMISSION_NO_HANDLER: &str =
    "Permission denied: this conductor daemon can't show permission prompts.";
/// The daemon is shutting down (close).
pub const PERMISSION_SHUTDOWN: &str = "Permission denied: the conductor daemon is shutting down.";

/// `PERMISSION_TOOL_NAME_TOO_LONG`.
pub fn permission_tool_name_too_long() -> String {
    format!("Permission denied: the tool name is longer than {PERMISSION_TOOL_MAX} characters")
}

/// No human answered before `expires_at`.
pub fn permission_timeout_text(timeout: Duration) -> String {
    // JS Math.max(1, Math.round(ms / 60_000)).
    let min = ((timeout.as_millis() as f64 / 60_000.0) + 0.5)
        .floor()
        .max(1.0);
    format!(
        "Permission denied: no human answered within {min} min. If you still need this, call ask_user to ask a human, then end your turn."
    )
}

/// U-101: the input is over PERMISSION_INPUT_MAX_BYTES; nothing was sent to the board.
pub fn permission_too_large_text(bytes: usize) -> String {
    format!("Permission denied: input too large to review ({bytes} bytes)")
}

// Return texts (ADR-0005), worded as the spike ran them against the real CLI.
pub const COMPLETE_STATE_RETURN: &str =
    "Recorded. Stop now: do not call any other tool and end your turn.";
pub const ASK_USER_RETURN: &str = "Your question was sent to a human. End your turn now without calling more tools. The answer will arrive as the next user message.";
pub const COMPLETE_STATE_PENDING_QUESTION: &str = "Not recorded: a question to the human is still pending. End your turn now and wait for the answer, which arrives as the next user message.";
pub const COMPLETE_STATE_DUPLICATE: &str =
    "Not recorded: complete_state was already recorded for this state. End your turn now.";
pub const ASK_USER_PENDING_QUESTION: &str = "Not sent: a question to the human is already pending. End your turn now and wait for the answer.";
pub const ASK_USER_AFTER_COMPLETE: &str =
    "Not sent: complete_state was already recorded for this state. End your turn now.";

const COMPLETE_STATE_BASE: &str = "Call exactly once when the current workflow state's work is finished. `result` holds the keys the state asked for. After calling it, stop: do not call any other tool and end your turn.";
const ASK_USER_DESCRIPTION: &str = "Ask the human operator one clear question when you cannot proceed without a decision. The call returns at once; then end your turn. The answer arrives as the next user message.";
const PERMISSION_DESCRIPTION: &str = "Conductor's permission prompt tool: Claude Code calls it when a tool call needs a human's approval. Do not call it yourself.";

fn when_suffix(t: &AgentTransitionOption) -> String {
    t.when
        .as_deref()
        .map(|w| format!(": {w}"))
        .unwrap_or_default()
}

/// ADR-0011 "one corrective nudge": the tool result for a name outside the allowed list.
pub fn unknown_transition_text(
    name: Option<&str>,
    transitions: &[AgentTransitionOption],
) -> String {
    let named = match name {
        None => format!(
            "complete_state named no transition (that means \"{DEFAULT_TRANSITION}\"), which is not allowed here"
        ),
        Some(n) => format!("\"{n}\" is not a transition you can take here"),
    };
    let list: Vec<String> = transitions
        .iter()
        .map(|t| format!("- {}{}", t.name.as_str(), when_suffix(t)))
        .collect();
    format!(
        "Not recorded: {named}. Call complete_state again with `transition` set to exactly one of:\n{}",
        list.join("\n")
    )
}

/// The complete_state tool description, listing the allowed transitions when there are any.
pub fn complete_state_description(transitions: Option<&[AgentTransitionOption]>) -> String {
    let Some(transitions) = transitions.filter(|t| !t.is_empty()) else {
        return COMPLETE_STATE_BASE.to_string();
    };
    let list: Vec<String> = transitions
        .iter()
        .map(|t| {
            format!(
                "- {}{}{}",
                t.name.as_str(),
                when_suffix(t),
                if t.question {
                    " (a question: `reason` is the question for the human)"
                } else {
                    ""
                }
            )
        })
        .collect();
    format!(
        "{COMPLETE_STATE_BASE}\nSet `transition` to the move you take and `reason` to why. Allowed transitions:\n{}",
        list.join("\n")
    )
}

/// Claude's suggestions within PERMISSION_SUGGESTIONS_MAX / _MAX_BYTES, else None (dropped).
pub fn bounded_suggestions(v: Option<&Value>) -> Option<Vec<JsonObject>> {
    let items = v?.as_array()?;
    if items.is_empty() || items.len() > PERMISSION_SUGGESTIONS_MAX {
        return None;
    }
    if json_byte_length(v?) > PERMISSION_SUGGESTIONS_MAX_BYTES {
        return None;
    }
    items
        .iter()
        .map(|x| x.as_object().map(|o| JsonObject(o.clone())))
        .collect()
}

/// ADR-0011: whether `complete_state` naming `name` is refused with the corrective text. Only the
/// first unknown name is refused (`nudged` false); no list (old workflows, reviewers) accepts any.
pub fn refuse_transition(
    transitions: Option<&[AgentTransitionOption]>,
    name: Option<&str>,
    nudged: bool,
) -> bool {
    let Some(transitions) = transitions else {
        return false;
    };
    if transitions.is_empty() || nudged {
        return false;
    }
    let effective = name.unwrap_or(DEFAULT_TRANSITION);
    !transitions.iter().any(|t| t.name.as_str() == effective)
}

/// One rule of a permission reply's `updatedPermissions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_content: Option<String>,
}

/// `{type: 'addRules', rules, behavior: 'allow', destination: 'session'}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermissionUpdate {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub rules: Vec<PermissionRule>,
    pub behavior: &'static str,
    pub destination: &'static str,
}

/// The permission-prompt-tool reply Claude reads (the tool's text content, as JSON).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum PermissionReply {
    Allow {
        #[serde(rename = "updatedInput")]
        updated_input: JsonObject,
        #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<PermissionUpdate>>,
    },
    Deny {
        message: String,
    },
}

/// `Bash(pnpm exec tsc -b)` → `{toolName: 'Bash', ruleContent: 'pnpm exec tsc -b'}`; `Read` →
/// `{toolName: 'Read'}` (the TS regex `^([^()]+)\(([\s\S]*)\)$`).
pub fn parse_permission_rule(rule: &str) -> PermissionRule {
    let whole = || PermissionRule {
        tool_name: rule.to_string(),
        rule_content: None,
    };
    let Some(open) = rule.find('(') else {
        return whole();
    };
    let name = &rule[..open];
    if name.is_empty() || name.contains(')') || !rule.ends_with(')') || rule.len() < open + 2 {
        return whole();
    }
    PermissionRule {
        tool_name: name.to_string(),
        rule_content: Some(rule[open + 1..rule.len() - 1].to_string()),
    }
}

/// JS `String.prototype.trim` (Unicode white space plus U+FEFF).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// JS `s.slice(0, max)`: the first `max` UTF-16 code units. A surrogate pair cut in half is
/// dropped (JS would keep a lone surrogate, which Rust strings can't hold).
pub(crate) fn js_slice_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The reply for a human's decision on `input` (10-contracts §Permission prompts).
pub fn permission_reply(input: &JsonObject, d: &PermissionDecision) -> PermissionReply {
    if d.behavior == PermissionBehavior::Deny {
        let note = d
            .message
            .as_deref()
            .map(|m| js_slice_utf16(js_trim(m), PERMISSION_MESSAGE_MAX));
        return PermissionReply::Deny {
            message: match note {
                Some(n) if !n.is_empty() => {
                    format!("Permission denied by a human on the board: {n}")
                }
                _ => PERMISSION_DENIED_ON_BOARD.to_string(),
            },
        };
    }
    let updated_permissions = match (&d.scope, &d.rule) {
        (PermissionScope::Always, Some(rule)) => Some(vec![PermissionUpdate {
            kind: "addRules",
            rules: vec![parse_permission_rule(rule)],
            behavior: "allow",
            destination: "session",
        }]),
        _ => None,
    };
    PermissionReply::Allow {
        updated_input: input.clone(),
        updated_permissions,
    }
}

/// JS `new Date(t).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, milliseconds). Times before
/// 1970 are clamped to the epoch.
pub fn iso_string(t: SystemTime) -> String {
    let ms = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let (secs, millis) = ((ms / 1000) as i64, (ms % 1000) as u32);
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

// ---- The server (MR-T08) ----

/// ADR-0011: what the agent named in complete_state (absent fields were not given).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompleteStateMeta {
    pub transition: Option<String>,
    pub reason: Option<String>,
}

/// A held permission prompt, handed to the driver (the daemon sends it as `permission_request`).
#[derive(Clone, Debug, PartialEq)]
pub struct PermissionPrompt {
    /// Fresh uuid: the idempotency key of the request and its decision.
    pub request_id: String,
    pub tool: String,
    /// At most PERMISSION_INPUT_MAX_BYTES of JSON (larger ones are denied before this).
    pub input: JsonObject,
    /// Claude's `permission_suggestions`; None when absent or over their bounds.
    pub suggestions: Option<Vec<JsonObject>>,
    pub tool_use_id: Option<String>,
    /// ISO time the call is denied if nobody answers.
    pub expires_at: String,
}

pub type CompleteStateHandler = Arc<dyn Fn(Map<String, Value>, CompleteStateMeta) + Send + Sync>;
pub type AskUserHandler = Arc<dyn Fn(String) + Send + Sync>;
/// Err = the prompt could not be forwarded (the TS handler threw): the call is denied at once.
pub type PermissionHandler = Arc<dyn Fn(PermissionPrompt) -> Result<(), String> + Send + Sync>;

/// What a registration reports to its driver. Handlers are called with no lock held and must not
/// block.
#[derive(Clone)]
pub struct OutcomeHandlers {
    pub on_complete_state: CompleteStateHandler,
    pub on_ask_user: AskUserHandler,
    /// ADR-0023: a permission prompt is now held. None → every prompt is denied at once
    /// (PERMISSION_NO_HANDLER).
    pub on_permission_request: Option<PermissionHandler>,
}

/// `register` options.
#[derive(Clone, Debug, Default)]
pub struct OutcomeRegisterOptions {
    /// ADR-0011 `start_session.transitions`; None or empty = any name passes.
    pub transitions: Option<Vec<AgentTransitionOption>>,
}

/// `start_outcome_server` options.
#[derive(Clone, Debug, Default)]
pub struct OutcomeServerOptions {
    /// Default 0 (an ephemeral port).
    pub port: Option<u16>,
    /// ADR-0023: deny a held permission prompt after this long. Default
    /// DEFAULT_PERMISSION_TIMEOUT_MS.
    pub permission_timeout: Option<Duration>,
}

/// How many decided request ids a registration remembers (for the `duplicate` ack).
const DECIDED_MAX: usize = 1_000;
/// close(): how long the deny replies of held calls get to flush before the sockets close.
const CLOSE_FLUSH: Duration = Duration::from_millis(200);
/// close(): how long in-flight requests get after that before the listener task is aborted.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

struct Held {
    input: JsonObject,
    tx: oneshot::Sender<PermissionReply>,
}

struct Entry {
    handlers: OutcomeHandlers,
    question_pending: bool,
    completed: bool,
    transitions: Option<Vec<AgentTransitionOption>>,
    /// The one corrective nudge for an unknown transition was given.
    nudged: bool,
    /// ADR-0023: permission prompts held open, by request id.
    held: HashMap<String, Held>,
    /// Request ids a human decision resolved (oldest first, capped at DECIDED_MAX).
    decided_order: VecDeque<String>,
    decided: HashSet<String>,
    /// Unregistered: a new prompt is denied at once.
    closed: bool,
}

type SharedEntry = Arc<Mutex<Entry>>;

fn lock(e: &SharedEntry) -> MutexGuard<'_, Entry> {
    e.lock().unwrap_or_else(|p| p.into_inner())
}

fn deny(message: impl Into<String>) -> PermissionReply {
    PermissionReply::Deny {
        message: message.into(),
    }
}

/// Settle a held prompt (under the entry lock). False when it isn't held.
fn settle_held(entry: &mut Entry, request_id: &str, reply: PermissionReply) -> bool {
    match entry.held.remove(request_id) {
        Some(h) => {
            let _ = h.tx.send(reply);
            true
        }
        None => false,
    }
}

fn deny_all(entry: &mut Entry, message: &str) -> usize {
    let ids: Vec<String> = entry.held.keys().cloned().collect();
    for id in &ids {
        settle_held(entry, id, deny(message));
    }
    ids.len()
}

/// The MCP handler of one registration (a fresh clone serves each request).
#[derive(Clone)]
struct Outcome {
    entry: SharedEntry,
    timeout: Duration,
}

fn text(t: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(t)])
}

fn invalid(why: impl std::fmt::Display) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!(
        "Input validation error: {why}"
    ))])
}

fn always_load() -> MetaObject {
    let mut m = Map::new();
    m.insert("anthropic/alwaysLoad".into(), Value::Bool(true));
    MetaObject(m)
}

fn schema(v: Value) -> Arc<Map<String, Value>> {
    match v {
        Value::Object(m) => Arc::new(m),
        _ => Arc::new(Map::new()),
    }
}

/// `COMPLETE_STATE_INPUT_SHAPE`, from the emitted zod schema (MR-T03), minus `$schema`.
fn complete_state_schema() -> Arc<Map<String, Value>> {
    let mut v: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/protocol-json/schemas/CompleteStateInput.json"
    )))
    .unwrap_or_else(|_| json!({"type": "object"}));
    if let Some(o) = v.as_object_mut() {
        o.remove("$schema");
    }
    schema(v)
}

/// JS `s.length` (UTF-16 code units), what zod's min/max count.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// An optional string argument with zod's `.min(min).max(max)`.
fn opt_string(
    args: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<Option<String>, String> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if (min..=max).contains(&js_len(s)) => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(format!("{key}: must be {min}..={max} characters")),
        Some(_) => Err(format!("{key}: expected string")),
    }
}

impl Outcome {
    fn complete_state(&self, args: &Map<String, Value>) -> CallToolResult {
        let result = match args.get("result") {
            Some(Value::Object(r)) => r.clone(),
            _ => return invalid("result: expected object"),
        };
        let transition = match opt_string(args, "transition", 1, TRANSITION_NAME_MAX) {
            Ok(t) => t,
            Err(e) => return invalid(e),
        };
        let reason = match opt_string(args, "reason", 0, TRANSITION_REASON_MAX) {
            Ok(r) => r,
            Err(e) => return invalid(e),
        };
        let handler = {
            let mut e = lock(&self.entry);
            if e.question_pending {
                return text(COMPLETE_STATE_PENDING_QUESTION);
            }
            if e.completed {
                return text(COMPLETE_STATE_DUPLICATE);
            }
            if refuse_transition(e.transitions.as_deref(), transition.as_deref(), e.nudged) {
                e.nudged = true;
                return text(unknown_transition_text(
                    transition.as_deref(),
                    e.transitions.as_deref().unwrap_or(&[]),
                ));
            }
            e.completed = true;
            e.handlers.on_complete_state.clone()
        };
        handler(result, CompleteStateMeta { transition, reason });
        text(COMPLETE_STATE_RETURN)
    }

    fn ask_user(&self, args: &Map<String, Value>) -> CallToolResult {
        let question = match args.get("question") {
            Some(Value::String(q)) if !q.is_empty() => q.clone(),
            _ => return invalid("question: expected a non-empty string"),
        };
        let handler = {
            let mut e = lock(&self.entry);
            if e.completed {
                return text(ASK_USER_AFTER_COMPLETE);
            }
            if e.question_pending {
                return text(ASK_USER_PENDING_QUESTION);
            }
            e.question_pending = true;
            e.handlers.on_ask_user.clone()
        };
        handler(question);
        text(ASK_USER_RETURN)
    }

    async fn permission(&self, args: &Map<String, Value>) -> CallToolResult {
        let tool = match args.get("tool_name") {
            Some(Value::String(t)) if !t.is_empty() => t.clone(),
            _ => return invalid("tool_name: expected a non-empty string"),
        };
        let input = match args.get("input") {
            Some(Value::Object(i)) => JsonObject(i.clone()),
            _ => return invalid("input: expected object"),
        };
        let tool_use_id = match args.get("tool_use_id") {
            None => None,
            Some(Value::String(t)) => Some(t.clone()),
            Some(_) => return invalid("tool_use_id: expected string"),
        };
        let suggestions_arg = match args.get("permission_suggestions") {
            None => None,
            Some(v @ Value::Array(_)) => Some(v),
            Some(_) => return invalid("permission_suggestions: expected array"),
        };
        let reply = self.hold(tool, input, tool_use_id, suggestions_arg).await;
        text(serde_json::to_string(&reply).unwrap_or_default())
    }

    /// Hold the call until a decision, a deny, the timeout or shutdown.
    async fn hold(
        &self,
        tool: String,
        input: JsonObject,
        tool_use_id: Option<String>,
        suggestions: Option<&Value>,
    ) -> PermissionReply {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let (handler, prompt) = {
            let mut e = lock(&self.entry);
            let Some(handler) = e.handlers.on_permission_request.clone() else {
                return deny(PERMISSION_NO_HANDLER);
            };
            if e.closed {
                return deny(PERMISSION_SESSION_ENDED);
            }
            if js_len(&tool) > PERMISSION_TOOL_MAX {
                return deny(permission_tool_name_too_long());
            }
            // U-101: over the bound the daemon denies the call itself and sends nothing.
            let bytes = json_byte_length(&Value::Object(input.0.clone()));
            if bytes > PERMISSION_INPUT_MAX_BYTES {
                return deny(permission_too_large_text(bytes));
            }
            let prompt = PermissionPrompt {
                request_id: request_id.clone(),
                tool,
                input: input.clone(),
                suggestions: bounded_suggestions(suggestions),
                tool_use_id: tool_use_id.filter(|t| (1..=200).contains(&js_len(t))),
                expires_at: iso_string(SystemTime::now() + self.timeout),
            };
            e.held.insert(request_id.clone(), Held { input, tx });
            (handler, prompt)
        };
        if handler(prompt).is_err() {
            // The request could not be forwarded: never strand the agent.
            settle_held(
                &mut lock(&self.entry),
                &request_id,
                deny(PERMISSION_NO_HANDLER),
            );
        }
        let mut rx = rx;
        match tokio::time::timeout(self.timeout, &mut rx).await {
            Ok(reply) => reply.unwrap_or_else(|_| deny(PERMISSION_SESSION_ENDED)),
            Err(_) => {
                // Whoever removes the prompt wins: a decision that got in first is honoured.
                let removed = lock(&self.entry).held.remove(&request_id).is_some();
                if removed {
                    deny(permission_timeout_text(self.timeout))
                } else {
                    rx.try_recv()
                        .unwrap_or_else(|_| deny(permission_timeout_text(self.timeout)))
                }
            }
        }
    }
}

impl ServerHandler for Outcome {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(OUTCOME_SERVER_NAME, "0.0.0"))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let description = complete_state_description(lock(&self.entry).transitions.as_deref());
        Ok(ListToolsResult::with_all_items(vec![
            Tool::new("complete_state", description, complete_state_schema())
                .with_meta(always_load()),
            Tool::new(
                "ask_user",
                ASK_USER_DESCRIPTION,
                schema(json!({
                    "type": "object",
                    "properties": {"question": {
                        "type": "string", "minLength": 1,
                        "description": "One clear question for the human"
                    }},
                    "required": ["question"],
                })),
            )
            .with_meta(always_load()),
            // ADR-0023: Claude's --permission-prompt-tool. Not always-loaded: the model never
            // calls it.
            Tool::new(
                "permission",
                PERMISSION_DESCRIPTION,
                schema(json!({
                    "type": "object",
                    "properties": {
                        "tool_name": {"type": "string", "minLength": 1, "description": "The tool Claude wants to run"},
                        "input": {"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {}, "description": "The input it wants to run it with"},
                        "tool_use_id": {"type": "string"},
                        "permission_suggestions": {"type": "array", "items": {}},
                    },
                    "required": ["tool_name", "input"],
                })),
            ),
        ]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let args = request.arguments.unwrap_or_default();
        let result = match request.name.as_ref() {
            "complete_state" => self.complete_state(&args),
            "ask_user" => self.ask_user(&args),
            "permission" => self.permission(&args).await,
            other => {
                return Err(ErrorData::invalid_params(
                    Cow::Owned(format!("Tool {other} not found")),
                    None,
                ));
            }
        };
        Ok(result.into())
    }
}

type Svc = StreamableHttpService<Outcome, NeverSessionManager>;

#[derive(Clone)]
struct Live {
    entry: SharedEntry,
    svc: Svc,
}

type Registry = Arc<Mutex<HashMap<String, Live>>>;

fn registry_lock(r: &Registry) -> MutexGuard<'_, HashMap<String, Live>> {
    r.lock().unwrap_or_else(|p| p.into_inner())
}

fn is_token(t: &str) -> bool {
    t.len() == 32 && t.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

async fn route(
    State(reg): State<Registry>,
    Path(token): Path<String>,
    req: Request<Body>,
) -> Response {
    let live = is_token(&token)
        .then(|| registry_lock(&reg).get(&token).cloned())
        .flatten();
    match live {
        None => http::StatusCode::NOT_FOUND.into_response(),
        // rmcp checks the Host header (403: DNS rebinding) and refuses GET/DELETE (405).
        Some(live) => match live.svc.oneshot(req).await {
            Ok(r) => r.into_response(),
            Err(never) => match never {},
        },
    }
}

/// A session's registration on the outcome server.
#[derive(Clone)]
pub struct OutcomeRegistration {
    token: String,
    url: String,
    mcp_config: String,
    entry: SharedEntry,
    registry: Registry,
}

impl std::fmt::Debug for OutcomeRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutcomeRegistration")
            .field("url", &self.url)
            .finish()
    }
}

impl OutcomeRegistration {
    /// 32 lowercase hex chars (128 bits).
    pub fn token(&self) -> &str {
        &self.token
    }
    /// `http://127.0.0.1:<port>/mcp/<token>`
    pub fn url(&self) -> &str {
        &self.url
    }
    /// The `--mcp-config` JSON for this session.
    pub fn mcp_config(&self) -> &str {
        &self.mcp_config
    }
    pub fn question_pending(&self) -> bool {
        lock(&self.entry).question_pending
    }
    pub fn completed(&self) -> bool {
        lock(&self.entry).completed
    }
    /// The pending question was answered (the answer is being delivered as a user message).
    pub fn answered(&self) {
        lock(&self.entry).question_pending = false;
    }
    /// Number of held permission prompts.
    pub fn pending_permissions(&self) -> usize {
        lock(&self.entry).held.len()
    }
    /// A human's decision for a held prompt. Resolves it at most once: `Duplicate` when a decision
    /// already resolved it, `Unknown` when it isn't held (timed out, denied, never existed).
    pub fn resolve_permission(
        &self,
        request_id: &str,
        decision: &PermissionDecision,
    ) -> PermissionResolution {
        let mut e = lock(&self.entry);
        let Some(input) = e.held.get(request_id).map(|h| h.input.clone()) else {
            return if e.decided.contains(request_id) {
                PermissionResolution::Duplicate
            } else {
                PermissionResolution::Unknown
            };
        };
        e.decided.insert(request_id.to_string());
        e.decided_order.push_back(request_id.to_string());
        if e.decided_order.len() > DECIDED_MAX
            && let Some(oldest) = e.decided_order.pop_front()
        {
            e.decided.remove(&oldest);
        }
        settle_held(&mut e, request_id, permission_reply(&input, decision));
        PermissionResolution::Resolved
    }
    /// Deny a held prompt with `message` (e.g. an old server's protocol_error). False if not held.
    pub fn deny_permission(&self, request_id: &str, message: &str) -> bool {
        settle_held(&mut lock(&self.entry), request_id, deny(message))
    }
    /// Drop the token: later calls on it get 404, held prompts are denied. Idempotent.
    pub fn unregister(&self) {
        registry_lock(&self.registry).remove(&self.token);
        let mut e = lock(&self.entry);
        e.closed = true;
        deny_all(&mut e, PERMISSION_SESSION_ENDED);
    }
}

/// The daemon's outcome server (one per daemon).
pub struct OutcomeServer {
    port: u16,
    timeout: Duration,
    registry: Registry,
    shutdown: Arc<tokio::sync::Notify>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl OutcomeServer {
    pub fn host(&self) -> &'static str {
        "127.0.0.1"
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    /// Number of live tokens (for tests / diagnostics).
    pub fn size(&self) -> usize {
        registry_lock(&self.registry).len()
    }

    pub fn register(
        &self,
        handlers: OutcomeHandlers,
        opts: OutcomeRegisterOptions,
    ) -> OutcomeRegistration {
        let token = hex::encode(rand::random::<[u8; 16]>());
        let entry: SharedEntry = Arc::new(Mutex::new(Entry {
            handlers,
            question_pending: false,
            completed: false,
            transitions: opts.transitions,
            nudged: false,
            held: HashMap::new(),
            decided_order: VecDeque::new(),
            decided: HashSet::new(),
            closed: false,
        }));
        let config = StreamableHttpServerConfig::default()
            // Stateless + JSON replies, as the TS server (`enableJsonResponse`, no session id).
            .with_legacy_session_mode(false)
            .with_json_response(true)
            // DNS-rebinding guard: only loopback Host headers (the token already makes the path
            // unguessable).
            .with_allowed_hosts([
                format!("127.0.0.1:{}", self.port),
                format!("localhost:{}", self.port),
            ]);
        let outcome = Outcome {
            entry: entry.clone(),
            timeout: self.timeout,
        };
        let svc = StreamableHttpService::new(
            move || Ok(outcome.clone()),
            Arc::new(NeverSessionManager::default()),
            config,
        );
        registry_lock(&self.registry).insert(
            token.clone(),
            Live {
                entry: entry.clone(),
                svc,
            },
        );
        let url = format!("http://127.0.0.1:{}/mcp/{token}", self.port);
        let mcp_config =
            json!({"mcpServers": {OUTCOME_SERVER_NAME: {"type": "http", "url": url}}}).to_string();
        OutcomeRegistration {
            token,
            url,
            mcp_config,
            entry,
            registry: self.registry.clone(),
        }
    }

    /// Deny every held call (PERMISSION_SHUTDOWN), let the replies flush, then stop listening.
    pub async fn close(&self) {
        let entries: Vec<SharedEntry> = registry_lock(&self.registry)
            .drain()
            .map(|(_, l)| l.entry)
            .collect();
        let mut denied = 0;
        for e in &entries {
            let mut e = lock(e);
            e.closed = true;
            denied += deny_all(&mut e, PERMISSION_SHUTDOWN);
        }
        if denied > 0 {
            tokio::time::sleep(CLOSE_FLUSH).await;
        }
        self.shutdown.notify_one();
        let task = self.task.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut task) = task
            && tokio::time::timeout(CLOSE_GRACE, &mut task).await.is_err()
        {
            task.abort();
        }
    }
}

/// Start the outcome server on 127.0.0.1 (`opts.port`, default ephemeral).
pub async fn start_outcome_server(opts: OutcomeServerOptions) -> std::io::Result<OutcomeServer> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", opts.port.unwrap_or(0))).await?;
    let port = listener.local_addr()?.port();
    let registry: Registry = Arc::default();
    let app = Router::new()
        .route("/mcp/{token}", any(route))
        .fallback(|| async { http::StatusCode::NOT_FOUND })
        .with_state(registry.clone());
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let signal = shutdown.clone();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move { signal.notified().await })
            .await;
    });
    Ok(OutcomeServer {
        port,
        timeout: opts
            .permission_timeout
            .unwrap_or(Duration::from_millis(DEFAULT_PERMISSION_TIMEOUT_MS)),
        registry,
        shutdown,
        task: Mutex::new(Some(task)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn transitions(names: &[&str]) -> Vec<AgentTransitionOption> {
        names
            .iter()
            .map(|n| {
                serde_json::from_value(
                    serde_json::json!({"name": n, "when": null, "question": false}),
                )
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn parses_exact_rules_into_tool_name_rule_content() {
        let r = |t: &str, c: Option<&str>| PermissionRule {
            tool_name: t.into(),
            rule_content: c.map(String::from),
        };
        assert_eq!(
            parse_permission_rule("Bash(git status)"),
            r("Bash", Some("git status"))
        );
        assert_eq!(
            parse_permission_rule("Bash(echo (a))"),
            r("Bash", Some("echo (a)"))
        );
        assert_eq!(parse_permission_rule("WebFetch"), r("WebFetch", None));
        assert_eq!(parse_permission_rule("(x)"), r("(x)", None));
        assert_eq!(parse_permission_rule("Bash(x"), r("Bash(x", None));
        assert_eq!(parse_permission_rule("Bash()"), r("Bash", Some("")));
    }

    #[test]
    fn refuse_transition_refuses_an_unknown_name_once_and_never_without_a_list() {
        let t = transitions(&["plan_ready", "done"]);
        assert!(!refuse_transition(None, Some("x"), false));
        assert!(!refuse_transition(Some(&[]), Some("x"), false));
        assert!(refuse_transition(Some(&t), Some("x"), false));
        assert!(!refuse_transition(Some(&t), Some("x"), true));
        assert!(!refuse_transition(Some(&t), Some("plan_ready"), false));
        assert!(!refuse_transition(Some(&t), None, false));
        let no_done = transitions(&["plan_ready"]);
        assert!(refuse_transition(Some(&no_done), None, false));
    }

    #[test]
    fn permission_reply_serialises_as_claude_reads_it() {
        let input: JsonObject =
            serde_json::from_value(serde_json::json!({"command": "ls"})).unwrap();
        let allow_always = PermissionDecision {
            behavior: PermissionBehavior::Allow,
            scope: PermissionScope::Always,
            message: None,
            rule: Some("Bash(ls)".into()),
        };
        assert_eq!(
            serde_json::to_value(permission_reply(&input, &allow_always)).unwrap(),
            serde_json::json!({
                "behavior": "allow",
                "updatedInput": {"command": "ls"},
                "updatedPermissions": [{
                    "type": "addRules",
                    "rules": [{"toolName": "Bash", "ruleContent": "ls"}],
                    "behavior": "allow",
                    "destination": "session"
                }]
            })
        );
        let allow_once = PermissionDecision {
            scope: PermissionScope::Once,
            ..allow_always.clone()
        };
        assert_eq!(
            serde_json::to_value(permission_reply(&input, &allow_once)).unwrap(),
            serde_json::json!({"behavior": "allow", "updatedInput": {"command": "ls"}})
        );
        let deny = |m: Option<&str>| PermissionDecision {
            behavior: PermissionBehavior::Deny,
            scope: PermissionScope::Once,
            message: m.map(String::from),
            rule: None,
        };
        assert_eq!(
            serde_json::to_value(permission_reply(&input, &deny(Some("  not now \n")))).unwrap(),
            serde_json::json!({"behavior": "deny", "message": "Permission denied by a human on the board: not now"})
        );
        for m in [None, Some("   ")] {
            assert_eq!(
                permission_reply(&input, &deny(m)),
                PermissionReply::Deny {
                    message: PERMISSION_DENIED_ON_BOARD.into()
                }
            );
        }
        let long = "é".repeat(PERMISSION_MESSAGE_MAX + 5);
        let PermissionReply::Deny { message } = permission_reply(&input, &deny(Some(&long))) else {
            panic!("deny expected")
        };
        assert!(message.ends_with(&"é".repeat(PERMISSION_MESSAGE_MAX)));
        assert!(!message.ends_with(&"é".repeat(PERMISSION_MESSAGE_MAX + 1)));
    }

    #[test]
    fn iso_string_matches_js_to_iso_string() {
        assert_eq!(iso_string(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_string(UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)),
            "2023-11-14T22:13:20.123Z"
        );
        assert_eq!(
            iso_string(UNIX_EPOCH + Duration::from_millis(951_782_400_000)),
            "2000-02-29T00:00:00.000Z"
        );
    }

    // ---- The server (MR-T08): replays the raw JSON-RPC posts of outcome-server.test.ts ----

    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Clone, Debug, PartialEq)]
    enum Call {
        Ask(String),
        Done(Value, Option<String>, Option<String>),
    }

    type Calls = Arc<Mutex<Vec<Call>>>;
    type Prompts = Arc<Mutex<Vec<PermissionPrompt>>>;

    fn handlers(calls: &Calls, prompts: Option<&Prompts>) -> OutcomeHandlers {
        let (a, d) = (calls.clone(), calls.clone());
        OutcomeHandlers {
            on_ask_user: Arc::new(move |q| a.lock().unwrap().push(Call::Ask(q))),
            on_complete_state: Arc::new(move |r, m| {
                d.lock()
                    .unwrap()
                    .push(Call::Done(Value::Object(r), m.transition, m.reason))
            }),
            on_permission_request: prompts.map(|p| {
                let p = p.clone();
                Arc::new(move |prompt| {
                    p.lock().unwrap().push(prompt);
                    Ok(())
                }) as PermissionHandler
            }),
        }
    }

    async fn server() -> OutcomeServer {
        start_outcome_server(OutcomeServerOptions::default())
            .await
            .unwrap()
    }

    fn register(
        s: &OutcomeServer,
        transitions: Option<Vec<AgentTransitionOption>>,
    ) -> (OutcomeRegistration, Calls) {
        let calls = Calls::default();
        let reg = s.register(
            handlers(&calls, None),
            OutcomeRegisterOptions { transitions },
        );
        (reg, calls)
    }

    static RPC_ID: AtomicU64 = AtomicU64::new(0);

    /// A minimal MCP client over plain JSON-RPC POSTs, the TS test's headers and bodies.
    struct Client {
        http: reqwest::Client,
        url: String,
    }

    impl Client {
        async fn rpc(&self, method: &str, params: Option<Value>) -> Value {
            let mut body = json!({"jsonrpc": "2.0", "id": RPC_ID.fetch_add(1, Ordering::Relaxed) + 1, "method": method});
            if let Some(p) = params {
                body["params"] = p;
            }
            let res = self
                .http
                .post(&self.url)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(body.to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), 200, "{method}");
            res.json().await.unwrap()
        }
        async fn list_tools(&self) -> Vec<Value> {
            let r = self.rpc("tools/list", None).await;
            r["result"]["tools"].as_array().cloned().unwrap_or_default()
        }
        /// (text, is_error), a JSON-RPC error counting as an error result.
        async fn call(&self, name: &str, args: Value) -> (String, bool) {
            let r = self
                .rpc("tools/call", Some(json!({"name": name, "arguments": args})))
                .await;
            if let Some(e) = r.get("error") {
                return (e["message"].as_str().unwrap_or("").into(), true);
            }
            let text = r["result"]["content"]
                .as_array()
                .map(|c| {
                    c.iter()
                        .filter_map(|x| x["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default();
            (text, r["result"]["isError"] == json!(true))
        }
        async fn text(&self, name: &str, args: Value) -> String {
            let (t, err) = self.call(name, args).await;
            assert!(!err, "{name}: {t}");
            t
        }
    }

    async fn connect(url: &str) -> Client {
        let c = Client {
            http: reqwest::Client::new(),
            url: url.to_string(),
        };
        let init = c
            .rpc(
                "initialize",
                Some(json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0.0.0"}})),
            )
            .await;
        assert!(init.get("error").is_none(), "{init}");
        c
    }

    /// A raw HTTP/1.1 request (reqwest won't send a foreign Host header): the status code.
    async fn raw(port: u16, method: &str, path: &str, host: Option<&str>, body: &str) -> u16 {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let host = host.map_or(format!("127.0.0.1:{port}"), String::from);
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 64];
        let n = s.read(&mut buf).await.unwrap();
        let line = String::from_utf8_lossy(&buf[..n]).into_owned();
        line.split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0)
    }

    fn opt(name: &str, when: &str, question: bool) -> AgentTransitionOption {
        serde_json::from_value(json!({"name": name, "when": when, "question": question})).unwrap()
    }

    fn two_transitions() -> Vec<AgentTransitionOption> {
        vec![
            opt("plan_ready", "The plan is complete.", false),
            opt("scope_changed", "The scope changed.", true),
        ]
    }

    fn done(result: Value, t: Option<&str>, r: Option<&str>) -> Call {
        Call::Done(result, t.map(String::from), r.map(String::from))
    }

    #[tokio::test]
    async fn binds_127_0_0_1_and_issues_a_128_bit_path_token_per_session() {
        let s = server().await;
        let (a, _) = register(&s, None);
        let (b, _) = register(&s, None);
        assert_eq!(s.host(), "127.0.0.1");
        assert!(is_token(a.token()));
        assert_ne!(a.token(), b.token());
        assert_eq!(
            a.url(),
            format!("http://127.0.0.1:{}/mcp/{}", s.port(), a.token())
        );
        assert_eq!(
            serde_json::from_str::<Value>(a.mcp_config()).unwrap(),
            json!({"mcpServers": {"conductor": {"type": "http", "url": a.url()}}})
        );
        s.close().await;
    }

    #[tokio::test]
    async fn lists_exactly_complete_state_ask_user_and_permission() {
        let s = server().await;
        let c = connect(register(&s, None).0.url()).await;
        let tools = c.list_tools().await;
        let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        names.sort();
        assert_eq!(names, ["ask_user", "complete_state", "permission"]);
        let by = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap().clone();
        assert_eq!(
            by("complete_state")["_meta"],
            json!({"anthropic/alwaysLoad": true})
        );
        assert_eq!(
            by("ask_user")["_meta"],
            json!({"anthropic/alwaysLoad": true})
        );
        assert!(by("permission").get("_meta").is_none());
        assert_eq!(
            by("complete_state")["inputSchema"]["required"],
            json!(["result"])
        );
        s.close().await;
    }

    #[tokio::test]
    async fn ask_user_returns_at_once_and_complete_state_after_the_answer_records() {
        let s = server().await;
        let (reg, calls) = register(&s, None);
        let c = connect(reg.url()).await;
        assert_eq!(
            c.text("ask_user", json!({"question": "Which?"})).await,
            ASK_USER_RETURN
        );
        assert!(reg.question_pending());
        assert_eq!(*calls.lock().unwrap(), vec![Call::Ask("Which?".into())]);

        assert_eq!(
            c.text("complete_state", json!({"result": {"x": 1}})).await,
            COMPLETE_STATE_PENDING_QUESTION
        );
        assert_eq!(
            c.text("ask_user", json!({"question": "Again?"})).await,
            ASK_USER_PENDING_QUESTION
        );
        assert_eq!(calls.lock().unwrap().len(), 1);

        reg.answered();
        assert_eq!(
            c.text("complete_state", json!({"result": {"x": 1}})).await,
            COMPLETE_STATE_RETURN
        );
        assert!(reg.completed());
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                Call::Ask("Which?".into()),
                done(json!({"x": 1}), None, None)
            ]
        );

        assert_eq!(
            c.text("complete_state", json!({"result": {"x": 2}})).await,
            COMPLETE_STATE_DUPLICATE
        );
        assert_eq!(
            c.text("ask_user", json!({"question": "Late?"})).await,
            ASK_USER_AFTER_COMPLETE
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        s.close().await;
    }

    #[tokio::test]
    async fn attributes_calls_to_the_session_that_owns_the_token() {
        let s = server().await;
        let (_a, a_calls) = register(&s, None);
        let (b, b_calls) = register(&s, None);
        connect(b.url())
            .await
            .text("complete_state", json!({"result": {"who": "b"}}))
            .await;
        assert!(a_calls.lock().unwrap().is_empty());
        assert_eq!(
            *b_calls.lock().unwrap(),
            vec![done(json!({"who": "b"}), None, None)]
        );
        s.close().await;
    }

    #[tokio::test]
    async fn rejects_invalid_arguments_without_emitting() {
        let s = server().await;
        let (reg, calls) = register(&s, None);
        let c = connect(reg.url()).await;
        assert!(c.call("ask_user", json!({"question": ""})).await.1);
        assert!(c.call("complete_state", json!({"result": "nope"})).await.1);
        assert!(c.call("complete_state", json!({})).await.1);
        assert!(
            c.call("complete_state", json!({"result": {}, "reason": 5}))
                .await
                .1
        );
        assert!(c.call("nope", json!({})).await.1);
        assert!(calls.lock().unwrap().is_empty());
        assert!(!reg.completed());
        s.close().await;
    }

    #[tokio::test]
    async fn status_404_405_403_and_unregister() {
        let s = server().await;
        let (reg, _) = register(&s, None);
        let port = s.port();
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string();
        let path = format!("/mcp/{}", reg.token());
        assert_eq!(
            raw(
                port,
                "POST",
                &format!("/mcp/{}", "0".repeat(32)),
                None,
                &body
            )
            .await,
            404
        );
        assert_eq!(
            raw(port, "POST", "/mcp/not-a-token", None, &body).await,
            404
        );
        assert_eq!(raw(port, "POST", "/", None, &body).await, 404);
        assert_eq!(raw(port, "GET", &path, None, "").await, 405);
        assert_eq!(
            raw(
                port,
                "POST",
                &path,
                Some(&format!("evil.example:{port}")),
                &body
            )
            .await,
            403
        );
        assert_eq!(
            raw(
                port,
                "POST",
                &path,
                Some(&format!("localhost:{port}")),
                &body
            )
            .await,
            200
        );

        assert_eq!(s.size(), 1);
        reg.unregister();
        reg.unregister(); // idempotent
        assert_eq!(s.size(), 0);
        assert_eq!(raw(port, "POST", &path, None, &body).await, 404);
        s.close().await;
    }

    #[tokio::test]
    async fn adr_0011_emits_a_valid_name_with_its_reason() {
        let s = server().await;
        let (reg, calls) = register(&s, Some(two_transitions()));
        let c = connect(reg.url()).await;
        assert_eq!(
            c.text("complete_state", json!({"transition": "scope_changed", "reason": "Is the new dependency OK?", "result": {}})).await,
            COMPLETE_STATE_RETURN
        );
        assert_eq!(
            *calls.lock().unwrap(),
            vec![done(
                json!({}),
                Some("scope_changed"),
                Some("Is the new dependency OK?")
            )]
        );
        s.close().await;
    }

    #[tokio::test]
    async fn adr_0011_refuses_an_unknown_name_once_then_emits_the_next_as_is() {
        let s = server().await;
        let (reg, calls) = register(&s, Some(two_transitions()));
        let c = connect(reg.url()).await;
        let nudge = c
            .text(
                "complete_state",
                json!({"transition": "shipit", "result": {}}),
            )
            .await;
        assert_eq!(
            nudge,
            unknown_transition_text(Some("shipit"), &two_transitions())
        );
        assert!(nudge.contains("- plan_ready: The plan is complete."));
        assert!(nudge.contains("- scope_changed: The scope changed."));
        assert!(calls.lock().unwrap().is_empty());
        assert!(!reg.completed());
        assert_eq!(
            c.text(
                "complete_state",
                json!({"transition": "yolo", "reason": "r", "result": {}})
            )
            .await,
            COMPLETE_STATE_RETURN
        );
        assert_eq!(
            *calls.lock().unwrap(),
            vec![done(json!({}), Some("yolo"), Some("r"))]
        );
        s.close().await;
    }

    #[tokio::test]
    async fn adr_0011_a_missing_transition_means_done() {
        let s = server().await;
        let (reg, calls) = register(&s, Some(two_transitions()));
        let c = connect(reg.url()).await;
        assert!(
            c.text("complete_state", json!({"result": {}}))
                .await
                .contains("named no transition")
        );
        assert_eq!(
            c.text(
                "complete_state",
                json!({"transition": "plan_ready", "result": {}})
            )
            .await,
            COMPLETE_STATE_RETURN
        );
        assert_eq!(
            *calls.lock().unwrap(),
            vec![done(json!({}), Some("plan_ready"), None)]
        );
        s.close().await;
    }

    #[tokio::test]
    async fn adr_0011_no_list_any_name_passes() {
        let s = server().await;
        for transitions in [None, Some(vec![])] {
            let (reg, calls) = register(&s, transitions);
            let c = connect(reg.url()).await;
            assert_eq!(
                c.text(
                    "complete_state",
                    json!({"transition": "anything", "result": {"a": 1}})
                )
                .await,
                COMPLETE_STATE_RETURN
            );
            assert_eq!(
                *calls.lock().unwrap(),
                vec![done(json!({"a": 1}), Some("anything"), None)]
            );
        }
        s.close().await;
    }

    #[tokio::test]
    async fn adr_0011_the_tool_description_lists_the_transitions() {
        let s = server().await;
        let c = connect(register(&s, Some(two_transitions())).0.url()).await;
        let tools = c.list_tools().await;
        let d = tools
            .iter()
            .find(|t| t["name"] == "complete_state")
            .unwrap()["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(d.contains("- plan_ready: The plan is complete."));
        assert!(d.contains("- scope_changed: The scope changed. (a question"));
        let plain = connect(register(&s, None).0.url()).await;
        let tools = plain.list_tools().await;
        let d2 = tools
            .iter()
            .find(|t| t["name"] == "complete_state")
            .unwrap()["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!d2.contains("Allowed transitions"));
        s.close().await;
    }

    #[tokio::test]
    async fn adr_0011_caps_transition_and_reason_at_the_tool_call() {
        let s = server().await;
        let (reg, calls) = register(&s, Some(two_transitions()));
        let c = connect(reg.url()).await;
        assert!(
            c.call(
                "complete_state",
                json!({"transition": "x".repeat(101), "result": {}})
            )
            .await
            .1
        );
        assert!(
            c.call("complete_state", json!({"transition": "", "result": {}}))
                .await
                .1
        );
        assert!(
            c.call(
                "complete_state",
                json!({"reason": "x".repeat(4001), "transition": "plan_ready", "result": {}})
            )
            .await
            .1
        );
        assert!(calls.lock().unwrap().is_empty());
        s.close().await;
    }

    // ---- ADR-0023 permission tool ----

    struct Perm {
        server: OutcomeServer,
        reg: OutcomeRegistration,
        prompts: Prompts,
        client: Arc<Client>,
    }

    async fn perm_setup(timeout: Option<Duration>, no_handler: bool) -> Perm {
        let server = start_outcome_server(OutcomeServerOptions {
            port: None,
            permission_timeout: timeout,
        })
        .await
        .unwrap();
        let prompts = Prompts::default();
        let calls = Calls::default();
        let reg = server.register(
            handlers(&calls, (!no_handler).then_some(&prompts)),
            OutcomeRegisterOptions::default(),
        );
        let client = Arc::new(connect(reg.url()).await);
        Perm {
            server,
            reg,
            prompts,
            client,
        }
    }

    impl Perm {
        /// Start a held call; resolves with the parsed reply when it returns.
        fn ask(&self, args: Value) -> tokio::task::JoinHandle<Value> {
            let c = self.client.clone();
            tokio::spawn(async move {
                let t = c.text("permission", args).await;
                serde_json::from_str(&t).unwrap()
            })
        }
        async fn next_prompt(&self, n: usize) -> PermissionPrompt {
            for _ in 0..200 {
                if self.prompts.lock().unwrap().len() >= n {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let p = self.prompts.lock().unwrap();
            assert!(p.len() >= n, "{} prompts", p.len());
            p[n - 1].clone()
        }
    }

    fn bash() -> Value {
        json!({"tool_name": "Bash", "input": {"command": "pnpm exec tsc -b"}, "tool_use_id": "toolu_1"})
    }

    fn decision(behavior: PermissionBehavior, scope: PermissionScope) -> PermissionDecision {
        PermissionDecision {
            behavior,
            scope,
            message: None,
            rule: None,
        }
    }

    #[tokio::test]
    async fn holds_the_call_until_allow_once_and_claude_gets_the_input_back() {
        let t = perm_setup(None, false).await;
        let t0 = SystemTime::now();
        let reply = t.ask(bash());
        let p = t.next_prompt(1).await;
        assert_eq!(p.tool, "Bash");
        assert_eq!(
            Value::Object(p.input.0.clone()),
            json!({"command": "pnpm exec tsc -b"})
        );
        assert_eq!(p.tool_use_id.as_deref(), Some("toolu_1"));
        assert!(uuid::Uuid::parse_str(&p.request_id).is_ok());
        // expires_at = now + the default 30 min
        let exp = crate::claude::transcript::parse_js_date(&p.expires_at).unwrap();
        let ahead = exp.duration_since(t0).unwrap();
        assert!(ahead > Duration::from_secs(29 * 60));
        assert!(ahead <= Duration::from_secs(30 * 60 + 5));
        assert_eq!(t.reg.pending_permissions(), 1);
        assert_eq!(
            t.reg.resolve_permission(
                &p.request_id,
                &decision(PermissionBehavior::Allow, PermissionScope::Once)
            ),
            PermissionResolution::Resolved
        );
        assert_eq!(
            reply.await.unwrap(),
            json!({"behavior": "allow", "updatedInput": {"command": "pnpm exec tsc -b"}})
        );
        assert_eq!(t.reg.pending_permissions(), 0);
        assert_eq!(
            t.reg.resolve_permission(
                &p.request_id,
                &decision(PermissionBehavior::Deny, PermissionScope::Once)
            ),
            PermissionResolution::Duplicate
        );
        assert_eq!(
            t.reg.resolve_permission(
                "00000000-0000-4000-8000-000000000000",
                &decision(PermissionBehavior::Allow, PermissionScope::Once)
            ),
            PermissionResolution::Unknown
        );
        t.server.close().await;
    }

    #[tokio::test]
    async fn allow_always_with_a_rule_adds_a_session_rule() {
        let t = perm_setup(None, false).await;
        let reply = t.ask(bash());
        let p = t.next_prompt(1).await;
        t.reg.resolve_permission(
            &p.request_id,
            &PermissionDecision {
                rule: Some("Bash(pnpm exec tsc -b)".into()),
                ..decision(PermissionBehavior::Allow, PermissionScope::Always)
            },
        );
        assert_eq!(
            reply.await.unwrap(),
            json!({
                "behavior": "allow",
                "updatedInput": {"command": "pnpm exec tsc -b"},
                "updatedPermissions": [{
                    "type": "addRules",
                    "rules": [{"toolName": "Bash", "ruleContent": "pnpm exec tsc -b"}],
                    "behavior": "allow",
                    "destination": "session"
                }]
            })
        );
        t.server.close().await;
    }

    #[tokio::test]
    async fn deny_the_human_note_or_the_default_text() {
        let t = perm_setup(None, false).await;
        let r1 = t.ask(bash());
        let p1 = t.next_prompt(1).await;
        t.reg.resolve_permission(
            &p1.request_id,
            &PermissionDecision {
                message: Some("  use pnpm typecheck  ".into()),
                ..decision(PermissionBehavior::Deny, PermissionScope::Once)
            },
        );
        assert_eq!(
            r1.await.unwrap(),
            json!({"behavior": "deny", "message": "Permission denied by a human on the board: use pnpm typecheck"})
        );
        let r2 = t.ask(bash());
        let p2 = t.next_prompt(2).await;
        t.reg.resolve_permission(
            &p2.request_id,
            &decision(PermissionBehavior::Deny, PermissionScope::Once),
        );
        assert_eq!(
            r2.await.unwrap(),
            json!({"behavior": "deny", "message": PERMISSION_DENIED_ON_BOARD})
        );
        t.server.close().await;
    }

    #[tokio::test]
    async fn denies_itself_at_the_timeout_and_a_later_decision_is_unknown() {
        let timeout = Duration::from_millis(150);
        let t = perm_setup(Some(timeout), false).await;
        let reply = t.ask(bash());
        let p = t.next_prompt(1).await;
        assert_eq!(
            reply.await.unwrap(),
            json!({"behavior": "deny", "message": permission_timeout_text(timeout)})
        );
        assert!(permission_timeout_text(timeout).contains("within 1 min"));
        assert!(
            permission_timeout_text(Duration::from_secs(30 * 60))
                .contains("no human answered within 30 min")
        );
        assert!(permission_timeout_text(Duration::from_secs(90)).contains("within 2 min"));
        assert_eq!(
            t.reg.resolve_permission(
                &p.request_id,
                &decision(PermissionBehavior::Allow, PermissionScope::Once)
            ),
            PermissionResolution::Unknown
        );
        t.server.close().await;
    }

    #[tokio::test]
    async fn u101_input_over_64_kib_is_denied_at_once_and_never_sent() {
        let t = perm_setup(None, false).await;
        let input = json!({"content": "x".repeat(PERMISSION_INPUT_MAX_BYTES)});
        let bytes = input.to_string().len();
        assert_eq!(
            t.ask(json!({"tool_name": "Write", "input": input}))
                .await
                .unwrap(),
            json!({"behavior": "deny", "message": permission_too_large_text(bytes)})
        );
        assert!(
            permission_too_large_text(bytes)
                .contains(&format!("input too large to review ({bytes} bytes)"))
        );
        assert!(t.prompts.lock().unwrap().is_empty());
        // A tool name over PERMISSION_TOOL_MAX is denied too.
        assert_eq!(
            t.ask(json!({"tool_name": "x".repeat(201), "input": {}}))
                .await
                .unwrap(),
            json!({"behavior": "deny", "message": permission_tool_name_too_long()})
        );
        t.server.close().await;
    }

    #[tokio::test]
    async fn passes_suggestions_within_bounds_and_drops_them_over_the_bounds() {
        let t = perm_setup(None, false).await;
        let one =
            json!([{"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "allow"}]);
        let with = |s: Value| {
            let mut a = bash();
            a["permission_suggestions"] = s;
            a
        };
        let allow = decision(PermissionBehavior::Allow, PermissionScope::Once);
        let r1 = t.ask(with(one.clone()));
        let p1 = t.next_prompt(1).await;
        assert_eq!(
            p1.suggestions.as_ref().map(|s| s
                .iter()
                .map(|o| Value::Object(o.0.clone()))
                .collect::<Vec<_>>()),
            Some(one.as_array().unwrap().clone())
        );
        t.reg.resolve_permission(&p1.request_id, &allow);
        r1.await.unwrap();
        let many = Value::Array(vec![one[0].clone(); PERMISSION_SUGGESTIONS_MAX + 1]);
        let r2 = t.ask(with(many));
        let p2 = t.next_prompt(2).await;
        assert_eq!(p2.suggestions, None);
        let big = json!([{"type": "x", "pad": "y".repeat(17 * 1024)}]);
        let r3 = t.ask(with(big));
        let p3 = t.next_prompt(3).await;
        assert_eq!(p3.suggestions, None);
        t.reg.resolve_permission(&p2.request_id, &allow);
        t.reg.resolve_permission(&p3.request_id, &allow);
        r2.await.unwrap();
        r3.await.unwrap();
        t.server.close().await;
    }

    #[tokio::test]
    async fn deny_permission_from_an_old_server_denies_the_held_call_at_once() {
        let t = perm_setup(None, false).await;
        let reply = t.ask(bash());
        let p = t.next_prompt(1).await;
        assert!(
            t.reg
                .deny_permission(&p.request_id, PERMISSION_UNSUPPORTED_SERVER)
        );
        assert_eq!(
            reply.await.unwrap(),
            json!({"behavior": "deny", "message": PERMISSION_UNSUPPORTED_SERVER})
        );
        assert!(!t.reg.deny_permission(&p.request_id, "again"));
        t.server.close().await;
    }

    #[tokio::test]
    async fn unregister_denies_every_held_call_and_later_prompts() {
        let t = perm_setup(None, false).await;
        let a = t.ask(bash());
        let mut second = bash();
        second["tool_use_id"] = json!("toolu_2");
        let b = t.ask(second);
        t.next_prompt(2).await;
        // The registration is gone, but the in-flight HTTP responses still carry the deny.
        t.reg.unregister();
        let want = json!({"behavior": "deny", "message": PERMISSION_SESSION_ENDED});
        assert_eq!(a.await.unwrap(), want);
        assert_eq!(b.await.unwrap(), want);
        t.server.close().await;
    }

    #[tokio::test]
    async fn close_denies_every_held_call() {
        let t = perm_setup(None, false).await;
        let a = t.ask(bash());
        t.next_prompt(1).await;
        let closing = tokio::spawn(async move { t.server.close().await });
        assert_eq!(
            a.await.unwrap(),
            json!({"behavior": "deny", "message": PERMISSION_SHUTDOWN})
        );
        closing.await.unwrap();
    }

    #[tokio::test]
    async fn no_handler_denied_at_once() {
        let t = perm_setup(None, true).await;
        assert_eq!(
            t.ask(bash()).await.unwrap(),
            json!({"behavior": "deny", "message": PERMISSION_NO_HANDLER})
        );
        t.server.close().await;
    }

    #[tokio::test]
    async fn a_failing_handler_denies_and_a_call_during_a_held_call_answers_at_once() {
        // Forwarding failed (the TS handler threw): the call is denied, never stranded.
        let s = server().await;
        let calls = Calls::default();
        let mut h = handlers(&calls, None);
        h.on_permission_request = Some(Arc::new(|_| Err("socket gone".into())));
        let reg = s.register(h, OutcomeRegisterOptions::default());
        let c = connect(reg.url()).await;
        assert_eq!(
            serde_json::from_str::<Value>(&c.text("permission", bash()).await).unwrap(),
            json!({"behavior": "deny", "message": PERMISSION_NO_HANDLER})
        );
        assert_eq!(reg.pending_permissions(), 0);
        s.close().await;

        // The spike's check: other calls on the same token are not blocked by a held one.
        let t = perm_setup(None, false).await;
        let held = t.ask(bash());
        let p = t.next_prompt(1).await;
        let started = std::time::Instant::now();
        assert_eq!(
            t.client
                .text("ask_user", json!({"question": "concurrent?"}))
                .await,
            ASK_USER_RETURN
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        t.reg.resolve_permission(
            &p.request_id,
            &decision(PermissionBehavior::Allow, PermissionScope::Once),
        );
        held.await.unwrap();
        t.server.close().await;
    }

    #[test]
    fn bounded_suggestions_and_texts() {
        assert_eq!(bounded_suggestions(None), None);
        assert_eq!(bounded_suggestions(Some(&json!([]))), None);
        assert_eq!(bounded_suggestions(Some(&json!([1]))), None);
        assert_eq!(bounded_suggestions(Some(&json!({"a": 1}))), None);
        assert_eq!(
            bounded_suggestions(Some(&json!([{"a": 1}]))).map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            OUTCOME_TOOL_NAMES,
            ["mcp__conductor__complete_state", "mcp__conductor__ask_user"]
        );
        assert_eq!(PERMISSION_TOOL, "mcp__conductor__permission");
        assert_eq!(
            permission_tool_name_too_long(),
            "Permission denied: the tool name is longer than 200 characters"
        );
        assert_eq!(
            unknown_transition_text(None, &[opt("a", "x", false)]),
            "Not recorded: complete_state named no transition (that means \"done\"), which is not allowed here. Call complete_state again with `transition` set to exactly one of:\n- a: x"
        );
        assert_eq!(complete_state_description(Some(&[])), COMPLETE_STATE_BASE);
    }
}
