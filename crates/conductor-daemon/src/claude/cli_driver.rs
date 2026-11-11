//! Port of `packages/daemon/src/claude/cli-driver.ts` (MR-T09).
//!
//! The real [`ClaudeDriver`] (ADR-0005): one long-lived `claude -p` child per session in
//! bidirectional stream-json mode, with the outcome tools on the daemon-hosted MCP server
//! (`claude::outcome_server`).
//!
//! ```text
//! let server = Arc::new(start_outcome_server(Default::default()).await?);
//! let driver = create_cli_driver(CliDriverOptions::new(server)); // bin ← CONDUCTOR_CLAUDE_BIN ← claude
//! let s = driver.start_cli(opts)?; s.on(…); s.send_input(answer)?; s.end(); s.kill(None);
//! ```
//!
//! Events are emitted from the session's tasks and the outcome server's handlers, never inside
//! `start`. Those may run on another thread before the caller attaches its listener, so events
//! emitted before the first `on` are held and delivered to that first listener: attach one right
//! after `start` and it sees everything, in order. Nothing is emitted after `exit`. A listener runs
//! with the session's delivery lock held: it may call the session (`send_input`, `kill`, `on`, …)
//! but must not block or wait for another event.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use conductor_protocol::{
    DEFAULT_PERMISSION_TIMEOUT_MS, StartSessionPayloadMcp, StartSessionPayloadMcpMode,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::attachments::pages::{self, PublishPageRequest};
use crate::attachments::upload::{self, AttachTarget};
use crate::claude::driver::{
    ClaudeDriver, DriverError, DriverEvent, DriverListener, DriverSession, DriverStartOptions,
    ListenerId, Listeners, OutputStream, PermissionDecision, PermissionResolution,
    SKIP_PERMISSION_MODE,
};
use crate::claude::edit_guard::write_edit_guard;
use crate::claude::outcome_server::{
    ATTACH_FILE_TOOL, AttachFileHandler, AttachFileRequest, OUTCOME_TOOL_NAMES, OutcomeHandlers,
    OutcomeRegisterOptions, OutcomeRegistration, OutcomeServer, PERMISSION_TOOL, PUBLISH_PAGE_TOOL,
    PublishPageHandler, RUN_GATE_TOOL, RunGateHandler, checked_transitions,
};
use crate::claude::stream_parser::{ParsedLine, parse_stream_line};
use crate::platform::Platform;
use crate::platform::acl::{mkdir_private, write_private_file};
use crate::platform::kill_tree::{
    KillTarget, KillTreeHandle, KillTreeOptions, KilledExit, Signal, kill_tree, killed_exit,
};
use crate::platform::machine::home_dir;
use crate::platform::spawn::{
    CliChild, CliOptions, Env, StdioKind, TreeHandle, exec_file_cli, exit_parts,
    native_exe_problem, process_env, spawn_cli,
};

pub const CLAUDE_BIN_ENV: &str = "CONDUCTOR_CLAUDE_BIN";
pub const DEFAULT_KILL_GRACE: Duration = Duration::from_millis(5_000);
pub const DEFAULT_END_GRACE: Duration = Duration::from_millis(10_000);
/// After the child exits, how long to wait for stdout/stderr to drain before emitting `exit`.
const DRAIN: Duration = Duration::from_millis(2_000);

/// Tests only: extra state-env keys to pass through (the fake's `FAKE_CLAUDE_*`).
pub type StateEnvFilter = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// `CliDriverOptions`.
#[derive(Clone)]
pub struct CliDriverOptions {
    /// Path or name of the `claude` executable. Default: $CONDUCTOR_CLAUDE_BIN, else `claude`.
    pub claude_bin: Option<String>,
    pub outcome_server: Arc<OutcomeServer>,
    /// Default grace for `kill` when the caller passes none.
    pub kill_grace: Option<Duration>,
    /// `end` closes stdin; if the process is still alive after this, it is killed.
    pub end_grace: Option<Duration>,
    /// Tests only: extra state-env keys to pass through.
    pub extra_state_env: Option<StateEnvFilter>,
    /// Tests only: args put before claude's own, e.g. node + `[fake-claude.mjs]`, since Windows
    /// only runs a native .exe as claude (U-110).
    pub claude_prefix_args: Vec<String>,
    /// ADR-0023: does this Claude CLI support auto mode and `--permission-prompts host` (see
    /// [`probe_permission_prompts`])? Default true. False → the old flags (the user's mode with
    /// the bypass cap, `--permission-prompts none`) and a debug line on every session.
    pub permission_prompts: Option<bool>,
}

impl CliDriverOptions {
    pub fn new(outcome_server: Arc<OutcomeServer>) -> Self {
        CliDriverOptions {
            claude_bin: None,
            outcome_server,
            kill_grace: None,
            end_grace: None,
            extra_state_env: None,
            claude_prefix_args: Vec::new(),
            permission_prompts: None,
        }
    }
}

/// Write the session's `--mcp-config` JSON (it holds the per-session URL token) to a private file
/// (0600 / owner-only DACL) in a fresh private directory under `parent`, so the token never
/// appears in argv / `ps` (M1-T14). Remove it with [`remove_mcp_config_file`] when the process is
/// gone.
pub fn write_mcp_config_file(mcp_config: &str, parent: &Path) -> Result<PathBuf, String> {
    let dir = tempfile::Builder::new()
        .prefix("conductor-mcp-")
        .tempdir_in(parent)
        .map_err(|e| format!("mcp config: {e}"))?
        .keep();
    let written = mkdir_private(&dir)
        .and_then(|()| write_private_file(&dir.join("mcp.json"), mcp_config.as_bytes()));
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("mcp config: {e}"));
    }
    Ok(dir.join("mcp.json"))
}

/// The longest `--append-system-prompt` passed on the command line. Windows refuses a command
/// line over 32,767 characters (`ENAMETOOLONG` / error 206), and the prompt carries the repo's
/// CLAUDE.md (up to `MAX_CLAUDE_MD_BYTES` = 64 KiB). Anything longer goes in a file instead.
pub const MAX_ARGV_SYSTEM_PROMPT_CHARS: usize = 8 * 1024;

/// A long `append_system_prompt` moved into `system-prompt.md` in the session's private directory
/// (`dir`, the one holding mcp.json, removed with it), passed as `--append-system-prompt-file`. A
/// short one stays on the command line, so most starts are unchanged.
pub fn spill_system_prompt(
    mut opts: DriverStartOptions,
    dir: &Path,
) -> Result<DriverStartOptions, String> {
    let long = opts
        .append_system_prompt
        .as_ref()
        .is_some_and(|t| t.chars().count() > MAX_ARGV_SYSTEM_PROMPT_CHARS);
    if !long {
        return Ok(opts);
    }
    let text = opts.append_system_prompt.take().unwrap_or_default();
    let path = dir.join("system-prompt.md");
    write_private_file(&path, text.as_bytes()).map_err(|e| format!("system prompt: {e}"))?;
    opts.append_system_prompt_file = Some(path);
    Ok(opts)
}

/// Best effort: a tmp dir left behind holds a token that is already unregistered.
pub fn remove_mcp_config_file(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `AGENT_ENV`: what the agent always gets, over the daemon env and the state env (ADR-0006):
/// safe mode (which would drop the edit-guard hook) stays off, and (ADR-0023) the MCP tool timeout
/// outlasts a held permission prompt. It applies to the user's inherited MCP servers too
/// (ADR-0029). The CLI's Bash tool kills a command after 2 min by default, so an agent's own test
/// run died and was retried: 10 min by default, 30 at most. R2: corepack never stops an agent to
/// ask before downloading a package manager (07 §Worktree setup).
pub fn agent_env_pins() -> [(&'static str, String); 5] {
    [
        ("CLAUDE_CODE_SAFE_MODE", "0".to_string()),
        (
            crate::actions::worktree_setup::COREPACK_ENV.0,
            crate::actions::worktree_setup::COREPACK_ENV.1.to_string(),
        ),
        (
            "MCP_TOOL_TIMEOUT",
            (DEFAULT_PERMISSION_TIMEOUT_MS + 5 * 60_000).to_string(),
        ),
        ("BASH_DEFAULT_TIMEOUT_MS", (10 * 60_000).to_string()),
        ("BASH_MAX_TIMEOUT_MS", (30 * 60_000).to_string()),
    ]
}

/// ADR-0006 / ADR-0029 `none`: the user's claude.ai connectors stay out of the session;
/// `--strict-mcp-config` doesn't cover them.
pub const NO_CLAUDEAI_MCP_ENV: (&str, &str) = ("ENABLE_CLAUDEAI_MCP_SERVERS", "false");

/// `mcpServerRule` (`@conductor/shared`, ADR-0029): the `--disallowedTools` rule that denies every
/// tool of an MCP server. Claude Code's tool prefix: the trimmed name with every character outside
/// `[A-Za-z0-9_-]` as `_` (one per UTF-16 unit, as the JS regex replaces).
// TD-203: ported here, not in conductor-protocol with shared vectors like resolve_tool_policy.
pub fn mcp_server_rule(server: &str) -> String {
    let trimmed = server.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    let mut out = String::from("mcp__");
    for c in trimmed.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out
}

/// What [`agent_mcp`] decides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMcp {
    /// Only conductor's server (`--strict-mcp-config` + NO_CLAUDEAI_MCP_ENV).
    pub strict: bool,
    /// `--disallowedTools` rules for the user's servers the policy denies.
    pub deny: Vec<String>,
}

/// ADR-0029: how a start's MCP policy maps to the CLI. `strict` (policy `none`, absent, or a
/// reviewer): only conductor's server. Otherwise the user's servers and connectors load, and
/// `deny` holds the rules for the denied ones (deduplicated, in order).
pub fn agent_mcp(mcp: Option<&StartSessionPayloadMcp>, review: bool) -> AgentMcp {
    let Some(p) = mcp else {
        return AgentMcp {
            strict: true,
            deny: Vec::new(),
        };
    };
    if review || p.mode == StartSessionPayloadMcpMode::None {
        return AgentMcp {
            strict: true,
            deny: Vec::new(),
        };
    }
    let mut deny: Vec<String> = Vec::new();
    for d in &p.deny {
        let rule = mcp_server_rule(d);
        if !deny.contains(&rule) {
            deny.push(rule);
        }
    }
    AgentMcp {
        strict: false,
        deny,
    }
}

/// `STATE_ENV_ALLOWED` (`^(CONDUCTOR_[A-Z0-9_]+|PORT|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$`): the
/// state-env keys the agent may receive. Anything else (HOME, NODE_OPTIONS, CLAUDE_CONFIG_DIR,
/// ANTHROPIC_API_KEY, …) could point `claude` at other settings, switch billing or inject code, so
/// it is dropped. A future per-state workflow env must extend this deliberately.
pub fn state_env_allowed(key: &str) -> bool {
    if let Some(rest) = key.strip_prefix("CONDUCTOR_") {
        return !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    }
    matches!(
        key,
        "PORT"
            | "GIT_AUTHOR_NAME"
            | "GIT_AUTHOR_EMAIL"
            | "GIT_COMMITTER_NAME"
            | "GIT_COMMITTER_EMAIL"
    )
}

/// Set `key` in `env`, replacing an existing entry (case-insensitively on Windows, where env names
/// are).
fn env_set(env: &mut Env, key: &str, value: &str) {
    let windows = Platform::current() == Platform::Windows;
    let same = |k: &str| {
        if windows {
            k.eq_ignore_ascii_case(key)
        } else {
            k == key
        }
    };
    env.retain(|(k, _)| !same(k));
    env.push((key.to_string(), value.to_string()));
}

/// The child's env: `base` (the daemon env), then the allowed state-env keys, then the
/// [`agent_env_pins`] (and NO_CLAUDEAI_MCP_ENV when `strict_mcp`). Also returns the state-env keys
/// that were refused. Pure: [`agent_env`] passes this process's env.
pub fn agent_env_over(
    base: Env,
    state_env: &BTreeMap<String, String>,
    extra_allowed: Option<&StateEnvFilter>,
    strict_mcp: bool,
) -> (Env, Vec<String>) {
    let mut env = base;
    let mut dropped = Vec::new();
    for (k, v) in state_env {
        if state_env_allowed(k) || extra_allowed.is_some_and(|f| f(k)) {
            env_set(&mut env, k, v);
        } else {
            dropped.push(k.clone());
        }
    }
    for (k, v) in agent_env_pins() {
        env_set(&mut env, k, &v);
    }
    if strict_mcp {
        env_set(&mut env, NO_CLAUDEAI_MCP_ENV.0, NO_CLAUDEAI_MCP_ENV.1);
    }
    (env, dropped)
}

/// `agentEnv`: [`agent_env_over`] this process's env.
pub fn agent_env(
    state_env: &BTreeMap<String, String>,
    extra_allowed: Option<&StateEnvFilter>,
    strict_mcp: bool,
) -> (Env, Vec<String>) {
    agent_env_over(process_env(), state_env, extra_allowed, strict_mcp)
}

/// The user settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`.
pub fn user_settings_file() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".claude"))
        .join("settings.json")
}

/// Only for a CLI without ADR-0023 support (`permission_prompts: false`).
///
/// The `--permission-mode` to pass, if any (ADR-0006). The user's own default applies, except
/// `bypassPermissions`, which is capped to `auto`: an unattended agent keeps auto mode's
/// classifier. Reads `permissions.defaultMode` from `settings_file`; unreadable → no flag.
pub fn agent_permission_mode(settings_file: &Path) -> Option<&'static str> {
    let text = std::fs::read_to_string(settings_file).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    (v.pointer("/permissions/defaultMode")
        .and_then(Value::as_str)
        == Some("bypassPermissions"))
    .then_some("auto")
}

/// ADR-0023 §1: every working agent runs in auto mode, whatever the user's `defaultMode`.
pub const WORKER_PERMISSION_MODE: &str = "auto";

/// ADR-0009: the permission mode of a requirements reviewer, whatever the user's own mode. In
/// dontAsk only pre-approved tools run; anything else is denied without a prompt.
pub const REVIEWER_PERMISSION_MODE: &str = "dontAsk";

/// How [`build_claude_args`] sets permissions. `Host` (ADR-0023): workers run in auto mode and
/// what it would still ask goes to `mcp__conductor__permission`. `None`: the pre-ADR-0023 flags,
/// for a CLI without auto mode or `--permission-prompts host`: `legacy_mode` is
/// [`agent_permission_mode`] (the bypass cap) and anything that would prompt is denied.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PermissionArgs {
    #[default]
    Host,
    None {
        legacy_mode: Option<String>,
    },
}

/// What [`probe_permission_prompts`] found. `reason` says what is missing when unsupported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionPromptSupport {
    pub supported: bool,
    pub reason: Option<String>,
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The byte offsets just after each `needle` in `hay` that ends at a word boundary (regex `\b`).
fn flag_ends<'a>(hay: &'a str, needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    hay.match_indices(needle).filter_map(move |(i, _)| {
        let end = i + needle.len();
        let next = hay.as_bytes().get(end).copied();
        (!next.is_some_and(is_word_byte)).then_some(end)
    })
}

/// ADR-0023: is `help` (the CLI's `--help` text) from a Claude Code that has
/// `--permission-prompts` and the `auto` permission mode? (`--permission-prompt-tool` is hidden,
/// so it can't be checked; it predates both.)
pub fn permission_prompt_support(help: &str) -> PermissionPromptSupport {
    let mut missing = Vec::new();
    if flag_ends(help, "--permission-prompts").next().is_none() {
        missing.push("--permission-prompts");
    }
    // /--permission-mode\b[\s\S]*?"auto"/
    let auto = flag_ends(help, "--permission-mode")
        .next()
        .is_some_and(|end| help[end..].contains("\"auto\""));
    if !auto {
        missing.push("--permission-mode auto");
    }
    if missing.is_empty() {
        PermissionPromptSupport {
            supported: true,
            reason: None,
        }
    } else {
        PermissionPromptSupport {
            supported: false,
            reason: Some(format!("claude --help lists no {}", missing.join(" / "))),
        }
    }
}

/// The first `max` UTF-16 units of `s` (JS `slice(0, max)`, never splitting a char).
fn js_slice(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The `claude` to run: `$CONDUCTOR_CLAUDE_BIN`, else `claude`.
pub fn default_claude_bin() -> String {
    std::env::var(CLAUDE_BIN_ENV).unwrap_or_else(|_| "claude".to_string())
}

/// Run `<bin> --help` once and check it with [`permission_prompt_support`] (unsupported on
/// failure). `prefix_args`: tests only, as [`CliDriverOptions::claude_prefix_args`].
pub async fn probe_permission_prompts(
    bin: &str,
    prefix_args: &[String],
) -> PermissionPromptSupport {
    let mut args = prefix_args.to_vec();
    args.push("--help".into());
    let opts = CliOptions {
        timeout: Some(Duration::from_millis(10_000)),
        ..CliOptions::default()
    };
    let failed = |msg: String| PermissionPromptSupport {
        supported: false,
        reason: Some(format!("claude --help failed: {}", js_slice(&msg, 200))),
    };
    match exec_file_cli(bin, &args, opts).await {
        Err(e) => failed(e.to_string()),
        Ok(out) => {
            // TD-204: no maxBuffer (1 MiB in TS); `--help` is a few KiB.
            let stdout = String::from_utf8_lossy(&out.output.stdout);
            let ok = out.output.status.success() && !out.timed_out;
            if !ok && stdout.is_empty() {
                let why = if out.timed_out {
                    "timed out".to_string()
                } else {
                    format!("Command failed: {} {}", bin, args.join(" "))
                };
                return failed(why);
            }
            permission_prompt_support(&stdout)
        }
    }
}

/// JS `String(n)` for a finite number (`1` not `1.0`, `0.5`, `1e+21`).
fn js_number(n: f64) -> String {
    if n.is_finite() {
        ryu_js::Buffer::new().format(n).to_string()
    } else if n.is_nan() {
        "NaN".into()
    } else if n > 0.0 {
        "Infinity".into()
    } else {
        "-Infinity".into()
    }
}

/// The exact argv of ADR-0005 §Spawn as amended by ADR-0006 and ADR-0023 (without the
/// executable). `mcp_config` is what goes after `--mcp-config`: the driver passes the path from
/// [`write_mcp_config_file`], never the JSON itself. `settings` is the edit-guard settings file.
///
/// ADR-0006: the user's settings load (`--setting-sources user`, never `project`: the repo is
/// untrusted). The state's policy still limits the visible built-ins (`--tools`), pre-approves its
/// rules and adds its denies (`--disallowedTools`): deny rules are evaluated before any prompt, so
/// they never reach a human (ADR-0023 §4). TD-081: what the user's settings allow is per machine.
///
/// ADR-0023 (`Host`, the default): a worker runs in `--permission-mode auto` and what auto mode
/// would still ask goes to conductor. A requirements reviewer (ADR-0009) runs in `dontAsk` with
/// `--permission-prompts none`. `None` is the fallback for an old CLI.
pub fn build_claude_args(
    opts: &DriverStartOptions,
    mcp_config: &str,
    settings: &str,
    permission: &PermissionArgs,
) -> Vec<String> {
    let t = &opts.tools;
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .map(String::from)
    .to_vec();
    args.push(
        if opts.resume {
            "--resume"
        } else {
            "--session-id"
        }
        .into(),
    );
    args.push(opts.claude_session_id.clone());
    if let Some(model) = &opts.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(n) = opts.max_turns {
        args.extend(["--max-turns".into(), n.to_string()]);
    }
    if let Some(usd) = opts.max_budget_usd {
        args.extend(["--max-budget-usd".into(), js_number(usd)]);
    }
    args.extend([
        "--setting-sources".into(),
        "user".into(),
        "--settings".into(),
        settings.to_string(),
    ]);
    // 06 §Attachments: the session's downloaded attachments, readable without a prompt.
    for dir in &opts.add_dirs {
        args.extend(["--add-dir".into(), dir.to_string_lossy().into_owned()]);
    }
    // ADR-0029: the user's MCP servers load unless the policy is `none` (or this is a reviewer).
    let mcp = agent_mcp(opts.mcp.as_ref(), opts.review);
    if mcp.strict {
        args.push("--strict-mcp-config".into());
    }
    // ADR-0009: a reviewer is forced into dontAsk and never prompts. ADR-0023: a worker runs in
    // auto mode and its prompts go to conductor; on an old CLI it keeps the user's mode, capped.
    let host = *permission == PermissionArgs::Host && !opts.review;
    // ADR-0039: a worker with skip permissions runs in bypassPermissions (deny rules and the
    // edit-guard hook still apply); a reviewer never does.
    let mode: Option<&str> = if opts.review {
        Some(REVIEWER_PERMISSION_MODE)
    } else if opts.skip_permissions {
        Some(SKIP_PERMISSION_MODE)
    } else {
        match permission {
            PermissionArgs::Host => Some(WORKER_PERMISSION_MODE),
            PermissionArgs::None { legacy_mode } => legacy_mode.as_deref(),
        }
    };
    if let Some(mode) = mode {
        args.extend(["--permission-mode".into(), mode.to_string()]);
    }
    if host {
        args.extend([
            "--permission-prompts".into(),
            "host".into(),
            "--permission-prompt-tool".into(),
            PERMISSION_TOOL.into(),
        ]);
    } else {
        args.extend(["--permission-prompts".into(), "none".into()]);
    }
    let allowed: Vec<&str> = t
        .allow
        .iter()
        .map(String::as_str)
        .chain(OUTCOME_TOOL_NAMES)
        // 06 §Attachments: the agent may attach captures without a prompt (Rust only).
        .chain(attach_tool(opts))
        // ADR-0038: and publish pages, for a state with the `pages` tool.
        .chain(publish_target(opts).map(|_| PUBLISH_PAGE_TOOL))
        // R4: and run the gate's checks, when a transition runs any.
        .chain(run_gate_handler(opts).map(|_| RUN_GATE_TOOL))
        .collect();
    args.extend([
        "--mcp-config".into(),
        mcp_config.to_string(),
        "--tools".into(),
        t.builtin.join(","),
        "--allowedTools".into(),
        allowed.join(","),
    ]);
    let deny: Vec<&str> = t
        .deny
        .iter()
        .chain(mcp.deny.iter())
        .map(String::as_str)
        .collect();
    if !deny.is_empty() {
        args.extend(["--disallowedTools".into(), deny.join(",")]);
    }
    if let Some(f) = &opts.append_system_prompt_file {
        args.extend([
            "--append-system-prompt-file".into(),
            f.to_string_lossy().into_owned(),
        ]);
    } else if let Some(p) = &opts.append_system_prompt {
        args.extend(["--append-system-prompt".into(), p.clone()]);
    }
    args
}

/// One stream-json user message line, keys in the TS order.
pub fn user_message_line(text: &str) -> String {
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!(
        "{{\"type\":\"user\",\"session_id\":\"\",\"parent_tool_use_id\":null,\
         \"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":{text}}}]}}}}\n"
    )
}

/// ADR-0039: the mode note of a working agent with skip permissions on.
pub const SKIP_PERMISSIONS_NOTE: &str = "running in bypassPermissions mode (skip permissions); deny \
     rules and the edit guard still apply";

/// The `conductor: …` debug lines a session starts with (without the prefix).
pub fn start_notes(
    review: bool,
    permission_prompts: bool,
    legacy_mode: Option<&str>,
    mcp: &AgentMcp,
    dropped: &[String],
) -> Vec<String> {
    let mut notes = Vec::new();
    if review {
        notes.push(format!(
            "requirements reviewer: running in {REVIEWER_PERMISSION_MODE} mode"
        ));
    } else if permission_prompts {
        notes.push(format!(
            "running in {WORKER_PERMISSION_MODE} mode; permission prompts go to the conductor board"
        ));
    } else {
        // TD-187: ADR-0023 asks for a machine alert here; the alert frame has no kind for it yet.
        notes.push(
            "this Claude Code has no auto mode / --permission-prompts host: running with the old \
             flags, so anything that would prompt is denied (update Claude Code)"
                .into(),
        );
        if legacy_mode.is_some() {
            notes.push(
                "user defaultMode is bypassPermissions; running this agent in auto mode".into(),
            );
        }
    }
    notes.push(if mcp.strict {
        "MCP: only conductor's server".into()
    } else if mcp.deny.is_empty() {
        "MCP: the user's servers and claude.ai connectors".into()
    } else {
        format!(
            "MCP: the user's servers and claude.ai connectors, except {}",
            mcp.deny.join(", ")
        )
    });
    if !dropped.is_empty() {
        notes.push(format!(
            "dropped state env keys not allowed: {}",
            dropped.join(", ")
        ));
    }
    notes
}

/// Take the longest decodable UTF-8 prefix of `carry` (invalid bytes become U+FFFD) and leave an
/// incomplete trailing character in it for the next read. `last`: no more bytes are coming, so
/// take everything.
fn take_utf8(carry: &mut Vec<u8>, last: bool) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // The prefix is valid UTF-8 (from_utf8 says so).
                out.push_str(&String::from_utf8_lossy(&carry[..valid]));
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        carry.drain(..valid + n);
                    }
                    None if last => {
                        out.push('\u{FFFD}');
                        carry.clear();
                        return out;
                    }
                    None => {
                        carry.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

// ---- The session ----

#[derive(Default)]
struct State {
    /// Events emitted before the first listener was attached, delivered to it when it is (see
    /// [`Shared::emit`]). None once a listener is attached.
    pending: Option<Vec<DriverEvent>>,
    id: String,
    announced: bool,
    /// `exit` emitted.
    exited: bool,
    /// The OS process is gone (exit, or the spawn failed).
    child_gone: bool,
    kill_requested: bool,
    /// The last kill signal sent (Windows reports a killed child as this, see `killed_exit`).
    last_signal: Option<Signal>,
    exit_info: Option<KilledExit>,
    cli_version: Option<String>,
    /// The stdin writer's queue; None once `end` closed it or the process is gone.
    stdin: Option<mpsc::UnboundedSender<String>>,
    end_timer: Option<JoinHandle<()>>,
    escalation: Option<KillTreeHandle>,
}

/// What the outcome server's handlers and the session's tasks share (no registration in here, so
/// the handlers stored in the registration don't keep it alive in a cycle).
struct Shared {
    listeners: Listeners,
    st: Mutex<State>,
    /// Serialises deliveries, so listeners see events in the order they were emitted even when
    /// they come from different tasks (the stdout reader, the outcome server's handlers). Taken
    /// before `st`, never the other way round.
    delivery: Mutex<()>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn deliver_lock(&self) -> MutexGuard<'_, ()> {
        self.delivery.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Deliver `ev`, unless `exit` was already emitted. TS emits from the event loop, so a listener
    /// attached right after `start()` sees everything; here the session's tasks may run on another
    /// thread before the caller attaches, so events emitted before the first listener are held and
    /// delivered to it when it is attached ([`Shared::attach`]). `exit` marks the end: nothing is
    /// delivered after it.
    fn deliver(&self, ev: DriverEvent, exit: bool) {
        let _order = self.deliver_lock();
        {
            let mut st = self.lock();
            if st.exited {
                return;
            }
            if exit {
                st.exited = true;
            }
            if let Some(q) = st.pending.as_mut() {
                q.push(ev);
                return;
            }
        }
        self.listeners.emit(&ev);
    }

    fn emit(&self, ev: &DriverEvent) {
        self.deliver(ev.clone(), false);
    }

    /// `on`: the first listener gets the held events first, in order.
    fn attach(&self, listener: DriverListener) -> ListenerId {
        // Only the first attach has a backlog; later ones (maybe from inside a listener, which
        // runs under `delivery`) must not take the delivery lock.
        if self.lock().pending.is_none() {
            return self.listeners.add(listener);
        }
        let _order = self.deliver_lock();
        let backlog = {
            let mut st = self.lock();
            let backlog = st.pending.take().unwrap_or_default();
            // Inside the st lock, so no event can slip between the backlog and the live ones.
            (self.listeners.add(listener.clone()), backlog)
        };
        for ev in &backlog.1 {
            listener(ev);
        }
        backlog.0
    }

    fn output(&self, stream: OutputStream, text: String) {
        self.emit(&DriverEvent::Output { stream, text });
    }
}

struct Inner {
    shared: Arc<Shared>,
    reg: OutcomeRegistration,
    mcp_config_path: PathBuf,
    /// Kept for the session's life: on Windows the last handle's drop kills the job.
    tree: TreeHandle,
    bin: String,
    kill_grace: Duration,
    end_grace: Duration,
}

impl Inner {
    fn kill(&self, grace: Option<Duration>) {
        {
            let mut st = self.shared.lock();
            if st.child_gone || st.kill_requested {
                return;
            }
            st.kill_requested = true;
            st.last_signal = Some(Signal::Term);
        }
        // The whole tree: POSIX the process group (then SIGKILL after the grace), Windows the job.
        let h = kill_tree(
            KillTarget::Child(&self.tree),
            KillTreeOptions {
                signal: Some(Signal::Term),
                grace: Some(grace.unwrap_or(self.kill_grace)),
            },
        )
        .ok();
        let mut st = self.shared.lock();
        if let Some(h) = h {
            if st.child_gone {
                h.cancel();
            } else {
                st.escalation = Some(h);
            }
        }
    }

    fn on_line(&self, line: &str) {
        for item in parse_stream_line(line) {
            match item {
                ParsedLine::Event(ev) => self.shared.emit(&ev),
                ParsedLine::Init {
                    session_id,
                    cli_version,
                } => {
                    let mut out = Vec::new();
                    {
                        let mut st = self.shared.lock();
                        if let Some(v) = cli_version
                            && st.cli_version.is_none()
                        {
                            out.push(DriverEvent::Output {
                                stream: OutputStream::Debug,
                                text: format!("claude_code_version {v}"),
                            });
                            st.cli_version = Some(v);
                        }
                        // init repeats every turn: announce once, and again only if the id changes.
                        if let Some(sid) = session_id
                            && (!st.announced || sid != st.id)
                        {
                            if sid != st.id {
                                out.push(DriverEvent::Output {
                                    stream: OutputStream::Debug,
                                    text: format!(
                                        "conductor: system/init session_id {sid} differs from the requested {}",
                                        st.id
                                    ),
                                });
                            }
                            st.id = sid.clone();
                            st.announced = true;
                            out.push(DriverEvent::ClaudeSessionId { id: sid });
                        }
                    }
                    for ev in &out {
                        self.shared.emit(ev);
                    }
                }
            }
        }
    }

    fn on_child_gone(&self, status: Option<&ExitStatus>) {
        let (code, signal) = status.map(exit_parts).unwrap_or((None, None));
        let killed = {
            let mut st = self.shared.lock();
            if st.child_gone {
                return;
            }
            st.child_gone = true;
            let sent = if st.kill_requested {
                st.last_signal
            } else {
                None
            };
            st.exit_info = Some(killed_exit(code, signal.as_deref(), sent));
            if let Some(t) = st.end_timer.take() {
                t.abort();
            }
            if let Some(h) = st.escalation.take() {
                h.cancel();
            }
            st.stdin = None;
            st.kill_requested
        };
        self.reg.unregister();
        remove_mcp_config_file(&self.mcp_config_path);
        // After a kill, reap any tool processes Claude left behind in its group.
        if killed {
            self.shared.lock().last_signal = Some(Signal::Kill);
            let _ = kill_tree(
                KillTarget::Child(&self.tree),
                KillTreeOptions {
                    signal: Some(Signal::Kill),
                    grace: None,
                },
            );
        }
    }

    fn finish(&self) {
        let Some(info) = self.shared.lock().exit_info.clone() else {
            return;
        };
        self.shared.deliver(
            DriverEvent::Exit {
                code: info.code,
                signal: info.signal,
            },
            true,
        );
    }
}

/// A [`DriverSession`] on a real `claude` process, plus what the CLI reported about itself.
pub struct CliDriverSession {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for CliDriverSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "CliDriverSession({}, {})",
            self.inner.bin,
            self.inner.shared.lock().id
        )
    }
}

impl CliDriverSession {
    /// `claude_code_version` from the first system/init (U-015); None until then.
    pub fn cli_version(&self) -> Option<String> {
        self.inner.shared.lock().cli_version.clone()
    }

    fn write(&self, text: &str, answer: bool) -> Result<(), DriverError> {
        let tx = {
            let st = self.inner.shared.lock();
            if st.child_gone {
                return Err(DriverError::Exited);
            }
            st.stdin.clone().ok_or(DriverError::Exited)?
        };
        if answer {
            self.inner.reg.answered();
        }
        tx.send(user_message_line(text))
            .map_err(|_| DriverError::Exited)
    }
}

impl DriverSession for CliDriverSession {
    fn claude_session_id(&self) -> String {
        self.inner.shared.lock().id.clone()
    }

    fn pid(&self) -> Option<u32> {
        self.inner.tree.pid()
    }

    fn on(&self, listener: DriverListener) -> ListenerId {
        self.inner.shared.attach(listener)
    }

    fn off(&self, id: ListenerId) {
        self.inner.shared.listeners.remove(id);
    }

    fn send_input(&self, text: &str) -> Result<(), DriverError> {
        self.write(text, true)
    }

    /// Not an answer (ADR-0007): the outcome server's pending question is left as it is.
    fn send_message(&self, text: &str) -> Result<(), DriverError> {
        self.write(text, false)
    }

    fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> PermissionResolution {
        self.inner.reg.resolve_permission(request_id, &decision)
    }

    fn deny_permission(&self, request_id: &str, message: &str) -> bool {
        self.inner.reg.deny_permission(request_id, message)
    }

    fn end(&self) {
        let mut st = self.inner.shared.lock();
        if st.child_gone {
            return;
        }
        st.stdin = None; // the writer drains its queue, then closes stdin
        if st.end_timer.is_none() {
            let inner = self.inner.clone();
            let grace = self.inner.end_grace;
            st.end_timer = Some(tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                inner.kill(None);
            }));
        }
    }

    fn kill(&self, grace: Option<Duration>) {
        self.inner.kill(grace);
    }
}

/// Feed stdin from the queue until it closes (end) or a write fails.
async fn write_stdin(
    mut stdin: ChildStdin,
    mut rx: mpsc::UnboundedReceiver<String>,
    shared: Arc<Shared>,
) {
    while let Some(line) = rx.recv().await {
        let r = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        }
        .await;
        if let Err(e) = r {
            shared.output(OutputStream::Debug, format!("conductor: stdin error: {e}"));
            return;
        }
    }
}

type Stream = Box<dyn AsyncRead + Send + Unpin>;

/// Pump stdout lines and stderr chunks into events until the child is gone and both streams are
/// closed, or `DRAIN` after it is gone (a grandchild may hold the pipes open), then emit `exit`.
async fn run(
    inner: Arc<Inner>,
    mut child: CliChild,
    stdout: Stream,
    stderr: Stream,
    notes: Vec<String>,
) {
    for note in notes {
        inner
            .shared
            .output(OutputStream::Debug, format!("conductor: {note}"));
    }
    let mut stdout = BufReader::new(stdout);
    let mut stderr = stderr;
    let mut line: Vec<u8> = Vec::new();
    let mut err_buf = vec![0u8; 8192];
    let mut carry: Vec<u8> = Vec::new();
    let (mut out_open, mut err_open) = (true, true);
    let mut drain_until: Option<tokio::time::Instant> = None;
    loop {
        if drain_until.is_some() && !out_open && !err_open {
            break;
        }
        tokio::select! {
            // read_until is cancel-safe: a partial line stays in `line` for the next call.
            r = stdout.read_until(b'\n', &mut line), if out_open => {
                match r {
                    Ok(0) | Err(_) => {
                        out_open = false;
                        if !line.is_empty() {
                            inner.on_line(trim_eol(&String::from_utf8_lossy(&line)));
                            line.clear();
                        }
                    }
                    Ok(_) => {
                        if line.ends_with(b"\n") {
                            inner.on_line(trim_eol(&String::from_utf8_lossy(&line)));
                            line.clear();
                        }
                    }
                }
            }
            r = stderr.read(&mut err_buf), if err_open => {
                match r {
                    Ok(0) | Err(_) => {
                        err_open = false;
                        if !carry.is_empty() {
                            let text = take_utf8(&mut carry, true);
                            inner.shared.output(OutputStream::Stderr, text);
                        }
                    }
                    Ok(n) => {
                        carry.extend_from_slice(&err_buf[..n]);
                        let text = take_utf8(&mut carry, false);
                        if !text.is_empty() {
                            inner.shared.output(OutputStream::Stderr, text);
                        }
                    }
                }
            }
            status = child.wait(), if drain_until.is_none() => {
                inner.on_child_gone(status.as_ref().ok());
                drain_until = Some(tokio::time::Instant::now() + DRAIN);
            }
            () = tokio::time::sleep_until(drain_until.unwrap_or_else(tokio::time::Instant::now)), if drain_until.is_some() => {
                break;
            }
        }
    }
    inner.finish();
}

/// The line without its `\n` / `\r\n` (readline's `crlfDelay: Infinity`).
fn trim_eol(s: &str) -> &str {
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.strip_suffix('\r').unwrap_or(s)
}

// ---- The driver ----

/// `createCliDriver`.
pub struct CliDriver {
    bin: String,
    server: Arc<OutcomeServer>,
    kill_grace: Duration,
    end_grace: Duration,
    extra_state_env: Option<StateEnvFilter>,
    prefix_args: Vec<String>,
    permission_prompts: bool,
}

pub fn create_cli_driver(opts: CliDriverOptions) -> CliDriver {
    CliDriver {
        bin: opts.claude_bin.unwrap_or_else(default_claude_bin),
        server: opts.outcome_server,
        kill_grace: opts.kill_grace.unwrap_or(DEFAULT_KILL_GRACE),
        end_grace: opts.end_grace.unwrap_or(DEFAULT_END_GRACE),
        extra_state_env: opts.extra_state_env,
        prefix_args: opts.claude_prefix_args,
        permission_prompts: opts.permission_prompts.unwrap_or(true),
    }
}

impl CliDriver {
    /// `start`, with the concrete session type. Needs a tokio runtime.
    pub fn start_cli(
        &self,
        opts: DriverStartOptions,
    ) -> Result<Arc<CliDriverSession>, DriverError> {
        // U-110: on Windows only the native claude.exe can take the multi-line system prompt.
        // Checked before anything registers with the outcome server or writes the MCP config.
        let cwd = opts.cwd.to_string_lossy().into_owned();
        if let Some(problem) = native_exe_problem(&self.bin, &process_env(), Some(&cwd)) {
            return Err(DriverError::Other(problem));
        }

        let shared = Arc::new(Shared {
            listeners: Listeners::default(),
            delivery: Mutex::new(()),
            st: Mutex::new(State {
                pending: Some(Vec::new()),
                id: opts.claude_session_id.clone(),
                ..State::default()
            }),
        });
        let reg = self.server.register(
            handlers(
                &shared,
                attach_target(&opts),
                publish_target(&opts),
                run_gate_handler(&opts),
            ),
            OutcomeRegisterOptions {
                transitions: opts.transitions.clone(),
            },
        );
        let mcp_config_path = match write_mcp_config_file(reg.mcp_config(), &std::env::temp_dir()) {
            Ok(p) => p,
            Err(e) => {
                reg.unregister();
                return Err(DriverError::Other(e));
            }
        };
        let session_dir = mcp_config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let settings = match write_edit_guard(&session_dir, &opts.cwd, None) {
            Ok(p) => p,
            Err(e) => {
                reg.unregister();
                remove_mcp_config_file(&mcp_config_path);
                return Err(DriverError::Other(e));
            }
        };

        let opts = match spill_system_prompt(opts, &session_dir) {
            Ok(o) => o,
            Err(e) => {
                reg.unregister();
                remove_mcp_config_file(&mcp_config_path);
                return Err(DriverError::Other(e));
            }
        };

        let legacy_mode = if self.permission_prompts {
            None
        } else {
            agent_permission_mode(&user_settings_file())
        };
        let permission = if self.permission_prompts {
            PermissionArgs::Host
        } else {
            PermissionArgs::None {
                legacy_mode: legacy_mode.map(String::from),
            }
        };
        let mcp = agent_mcp(opts.mcp.as_ref(), opts.review);
        let (env, dropped) = agent_env(&opts.env, self.extra_state_env.as_ref(), mcp.strict);
        let mut notes = start_notes(
            opts.review,
            self.permission_prompts,
            legacy_mode,
            &mcp,
            &dropped,
        );
        // ADR-0039: the first note is the permission mode's.
        if opts.skip_permissions && !opts.review {
            notes[0] = SKIP_PERMISSIONS_NOTE.into();
        }
        let mut args = self.prefix_args.clone();
        args.extend(build_claude_args(
            &opts,
            &mcp_config_path.to_string_lossy(),
            &settings.to_string_lossy(),
            &permission,
        ));
        let spawned = spawn_cli(
            &self.bin,
            &args,
            CliOptions {
                cwd: Some(opts.cwd.clone()),
                env: Some(env),
                // Own process group (POSIX) / Job Object (Windows), so kill() also reaches the tools
                // Claude spawned (bash, test runners).
                detached: true,
                stdin: Some(StdioKind::Piped),
                stdout: Some(StdioKind::Piped),
                stderr: Some(StdioKind::Piped),
                timeout: None,
            },
        );

        let make = |tree: TreeHandle| {
            Arc::new(Inner {
                shared: shared.clone(),
                reg: reg.clone(),
                mcp_config_path: mcp_config_path.clone(),
                tree,
                bin: self.bin.clone(),
                kill_grace: self.kill_grace,
                end_grace: self.end_grace,
            })
        };
        let inner = match spawned {
            Err(e) => {
                let inner = make(TreeHandle::never_spawned());
                let task = inner.clone();
                let msg = e.to_string();
                tokio::spawn(async move {
                    for note in notes {
                        task.shared
                            .output(OutputStream::Debug, format!("conductor: {note}"));
                    }
                    task.shared.output(
                        OutputStream::Stderr,
                        format!("conductor: claude process error: {msg}\n"),
                    );
                    // A spawn failure never produces an exit status.
                    task.on_child_gone(None);
                    task.finish();
                });
                inner
            }
            Ok(mut child) => {
                let inner = make(child.tree.clone());
                let stdin = child.child.stdin.take();
                let stdout: Stream = match child.child.stdout.take() {
                    Some(s) => Box::new(s),
                    None => Box::new(tokio::io::empty()),
                };
                let stderr: Stream = match child.child.stderr.take() {
                    Some(s) => Box::new(s),
                    None => Box::new(tokio::io::empty()),
                };
                let (tx, rx) = mpsc::unbounded_channel();
                let _ = tx.send(user_message_line(&opts.prompt));
                shared.lock().stdin = Some(tx);
                if let Some(stdin) = stdin {
                    tokio::spawn(write_stdin(stdin, rx, shared.clone()));
                }
                tokio::spawn(run(inner.clone(), child, stdout, stderr, notes));
                inner
            }
        };
        Ok(Arc::new(CliDriverSession { inner }))
    }
}

impl ClaudeDriver for CliDriver {
    fn start(&self, opts: DriverStartOptions) -> Result<Arc<dyn DriverSession>, DriverError> {
        Ok(self.start_cli(opts)?)
    }
}

/// 06 §Attachments: the session's attach target; a reviewer gets none.
fn attach_target(opts: &DriverStartOptions) -> Option<AttachTarget> {
    opts.attach.clone().filter(|_| !opts.review)
}

/// `--allowedTools` gets `attach_file` exactly when the tool is listed.
fn attach_tool(opts: &DriverStartOptions) -> Option<&'static str> {
    attach_target(opts).map(|_| ATTACH_FILE_TOOL)
}

/// ADR-0038: where `publish_page` posts: the attach target, for a state with the `pages` tool.
fn publish_target(opts: &DriverStartOptions) -> Option<AttachTarget> {
    attach_target(opts).filter(|_| opts.publish_pages)
}

/// R4: the session's `run_gate` handler: a working agent's (never a reviewer's), and only when
/// an allowed transition runs checks, exactly when the outcome server lists the tool.
fn run_gate_handler(opts: &DriverStartOptions) -> Option<RunGateHandler> {
    let hook = opts.run_gate.as_ref().filter(|_| !opts.review)?;
    (!checked_transitions(opts.transitions.as_deref()).is_empty()).then(|| hook.0.clone())
}

/// `publish_page`'s handler: posts to `target`'s orchestrator (ADR-0038).
fn publish_handler(target: AttachTarget) -> PublishPageHandler {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    Arc::new(move |req: PublishPageRequest| {
        let (client, target) = (client.clone(), target.clone());
        Box::pin(async move { pages::publish(&client, &target, &req).await })
    })
}

/// `attach_file`'s handler: uploads to `target` (06 §Attachments).
fn attach_handler(target: AttachTarget) -> AttachFileHandler {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    Arc::new(move |req: AttachFileRequest| {
        let (client, target) = (client.clone(), target.clone());
        Box::pin(async move {
            upload::upload(
                &client,
                &target,
                std::path::Path::new(&req.path),
                req.caption.as_deref(),
            )
            .await
        })
    })
}

/// The registration's handlers: each emits on the session.
fn handlers(
    shared: &Arc<Shared>,
    attach: Option<AttachTarget>,
    publish: Option<AttachTarget>,
    run_gate: Option<RunGateHandler>,
) -> OutcomeHandlers {
    let (a, c, p) = (shared.clone(), shared.clone(), shared.clone());
    OutcomeHandlers {
        on_ask_user: Arc::new(move |question, options, proposed_checks| {
            a.emit(&DriverEvent::AskUser {
                question,
                options,
                proposed_checks,
            })
        }),
        // ADR-0011: the named transition and reason are forwarded as given.
        on_complete_state: Arc::new(move |result, meta| {
            c.emit(&DriverEvent::CompleteState {
                result,
                transition: meta.transition,
                reason: meta.reason,
            });
        }),
        // ADR-0023: a held prompt. Nobody listening (exited) → deny now, never hold for nothing.
        on_permission_request: Some(Arc::new(move |prompt| {
            {
                let st = p.lock();
                if st.exited || st.child_gone {
                    return Err("process gone".into());
                }
            }
            p.emit(&DriverEvent::PermissionRequest {
                request_id: prompt.request_id,
                tool: prompt.tool,
                input: prompt.input,
                suggestions: prompt.suggestions,
                tool_use_id: prompt.tool_use_id,
                expires_at: prompt.expires_at,
            });
            Ok(())
        })),
        on_attach_file: attach.map(attach_handler),
        on_publish_page: publish.map(publish_handler),
        on_run_gate: run_gate,
    }
}

#[cfg(test)]
mod tests;
