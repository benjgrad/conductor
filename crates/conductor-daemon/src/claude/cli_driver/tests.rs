//! Ports of `cli-driver.test.ts` and `cli-driver.real.test.ts`. The real driver and the real
//! outcome server run against the process-boundary fake (`e2e/fixtures/
//! fake-claude.mjs`, under node): the process boundary (spawn, stdio, kill, MCP over HTTP) is what
//! these tests are about, so they spawn processes. The pure cases (argv, env, notes) don't.

use super::*;
use std::sync::OnceLock;
use std::time::Instant;

use conductor_protocol::tool_policy::resolve_tool_policy;
use conductor_protocol::{AgentTransitionOption, PermissionBehavior, PermissionScope};
use serde_json::json;

use crate::claude::driver::{ToolPolicy, Usage};
use crate::claude::outcome_server::{
    ASK_USER_TOOL, COMPLETE_STATE_TOOL, OutcomeServerOptions, PERMISSION_DENIED_ON_BOARD,
    PERMISSION_SESSION_ENDED, permission_timeout_text, start_outcome_server,
};
use crate::platform::acl::{AclKind, AssertOwnerOnlyOptions, assert_owner_only};
use crate::test_support::fake_bin::write_fake_bin;

const WAIT: Duration = Duration::from_secs(10);

fn windows() -> bool {
    Platform::current() == Platform::Windows
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The fake, run by node (a real .exe on Windows, where claude must be native, U-110).
fn fake_claude() -> String {
    repo_root()
        .join("e2e/fixtures/fake-claude.mjs")
        .to_string_lossy()
        .into_owned()
}

fn node() -> String {
    static NODE: OnceLock<String> = OnceLock::new();
    NODE.get_or_init(|| {
        let out = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("node on PATH");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    })
    .clone()
}

/// The fake reads its script from these state-env keys; production drops them.
fn fake_env() -> StateEnvFilter {
    Arc::new(|k: &str| k.starts_with("FAKE_CLAUDE_"))
}

fn tools() -> ToolPolicy {
    ToolPolicy {
        builtin: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]
            .map(String::from)
            .to_vec(),
        allow: ["Read(./**)", "Edit(./**)", "Bash(git commit -m:*)"]
            .map(String::from)
            .to_vec(),
        deny: ["Bash(git push:*)", "WebFetch"].map(String::from).to_vec(),
    }
}

fn mcp(v: Value) -> Option<StartSessionPayloadMcp> {
    Some(serde_json::from_value(v).unwrap())
}

fn transition(name: &str, when: &str, question: bool) -> AgentTransitionOption {
    serde_json::from_value(json!({"name": name, "when": when, "question": question})).unwrap()
}

fn opts_in(dir: &Path, scenario: Value) -> DriverStartOptions {
    let mut o = DriverStartOptions::new(
        dir,
        "do the thing",
        tools(),
        uuid::Uuid::new_v4().to_string(),
        false,
    );
    o.env = BTreeMap::from([
        ("FAKE_CLAUDE_SCENARIO".into(), scenario.to_string()),
        (
            "FAKE_CLAUDE_STATE_DIR".into(),
            dir.join("state").to_string_lossy().into_owned(),
        ),
        (
            "FAKE_CLAUDE_ARGV_LOG".into(),
            dir.join("argv.ndjson").to_string_lossy().into_owned(),
        ),
        ("FAKE_CLAUDE_VERSION".into(), "9.9.9-fake".into()),
        ("PORT".into(), "41000".into()),
    ]);
    o
}

fn flag_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1).map(String::as_str)
}

fn count(args: &[String], flag: &str) -> usize {
    args.iter().filter(|a| *a == flag).count()
}

/// A test's server, temp dir and sessions; the sessions are killed when it drops.
struct Ctx {
    server: Arc<OutcomeServer>,
    dir: tempfile::TempDir,
    live: Mutex<Vec<Arc<CliDriverSession>>>,
}

impl Drop for Ctx {
    fn drop(&mut self) {
        for s in self.live.lock().unwrap().drain(..) {
            s.kill(Some(Duration::ZERO));
        }
    }
}

impl Ctx {
    async fn new() -> Ctx {
        Ctx::with_server(OutcomeServerOptions::default()).await
    }

    async fn with_server(opts: OutcomeServerOptions) -> Ctx {
        Ctx {
            server: Arc::new(start_outcome_server(opts).await.unwrap()),
            dir: tempfile::Builder::new()
                .prefix("cli-driver-test-")
                .tempdir()
                .unwrap(),
            live: Mutex::new(Vec::new()),
        }
    }

    fn dir(&self) -> &Path {
        self.dir.path()
    }

    fn opts(&self, scenario: Value) -> DriverStartOptions {
        opts_in(self.dir(), scenario)
    }

    /// The fake behind node, the FAKE_CLAUDE_* keys passed through, end grace 5 s.
    fn options(&self) -> CliDriverOptions {
        CliDriverOptions {
            claude_bin: Some(node()),
            claude_prefix_args: vec![fake_claude()],
            end_grace: Some(Duration::from_millis(5_000)),
            extra_state_env: Some(fake_env()),
            ..CliDriverOptions::new(self.server.clone())
        }
    }

    fn start_with(&self, d: &CliDriver, o: DriverStartOptions) -> (Arc<CliDriverSession>, Track) {
        let s = d.start_cli(o).unwrap();
        let t = Track::new(&s);
        self.live.lock().unwrap().push(s.clone());
        (s, t)
    }

    fn start(&self, o: DriverStartOptions) -> (Arc<CliDriverSession>, Track) {
        self.start_with(&create_cli_driver(self.options()), o)
    }

    fn argv_log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir().join("argv.ndjson"))
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

fn argv_of(entry: &Value) -> Vec<String> {
    serde_json::from_value(entry["argv"].clone()).unwrap()
}

/// Records a session's events.
struct Track {
    events: Arc<Mutex<Vec<DriverEvent>>>,
}

impl Track {
    fn new(s: &CliDriverSession) -> Track {
        let events: Arc<Mutex<Vec<DriverEvent>>> = Arc::default();
        let e = events.clone();
        s.on(Arc::new(move |ev: &DriverEvent| {
            e.lock().unwrap().push(ev.clone())
        }));
        Track { events }
    }

    fn events(&self) -> Vec<DriverEvent> {
        self.events.lock().unwrap().clone()
    }

    async fn wait_until(&self, what: &str, pred: impl Fn(&[DriverEvent]) -> bool) {
        let start = Instant::now();
        loop {
            if pred(&self.events.lock().unwrap()) {
                return;
            }
            if start.elapsed() > WAIT {
                panic!(
                    "timeout waiting for {what}; events so far: {:?}",
                    self.events()
                );
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn wait_for(&self, pred: impl Fn(&DriverEvent) -> bool) -> DriverEvent {
        self.wait_until("an event", |evs| evs.iter().any(&pred))
            .await;
        self.events().into_iter().find(|e| pred(e)).unwrap()
    }

    async fn output(&self, text: &str) {
        self.wait_for(|e| matches!(e, DriverEvent::Output { text: t, .. } if t == text))
            .await;
    }

    async fn turn_ends(&self, n: usize) {
        self.wait_until("turn_end", |evs| {
            evs.iter()
                .filter(|e| matches!(e, DriverEvent::TurnEnd { .. }))
                .count()
                >= n
        })
        .await;
    }

    /// `(code, signal)` of the exit event.
    async fn exit(&self) -> (Option<i32>, Option<String>) {
        match self
            .wait_for(|e| matches!(e, DriverEvent::Exit { .. }))
            .await
        {
            DriverEvent::Exit { code, signal } => (code, signal),
            _ => unreachable!(),
        }
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.events()
            .iter()
            .filter(|e| !matches!(e, DriverEvent::Output { .. }))
            .map(DriverEvent::kind)
            .collect()
    }

    fn has(&self, ev: &DriverEvent) -> bool {
        self.events().contains(ev)
    }

    fn has_output(&self, stream: OutputStream, pred: impl Fn(&str) -> bool) -> bool {
        self.events().iter().any(
            |e| matches!(e, DriverEvent::Output { stream: s, text } if *s == stream && pred(text)),
        )
    }

    fn complete_states(&self) -> Vec<DriverEvent> {
        self.events()
            .into_iter()
            .filter(|e| matches!(e, DriverEvent::CompleteState { .. }))
            .collect()
    }
}

fn out(stream: OutputStream, text: &str) -> DriverEvent {
    DriverEvent::Output {
        stream,
        text: text.into(),
    }
}

fn complete(result: Value) -> DriverEvent {
    DriverEvent::CompleteState {
        result: result.as_object().unwrap().clone(),
        transition: None,
        reason: None,
    }
}

fn mode(file: &Path) -> u32 {
    crate::platform::fs::posix_mode(file).expect("a POSIX mode")
}

// ---- buildClaudeArgs ----

fn base_opts() -> DriverStartOptions {
    opts_in(Path::new("/w"), json!([]))
}

/// R4: `--allowedTools` gets run_gate only with a handler and a transition that runs checks, and
/// never for a reviewer: exactly when the outcome server lists it.
#[test]
fn allows_run_gate_only_with_a_handler_and_a_checked_transition() {
    use crate::claude::driver::RunGateHook;
    let allowed = |o: &DriverStartOptions| {
        let args = build_claude_args(o, "{}", "/tmp/s/settings.json", &PermissionArgs::Host);
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        args[i + 1].clone()
    };
    let option = |name: &str, checks: bool| -> AgentTransitionOption {
        let mut v = json!({"name": name, "when": null, "question": false});
        if checks {
            v["checks"] = json!(true);
        }
        serde_json::from_value(v).unwrap()
    };
    let hook = RunGateHook(std::sync::Arc::new(|_| {
        Box::pin(async { Ok(String::new()) })
    }));
    let mut o = base_opts();
    o.transitions = Some(vec![option("ship", true)]);
    assert!(!allowed(&o).contains(RUN_GATE_TOOL));
    o.run_gate = Some(hook);
    assert!(allowed(&o).contains(RUN_GATE_TOOL));
    o.review = true;
    assert!(!allowed(&o).contains(RUN_GATE_TOOL));
    o.review = false;
    o.transitions = Some(vec![option("done", false)]);
    assert!(!allowed(&o).contains(RUN_GATE_TOOL));
}

/// ADR-0038: `--allowedTools` gets publish_page only for a state with the `pages` tool, and only
/// with an attach target (the orchestrator to post to); a reviewer gets neither.
#[test]
fn allows_publish_page_only_with_pages_and_a_target() {
    let allowed = |o: &DriverStartOptions| {
        let args = build_claude_args(o, "{}", "/tmp/s/settings.json", &PermissionArgs::Host);
        let i = args.iter().position(|a| a == "--allowedTools").unwrap();
        args[i + 1].clone()
    };
    let target = crate::attachments::upload::AttachTarget {
        base: reqwest::Url::parse("http://127.0.0.1:7400/").unwrap(),
        credential: None,
        session_id: "s".into(),
        roots: vec![],
    };
    let mut o = base_opts();
    o.publish_pages = true;
    assert!(!allowed(&o).contains(PUBLISH_PAGE_TOOL));
    o.attach = Some(target);
    assert!(allowed(&o).contains(PUBLISH_PAGE_TOOL));
    o.review = true;
    assert!(!allowed(&o).contains(PUBLISH_PAGE_TOOL));
    o.review = false;
    o.publish_pages = false;
    assert!(!allowed(&o).contains(PUBLISH_PAGE_TOOL));
}

#[test]
fn emits_exactly_the_adr_0005_0006_flags_for_a_new_session() {
    let mut o = base_opts();
    o.claude_session_id = "sid-1".into();
    o.model = Some("sonnet".into());
    o.max_turns = Some(40);
    o.max_budget_usd = Some(2.5);
    o.append_system_prompt = Some("use complete_state".into());
    let args = build_claude_args(
        &o,
        "{\"mcp\":1}",
        "/tmp/s/settings.json",
        &PermissionArgs::Host,
    );
    let allowed = format!(
        "Read(./**),Edit(./**),Bash(git commit -m:*),{COMPLETE_STATE_TOOL},{ASK_USER_TOOL}"
    );
    assert_eq!(
        args,
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--session-id",
            "sid-1",
            "--model",
            "sonnet",
            "--max-turns",
            "40",
            "--max-budget-usd",
            "2.5",
            "--setting-sources",
            "user",
            "--settings",
            "/tmp/s/settings.json",
            "--strict-mcp-config",
            "--permission-mode",
            "auto",
            "--permission-prompts",
            "host",
            "--permission-prompt-tool",
            PERMISSION_TOOL,
            "--mcp-config",
            "{\"mcp\":1}",
            "--tools",
            "Read,Edit,Write,Glob,Grep,Bash",
            "--allowedTools",
            &allowed,
            "--disallowedTools",
            "Bash(git push:*),WebFetch",
            "--append-system-prompt",
            "use complete_state",
        ]
    );
}

#[test]
fn a_reviewer_runs_in_dont_ask_and_never_prompts_a_worker_runs_in_auto() {
    let mut reviewer = base_opts();
    reviewer.review = true;
    for perm in [
        PermissionArgs::Host,
        PermissionArgs::None {
            legacy_mode: Some("auto".into()),
        },
    ] {
        let args = build_claude_args(&reviewer, "{}", "s.json", &perm);
        assert_eq!(
            flag_of(&args, "--permission-mode"),
            Some("dontAsk"),
            "{perm:?}"
        );
        assert_eq!(count(&args, "--permission-mode"), 1);
        assert_eq!(flag_of(&args, "--permission-prompts"), Some("none"));
        assert!(!args.contains(&"--permission-prompt-tool".to_string()));
        // The other ADR-0006 guards stay.
        assert_eq!(flag_of(&args, "--setting-sources"), Some("user"));
        assert_eq!(flag_of(&args, "--settings"), Some("s.json"));
    }
    let args = build_claude_args(&base_opts(), "{}", "s.json", &PermissionArgs::default());
    assert_eq!(flag_of(&args, "--permission-mode"), Some("auto"));
    assert_eq!(count(&args, "--permission-mode"), 1);
    assert_eq!(flag_of(&args, "--permission-prompts"), Some("host"));
    assert_eq!(
        flag_of(&args, "--permission-prompt-tool"),
        Some("mcp__conductor__permission")
    );
    // The prompt tool is Claude's, not the model's: never pre-approved.
    assert!(
        !flag_of(&args, "--allowedTools")
            .unwrap()
            .contains(PERMISSION_TOOL)
    );
}

#[test]
fn inherit_drops_strict_mcp_config_and_denies_the_listed_servers() {
    let mut inherit = base_opts();
    inherit.mcp = mcp(json!({"mode": "inherit"}));
    let args = build_claude_args(&inherit, "{}", "s.json", &PermissionArgs::Host);
    assert!(!args.contains(&"--strict-mcp-config".to_string()));
    assert_eq!(flag_of(&args, "--mcp-config"), Some("{}")); // conductor's server still added
    assert_eq!(
        flag_of(&args, "--disallowedTools"),
        Some("Bash(git push:*),WebFetch")
    );

    let mut denied = base_opts();
    denied.mcp = mcp(json!({
        "mode": "inherit",
        "deny": ["claude.ai Gmail", "plugin:azure:azure", "claude.ai Gmail"],
    }));
    let args = build_claude_args(&denied, "{}", "s.json", &PermissionArgs::Host);
    assert!(!args.contains(&"--strict-mcp-config".to_string()));
    assert_eq!(
        flag_of(&args, "--disallowedTools"),
        Some("Bash(git push:*),WebFetch,mcp__claude_ai_Gmail,mcp__plugin_azure_azure")
    );

    let mut none = base_opts();
    none.mcp = mcp(json!({"mode": "none", "deny": ["claude.ai Gmail"]}));
    let mut reviewer = base_opts();
    reviewer.review = true;
    reviewer.mcp = mcp(json!({"mode": "inherit"}));
    for o in [base_opts(), none, reviewer] {
        let args = build_claude_args(&o, "{}", "s.json", &PermissionArgs::Host);
        assert!(
            args.contains(&"--strict-mcp-config".to_string()),
            "{:?}",
            o.mcp
        );
        assert!(
            !flag_of(&args, "--disallowedTools")
                .unwrap()
                .contains("mcp__")
        );
    }
}

#[test]
fn agent_mcp_and_agent_env_leave_connectors_on_only_when_not_strict() {
    let strict = AgentMcp {
        strict: true,
        deny: vec![],
    };
    assert_eq!(agent_mcp(None, false), strict);
    assert_eq!(
        agent_mcp(mcp(json!({"mode": "inherit"})).as_ref(), false),
        AgentMcp {
            strict: false,
            deny: vec![]
        }
    );
    assert_eq!(
        agent_mcp(
            mcp(json!({"mode": "inherit", "deny": ["chrome-devtools"]})).as_ref(),
            false
        ),
        AgentMcp {
            strict: false,
            deny: vec!["mcp__chrome-devtools".into()]
        }
    );
    assert!(agent_mcp(mcp(json!({"mode": "inherit"})).as_ref(), true).strict);
    let get = |env: &Env, k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let base: Env = vec![("PATH".into(), "/bin".into())];
    let (env, _) = agent_env_over(base.clone(), &BTreeMap::new(), None, true);
    assert_eq!(
        get(&env, "ENABLE_CLAUDEAI_MCP_SERVERS").as_deref(),
        Some("false")
    );
    // A state env still can't set it: the key isn't allowlisted.
    let state = BTreeMap::from([("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "false".into())]);
    let (env, dropped) = agent_env_over(base, &state, None, false);
    assert_eq!(get(&env, "ENABLE_CLAUDEAI_MCP_SERVERS"), None);
    assert_eq!(dropped, ["ENABLE_CLAUDEAI_MCP_SERVERS"]);
    assert_eq!(get(&env, "CLAUDE_CODE_SAFE_MODE").as_deref(), Some("0"));
}

#[test]
fn mcp_server_rule_gives_claude_code_tool_prefixes() {
    // `mcpServerRule` (shared/workflow/mcp.test.ts) plus the UTF-16 unit rule of the JS regex.
    assert_eq!(
        mcp_server_rule("claude.ai Atlassian"),
        "mcp__claude_ai_Atlassian"
    );
    assert_eq!(
        mcp_server_rule("plugin:azure:azure"),
        "mcp__plugin_azure_azure"
    );
    assert_eq!(mcp_server_rule("chrome-devtools"), "mcp__chrome-devtools");
    assert_eq!(mcp_server_rule(" vibe_kanban "), "mcp__vibe_kanban");
    assert_eq!(mcp_server_rule("na\u{ef}ve \u{1F600}"), "mcp__na_ve___");
}

#[test]
fn old_cli_fallback_uses_the_pre_adr_0023_flags() {
    let plain = build_claude_args(
        &base_opts(),
        "{}",
        "s.json",
        &PermissionArgs::None { legacy_mode: None },
    );
    assert_eq!(flag_of(&plain, "--permission-mode"), None);
    assert_eq!(flag_of(&plain, "--permission-prompts"), Some("none"));
    assert!(!plain.contains(&"--permission-prompt-tool".to_string()));
    let capped = build_claude_args(
        &base_opts(),
        "{}",
        "s.json",
        &PermissionArgs::None {
            legacy_mode: Some("auto".into()),
        },
    );
    assert_eq!(flag_of(&capped, "--permission-mode"), Some("auto"));
    assert_eq!(flag_of(&capped, "--permission-prompts"), Some("none"));
}

#[test]
fn skip_permissions_runs_a_worker_in_bypass_but_never_a_reviewer() {
    // ADR-0039 (Rust only: the TS daemon is frozen).
    let mut o = base_opts();
    o.skip_permissions = true;
    o.tools = resolve_tool_policy(&["read", "edit", "bash", "git"]).unwrap();
    for perm in [
        PermissionArgs::Host,
        PermissionArgs::None { legacy_mode: None },
        PermissionArgs::None {
            legacy_mode: Some("auto".into()),
        },
    ] {
        let args = build_claude_args(&o, "{}", "s.json", &perm);
        assert_eq!(
            flag_of(&args, "--permission-mode"),
            Some("bypassPermissions"),
            "{perm:?}"
        );
        assert_eq!(count(&args, "--permission-mode"), 1);
        assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
        // The deny rules still go to Claude (they apply in bypass mode too).
        assert!(
            flag_of(&args, "--disallowedTools")
                .unwrap_or("")
                .split(',')
                .any(|r| r == "Bash(git push:*)"),
            "{perm:?}"
        );
    }
    let host = build_claude_args(&o, "{}", "s.json", &PermissionArgs::Host);
    assert_eq!(flag_of(&host, "--permission-prompts"), Some("host"));
    let mut reviewer = o.clone();
    reviewer.review = true;
    let args = build_claude_args(&reviewer, "{}", "s.json", &PermissionArgs::Host);
    assert_eq!(flag_of(&args, "--permission-mode"), Some("dontAsk"));
    assert_eq!(flag_of(&args, "--permission-prompts"), Some("none"));
    // Off: auto, as before.
    o.skip_permissions = false;
    let args = build_claude_args(&o, "{}", "s.json", &PermissionArgs::Host);
    assert_eq!(flag_of(&args, "--permission-mode"), Some("auto"));
}

#[test]
fn git_push_stays_a_deny_rule_beside_the_prompt_tool() {
    // The real workflow aliases, as start_session sends them.
    let mut o = base_opts();
    o.tools = resolve_tool_policy(&["read", "edit", "bash", "git"]).unwrap();
    let args = build_claude_args(&o, "{}", "s.json", &PermissionArgs::Host);
    let deny: Vec<&str> = flag_of(&args, "--disallowedTools")
        .unwrap_or("")
        .split(',')
        .collect();
    assert!(deny.contains(&"Bash(git push:*)"));
    assert_eq!(
        flag_of(&args, "--permission-prompt-tool"),
        Some(PERMISSION_TOOL)
    );
    assert!(
        !flag_of(&args, "--allowedTools")
            .unwrap()
            .contains("git push")
    );
}

const REAL_HELP: &str = "  --permission-mode <mode>              Permission mode to use for the session\n\
                         \x20                                       (choices: \"acceptEdits\", \"auto\",\n\
                         \x20                                       \"bypassPermissions\", \"manual\",\n\
                         \x20                                       \"dontAsk\", \"plan\")\n\
                         \x20 --permission-prompts <target>         Who answers permission prompts with";

#[tokio::test(flavor = "multi_thread")]
async fn detects_auto_mode_and_permission_prompts_in_claude_help() {
    assert_eq!(
        permission_prompt_support(REAL_HELP),
        PermissionPromptSupport {
            supported: true,
            reason: None
        }
    );
    let no_prompts: String = REAL_HELP.lines().take(4).collect::<Vec<_>>().join("\n");
    let r = permission_prompt_support(&no_prompts);
    assert!(!r.supported);
    assert!(r.reason.unwrap().contains("--permission-prompts"));
    let no_auto = REAL_HELP.replace("\"auto\",", "");
    let r = permission_prompt_support(&no_auto);
    assert!(!r.supported);
    assert!(r.reason.unwrap().contains("--permission-mode auto"));
    // `\b`: a longer word doesn't count (a `-` after it does, as in the JS regex).
    assert!(
        !permission_prompt_support("--permission-promptsx --permission-mode \"auto\"").supported
    );
    assert!(
        permission_prompt_support("--permission-prompts-x --permission-mode \"auto\"").supported
    );

    assert_eq!(
        probe_permission_prompts(&node(), &[fake_claude()]).await,
        PermissionPromptSupport {
            supported: true,
            reason: None
        }
    );
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such-claude");
    assert!(
        !probe_permission_prompts(&missing.to_string_lossy(), &[])
            .await
            .supported
    );
}

#[test]
fn uses_resume_for_resume_and_omits_unset_optionals_and_an_empty_deny_list() {
    let mut o = base_opts();
    o.claude_session_id = "sid-2".into();
    o.resume = true;
    o.tools = ToolPolicy {
        builtin: vec![],
        allow: vec![],
        deny: vec![],
    };
    let args = build_claude_args(&o, "{}", "s.json", &PermissionArgs::Host);
    // ADR-0023: auto whatever the user's own mode.
    assert_eq!(flag_of(&args, "--permission-mode"), Some("auto"));
    assert_eq!(args[6..8], ["--resume", "sid-2"]);
    assert!(!args.contains(&"--session-id".to_string()));
    for f in [
        "--model",
        "--max-turns",
        "--max-budget-usd",
        "--disallowedTools",
        "--append-system-prompt",
    ] {
        assert!(!args.contains(&f.to_string()), "{f}");
    }
    let i = args.iter().position(|a| a == "--tools").unwrap();
    let allowed = format!("{COMPLETE_STATE_TOOL},{ASK_USER_TOOL}");
    assert_eq!(args[i..i + 4], ["--tools", "", "--allowedTools", &allowed]);
}

#[test]
fn passes_a_spilled_system_prompt_as_append_system_prompt_file_never_the_text() {
    let mut o = base_opts();
    o.append_system_prompt = Some("x".into());
    o.append_system_prompt_file = Some(PathBuf::from("/tmp/s/system-prompt.md"));
    let args = build_claude_args(
        &o,
        "{\"mcp\":1}",
        "/tmp/s/settings.json",
        &PermissionArgs::Host,
    );
    assert_eq!(
        args[args.len() - 2..],
        ["--append-system-prompt-file", "/tmp/s/system-prompt.md"]
    );
    assert!(!args.iter().any(|a| a == "--append-system-prompt"));
}

#[test]
fn spill_keeps_a_short_prompt_on_the_command_line_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = base_opts();
    o.append_system_prompt = Some("a".repeat(MAX_ARGV_SYSTEM_PROMPT_CHARS));
    let out = spill_system_prompt(o.clone(), dir.path()).unwrap();
    assert_eq!(out.append_system_prompt, o.append_system_prompt);
    assert_eq!(out.append_system_prompt_file, None);
    assert!(!dir.path().join("system-prompt.md").exists());
}

#[test]
fn spill_moves_a_long_prompt_into_a_private_file_so_windows_argv_stays_short() {
    // Production spills into the session's private dir (write_mcp_config_file makes it with
    // mkdir_private); write_private_file refuses a plain temp dir on Windows (inherited ACL).
    let dir = tempfile::tempdir().unwrap();
    mkdir_private(dir.path()).unwrap();
    let text = format!("# CLAUDE.md\n{}", "b".repeat(40 * 1024));
    let mut o = base_opts();
    o.append_system_prompt = Some(text.clone());
    let out = spill_system_prompt(o, dir.path()).unwrap();
    let path = dir.path().join("system-prompt.md");
    assert_eq!(out.append_system_prompt, None);
    assert_eq!(
        out.append_system_prompt_file.as_deref(),
        Some(path.as_path())
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    if windows() {
        assert_owner_only(&path, AssertOwnerOnlyOptions::new(AclKind::File)).unwrap();
    } else {
        assert_eq!(mode(&path) & 0o777, 0o600);
    }
    let args = build_claude_args(
        &out,
        "/tmp/s/mcp.json",
        "/tmp/s/settings.json",
        &PermissionArgs::Host,
    );
    assert!(args.join(" ").len() < MAX_ARGV_SYSTEM_PROMPT_CHARS);
}

#[test]
fn writes_stream_json_user_messages() {
    let line = user_message_line("hi");
    assert!(line.ends_with('\n'));
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap(),
        json!({
            "type": "user",
            "session_id": "",
            "parent_tool_use_id": null,
            "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]},
        })
    );
}

/// FR-2: the argv and the stdin lines match what the TS functions produce for the same inputs,
/// byte for byte. The fixture was written by running the TS `buildClaudeArgs` / `userMessageLine`
/// (a throwaway vitest file in `packages/daemon/src/claude`, `pnpm vitest run --project daemon
/// <file>`); regenerate it the same way if the TS reference changes.
#[test]
fn argv_and_user_lines_match_the_recorded_ts_output() {
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts/cli-argv.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let cases = fixture["argv"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let ts = &c["opts"];
        let mut o = DriverStartOptions::new(
            ts["cwd"].as_str().unwrap(),
            ts["prompt"].as_str().unwrap(),
            serde_json::from_value(ts["tools"].clone()).unwrap(),
            ts["claudeSessionId"].as_str().unwrap(),
            ts["resume"].as_bool().unwrap(),
        );
        o.model = ts["model"].as_str().map(String::from);
        o.max_turns = ts["maxTurns"].as_u64().map(|n| n as u32);
        o.max_budget_usd = ts["maxBudgetUsd"].as_f64();
        o.append_system_prompt = ts["appendSystemPrompt"].as_str().map(String::from);
        o.review = ts["review"].as_bool().unwrap_or(false);
        o.mcp = ts
            .get("mcp")
            .map(|m| serde_json::from_value(m.clone()).unwrap());
        let permission = match c.get("permission") {
            None => PermissionArgs::Host,
            Some(p) if p["prompts"] == "host" => PermissionArgs::Host,
            Some(p) => PermissionArgs::None {
                legacy_mode: p["legacyMode"].as_str().map(String::from),
            },
        };
        let want: Vec<String> = serde_json::from_value(c["argv"].clone()).unwrap();
        assert_eq!(
            build_claude_args(&o, "<MCP>", "<SETTINGS>", &permission),
            want,
            "{}",
            c["name"]
        );
    }
    for c in fixture["user_message_lines"].as_array().unwrap() {
        assert_eq!(
            user_message_line(c["text"].as_str().unwrap()),
            c["line"].as_str().unwrap()
        );
    }
}

#[test]
fn js_number_prints_as_js_string() {
    assert_eq!(js_number(2.5), "2.5");
    assert_eq!(js_number(1.0), "1");
    assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
    assert_eq!(js_number(1e21), "1e+21");
}

#[test]
fn state_env_allowed_matches_the_ts_regex() {
    for k in [
        "CONDUCTOR_SESSION_ID",
        "CONDUCTOR_X1_",
        "PORT",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
    ] {
        assert!(state_env_allowed(k), "{k}");
    }
    for k in [
        "CONDUCTOR_",
        "CONDUCTOR_lower",
        "conductor_X",
        "PORTS",
        "GIT_DIR",
        "GIT_AUTHOR_DATE",
        "HOME",
    ] {
        assert!(!state_env_allowed(k), "{k}");
    }
}

#[test]
fn take_utf8_keeps_a_split_character_for_the_next_read() {
    let bytes = "é😀".as_bytes();
    let mut carry = bytes[..3].to_vec(); // é + the first byte of 😀
    assert_eq!(take_utf8(&mut carry, false), "é");
    assert_eq!(carry, &bytes[2..3]);
    carry.extend_from_slice(&bytes[3..]);
    assert_eq!(take_utf8(&mut carry, false), "😀");
    assert!(carry.is_empty());
    let mut bad = vec![b'a', 0xff, b'b', 0xf0];
    assert_eq!(take_utf8(&mut bad, true), "a\u{FFFD}b\u{FFFD}");
}

#[test]
fn start_notes_say_the_mode_the_mcp_policy_and_dropped_keys() {
    let strict = agent_mcp(None, false);
    assert_eq!(
        start_notes(false, true, None, &strict, &[]),
        [
            "running in auto mode; permission prompts go to the conductor board",
            "MCP: only conductor's server"
        ]
    );
    assert_eq!(
        start_notes(true, true, None, &strict, &[])[0],
        "requirements reviewer: running in dontAsk mode"
    );
    let loose = agent_mcp(
        mcp(json!({"mode": "inherit", "deny": ["a b"]})).as_ref(),
        false,
    );
    let notes = start_notes(false, false, Some("auto"), &loose, &["HOME".into()]);
    assert!(notes[0].contains("old flags"));
    assert_eq!(
        notes[1..],
        [
            "user defaultMode is bypassPermissions; running this agent in auto mode",
            "MCP: the user's servers and claude.ai connectors, except mcp__a_b",
            "dropped state env keys not allowed: HOME"
        ]
    );
}

// ---- createCliDriver against fake-claude ----

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_transition_is_nudged_once_then_the_named_one_is_forwarded() {
    let ctx = Ctx::new().await;
    let mut o = ctx.opts(json!([[
        {"complete_state": {"x": 1}, "transition": "ship_it"},
        {"complete_state": {"x": 2}, "transition": "plan_ready", "reason": "Plan done: $answer"},
    ]]));
    o.prompt = "go".into();
    o.transitions = Some(vec![
        transition("plan_ready", "The plan is complete.", false),
        transition("scope_changed", "The scope changed.", true),
    ]);
    let (_s, t) = ctx.start(o);
    t.turn_ends(1).await;
    assert_eq!(
        t.complete_states(),
        [DriverEvent::CompleteState {
            result: json!({"x": 2}).as_object().unwrap().clone(),
            transition: Some("plan_ready".into()),
            reason: Some("Plan done: go".into()),
        }]
    );
    assert!(t.has_output(OutputStream::ToolResult, |s| {
        s.contains("\"ship_it\" is not a transition you can take here")
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn ask_user_park_send_input_complete_state_end_exit_0() {
    let ctx = Ctx::new().await;
    let o = ctx.opts(json!([
        [{"say": "Need a decision."}, {"ask_user": "Which colour?"}],
        [{"complete_state": {"colour": "$answer"}}],
    ]));
    let (s, t) = ctx.start(o.clone());

    t.turn_ends(1).await;
    assert_eq!(s.claude_session_id(), o.claude_session_id);
    assert_eq!(s.cli_version().as_deref(), Some("9.9.9-fake")); // U-015
    assert_eq!(
        t.kinds(),
        ["claude_session_id", "ask_user", "spend", "turn_end"]
    );
    assert!(t.has(&DriverEvent::ClaudeSessionId {
        id: o.claude_session_id.clone()
    }));
    assert!(t.has(&DriverEvent::AskUser {
        question: "Which colour?".into(),
        options: None,
        proposed_checks: None,
    }));
    assert!(t.has(&out(OutputStream::Assistant, "Need a decision.")));
    assert!(t.has(&out(OutputStream::Debug, "claude_code_version 9.9.9-fake")));
    assert!(t.has_output(OutputStream::ToolUse, |s| s.starts_with(ASK_USER_TOOL)));
    assert!(t.has_output(OutputStream::ToolResult, |s| s.contains("sent to a human")));

    // parked: alive and idle; the answer goes into the live process
    s.send_input("green").unwrap();
    t.turn_ends(2).await;
    assert_eq!(
        t.kinds(),
        [
            "claude_session_id",
            "ask_user",
            "spend",
            "turn_end",
            "complete_state",
            "spend",
            "turn_end"
        ]
    );
    assert!(t.has(&complete(json!({"colour": "green"}))));
    let spends: Vec<(f64, Usage)> = t
        .events()
        .into_iter()
        .filter_map(|e| match e {
            DriverEvent::Spend { total_usd, usage } => Some((total_usd, usage)),
            _ => None,
        })
        .collect();
    assert_eq!(
        spends.iter().map(|s| s.0).collect::<Vec<_>>(),
        [0.001, 0.002]
    ); // cumulative
    assert_eq!(
        spends[0].1,
        Usage {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 2,
            cache_creation_tokens: 1
        }
    );

    s.end();
    assert_eq!(t.exit().await, (Some(0), None));
    assert_eq!(ctx.server.size(), 0); // token dropped on exit
    assert_eq!(s.send_input("late"), Err(DriverError::Exited));

    // the spawn itself: exact flags, cwd, env merged over the daemon env
    let first = &ctx.argv_log()[0];
    let argv = argv_of(first);
    let after = |f: &str| flag_of(&argv, f).unwrap().to_string();
    assert_eq!(
        argv,
        build_claude_args(
            &o,
            &after("--mcp-config"),
            &after("--settings"),
            &PermissionArgs::Host
        )
    );
    assert!(crate::platform::fs::same_path(
        first["cwd"].as_str().unwrap(),
        ctx.dir().canonicalize().unwrap()
    ));
    assert_eq!(first["env"]["PORT"], "41000");
    assert_eq!(first["env"]["ENABLE_CLAUDEAI_MCP_SERVERS"], "false"); // ADR-0006
}

#[tokio::test(flavor = "multi_thread")]
async fn send_message_is_folded_into_the_running_turn() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[
        {"say": "working"},
        {"await_message": true},
        {"say": "got $message"},
        {"complete_state": {"message": "$message"}},
    ]])));
    t.output("working").await;
    s.send_message("/context").unwrap();
    t.turn_ends(1).await;
    assert!(t.has(&out(OutputStream::Assistant, "got /context")));
    assert!(t.has(&complete(json!({"message": "/context"}))));
    assert_eq!(t.kinds().iter().filter(|k| **k == "turn_end").count(), 1);
    s.end();
    t.exit().await;
    assert_eq!(s.send_message("late"), Err(DriverError::Exited));
}

#[tokio::test(flavor = "multi_thread")]
async fn send_message_is_not_an_answer_a_pending_question_stays_pending() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([
        [{"ask_user": "Which colour?"}],
        [{"complete_state": {"colour": "x"}}],
    ])));
    t.turn_ends(1).await;
    s.send_message("what are you doing?").unwrap();
    t.turn_ends(2).await;
    // The outcome server refused the complete_state (question still pending), so none surfaced.
    assert!(t.complete_states().is_empty());
    s.end();
    t.exit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_is_the_edit_guard_hook_beside_mcp_json_removed_on_exit() {
    let ctx = Ctx::new().await;
    let mut o = ctx.opts(json!([[{"say": "up"}, {"hang": true}]]));
    // a state env can't turn the claude.ai connectors back on
    o.env
        .insert("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "true".into());
    let (s, t) = ctx.start(o);
    t.output("up").await;

    let spawned = &ctx.argv_log()[0];
    assert_eq!(spawned["env"]["ENABLE_CLAUDEAI_MCP_SERVERS"], "false");
    let argv = argv_of(spawned);
    let settings = PathBuf::from(flag_of(&argv, "--settings").unwrap());
    let mcp_cfg = PathBuf::from(flag_of(&argv, "--mcp-config").unwrap());
    assert_eq!(settings.parent(), mcp_cfg.parent());
    if windows() {
        assert_owner_only(&settings, AssertOwnerOnlyOptions::new(AclKind::File)).unwrap();
    } else {
        assert_eq!(mode(&settings) & 0o777, 0o600);
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    let entry = &v["hooks"]["PreToolUse"][0];
    assert_eq!(entry["matcher"], "Edit|Write|MultiEdit|NotebookEdit");
    let dir = ctx.dir().to_string_lossy().into_owned();
    let quoted = if windows() {
        format!("\"{}\"", dir.replace('\\', "/"))
    } else {
        format!("'{dir}'")
    };
    assert!(
        entry["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(&quoted),
        "{entry}"
    );

    s.kill(Some(Duration::from_millis(1_000)));
    t.exit().await;
    assert!(!settings.exists());
}

#[test]
fn agent_env_passes_only_allowlisted_state_keys_and_pins_connectors_and_safe_mode_off() {
    let state: BTreeMap<String, String> = [
        ("CONDUCTOR_SESSION_ID", "s1"),
        ("CONDUCTOR_PORT_BASE", "41000"),
        ("PORT", "41000"),
        ("GIT_AUTHOR_NAME", "conductor"),
        ("GIT_COMMITTER_EMAIL", "c@example.com"),
        ("CLAUDE_CONFIG_DIR", "/tmp/other-claude"),
        ("CLAUDE_CODE_SAFE_MODE", "1"),
        ("ENABLE_CLAUDEAI_MCP_SERVERS", "true"),
        ("ANTHROPIC_API_KEY", "sk-test"),
        ("HOME", "/tmp/fake-home"),
        ("XDG_CONFIG_HOME", "/tmp/xdg"),
        ("NODE_OPTIONS", "--require /tmp/evil.js"),
        ("GIT_DIR", "/tmp/other.git"),
        ("PATH", "/tmp/bin"),
        ("FAKE_CLAUDE_SCENARIO", "[]"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let base: Env = vec![
        ("HOME".into(), "/home/daemon".into()),
        ("PATH".into(), "/usr/bin".into()),
    ];
    let get = |env: &Env, k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let (env, mut dropped) = agent_env_over(base.clone(), &state, None, true);
    for k in [
        "CONDUCTOR_SESSION_ID",
        "CONDUCTOR_PORT_BASE",
        "PORT",
        "GIT_AUTHOR_NAME",
        "GIT_COMMITTER_EMAIL",
    ] {
        assert_eq!(get(&env, k).as_ref(), state.get(k), "{k}");
    }
    // refused keys fall back to the daemon's own values (or stay unset)
    for k in [
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "HOME",
        "XDG_CONFIG_HOME",
        "NODE_OPTIONS",
        "GIT_DIR",
        "PATH",
        "FAKE_CLAUDE_SCENARIO",
    ] {
        assert_eq!(get(&env, k), get(&base, k), "{k}");
    }
    assert_eq!(get(&env, "CLAUDE_CODE_SAFE_MODE").as_deref(), Some("0"));
    assert_eq!(
        get(&env, "ENABLE_CLAUDEAI_MCP_SERVERS").as_deref(),
        Some("false")
    );
    // The agent's own long commands get 10 min by default, 30 at most.
    assert_eq!(
        get(&env, "BASH_DEFAULT_TIMEOUT_MS").as_deref(),
        Some("600000")
    );
    assert_eq!(get(&env, "BASH_MAX_TIMEOUT_MS").as_deref(), Some("1800000"));
    // ADR-0023: the MCP tool timeout outlasts a held prompt (30 min + 5).
    assert_eq!(get(&env, "MCP_TOOL_TIMEOUT").as_deref(), Some("2100000"));
    dropped.sort();
    assert_eq!(
        dropped,
        [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_SAFE_MODE",
            "CLAUDE_CONFIG_DIR",
            "ENABLE_CLAUDEAI_MCP_SERVERS",
            "FAKE_CLAUDE_SCENARIO",
            "GIT_DIR",
            "HOME",
            "NODE_OPTIONS",
            "PATH",
            "XDG_CONFIG_HOME",
        ]
    );
    let (env, _) = agent_env_over(base, &state, Some(&fake_env()), true);
    assert_eq!(get(&env, "FAKE_CLAUDE_SCENARIO").as_deref(), Some("[]"));
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_the_state_env_keys_it_dropped() {
    let ctx = Ctx::new().await;
    let mut o = ctx.opts(json!([[{"say": "up"}, {"hang": true}]]));
    o.env.insert("NODE_OPTIONS".into(), "--inspect".into());
    let (s, t) = ctx.start(o);
    t.output("up").await;
    assert!(t.has(&out(
        OutputStream::Debug,
        "conductor: dropped state env keys not allowed: NODE_OPTIONS"
    )));
    s.kill(Some(Duration::from_millis(1_000)));
    t.exit().await;
}

#[test]
fn caps_the_user_default_mode_bypass_permissions_to_auto() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("settings.json");
    let write = |v: Value| std::fs::write(&f, v.to_string()).unwrap();
    write(json!({"permissions": {"defaultMode": "bypassPermissions"}}));
    assert_eq!(agent_permission_mode(&f), Some("auto"));
    for m in [
        json!("auto"),
        json!("acceptEdits"),
        json!("default"),
        Value::Null,
    ] {
        write(json!({"permissions": {"defaultMode": m}}));
        assert_eq!(agent_permission_mode(&f), None, "{m}");
    }
    std::fs::write(&f, "{not json").unwrap();
    assert_eq!(agent_permission_mode(&f), None);
    assert_eq!(
        agent_permission_mode(&dir.path().join("missing.json")),
        None
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_mcp_url_token_never_appears_in_argv_it_is_in_a_private_file_removed_on_exit() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[{"say": "up"}, {"hang": true}]])));
    t.output("up").await;

    let argv = argv_of(&ctx.argv_log()[0]);
    let cfg = PathBuf::from(flag_of(&argv, "--mcp-config").unwrap());
    let cfg_dir = cfg.parent().unwrap().to_path_buf();
    assert!(cfg.is_file());
    if windows() {
        assert_owner_only(&cfg, AssertOwnerOnlyOptions::new(AclKind::File)).unwrap();
        assert_owner_only(&cfg_dir, AssertOwnerOnlyOptions::new(AclKind::Dir)).unwrap();
    } else {
        assert_eq!(mode(&cfg) & 0o777, 0o600);
        assert_eq!(mode(&cfg_dir) & 0o777, 0o700);
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
    let url = v["mcpServers"]["conductor"]["url"].as_str().unwrap();
    let token = url.rsplit('/').next().unwrap();
    assert_eq!(token.len(), 32);
    assert!(
        token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    for arg in &argv {
        assert!(!arg.contains(token));
        assert!(!arg.contains("mcpServers"));
    }

    s.kill(Some(Duration::from_millis(1_000)));
    t.exit().await;
    assert!(!cfg.exists());
    assert!(!cfg_dir.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_continues_the_script_and_the_cumulative_spend() {
    let ctx = Ctx::new().await;
    let first = ctx.opts(json!({
        "turns": [[{"ask_user": "Name?"}], [{"complete_state": {"name": "$answer"}}]],
        "costPerTurnUsd": 0.25,
    }));
    let (a, ta) = ctx.start(first.clone());
    ta.turn_ends(1).await;
    a.kill(Some(Duration::from_millis(1_000))); // gone while parked (e.g. daemon restart)
    assert_eq!(ta.exit().await.1.as_deref(), Some("SIGTERM"));

    let mut again = first.clone();
    again.resume = true;
    again.prompt = "Ada".into();
    let (b, tb) = ctx.start(again);
    tb.turn_ends(1).await;
    assert!(tb.has(&DriverEvent::ClaudeSessionId {
        id: first.claude_session_id.clone()
    }));
    assert!(tb.has(&complete(json!({"name": "Ada"}))));
    let spend = tb.events().into_iter().find_map(|e| match e {
        DriverEvent::Spend { total_usd, .. } => Some(total_usd),
        _ => None,
    });
    assert_eq!(spend, Some(0.5));
    b.end();
    assert_eq!(tb.exit().await.0, Some(0));
    assert!(argv_of(&ctx.argv_log()[1]).contains(&"--resume".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_of_an_unknown_session_exits_non_zero_like_the_real_cli() {
    let ctx = Ctx::new().await;
    let mut o = ctx.opts(json!([]));
    o.resume = true;
    let (_s, t) = ctx.start(o);
    assert_eq!(t.exit().await.0, Some(1));
    assert!(t.has_output(OutputStream::Stderr, |s| {
        s.contains("No conversation found")
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_sends_sigterm_first_then_sigkill_after_the_grace_when_ignored() {
    // Windows has no grace step: terminating the job is final at once (TD-189).
    if windows() {
        return;
    }
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[
        {"ignore_sigterm": true},
        {"say": "stubborn"},
        {"hang": true},
    ]])));
    t.output("stubborn").await;
    let t0 = Instant::now();
    s.kill(Some(Duration::from_millis(300)));
    assert_eq!(t.exit().await, (None, Some("SIGKILL".into())));
    assert!(t0.elapsed() >= Duration::from_millis(250));
    assert_eq!(ctx.server.size(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_of_a_cooperative_process_exits_on_sigterm_and_never_escalates() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[{"say": "busy"}, {"hang": true}]])));
    t.output("busy").await;
    s.kill(Some(Duration::from_millis(5_000)));
    s.kill(Some(Duration::from_millis(5_000))); // idempotent
    assert_eq!(t.exit().await, (None, Some("SIGTERM".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn end_escalates_to_kill_when_the_process_ignores_stdin_eof() {
    let ctx = Ctx::new().await;
    let d = create_cli_driver(CliDriverOptions {
        end_grace: Some(Duration::from_millis(200)),
        kill_grace: Some(Duration::from_millis(200)),
        ..ctx.options()
    });
    let (s, t) = ctx.start_with(
        &d,
        ctx.opts(json!([[{"ignore_sigterm": true}, {"say": "x"}, {"hang": true}]])),
    );
    t.output("x").await;
    s.end();
    // POSIX: SIGTERM is ignored, so the grace ends in SIGKILL. Windows: the job is terminated on
    // the first kill, reported as the SIGTERM that was sent (killed_exit).
    let want = if windows() { "SIGTERM" } else { "SIGKILL" };
    assert_eq!(t.exit().await.1.as_deref(), Some(want));
}

#[tokio::test(flavor = "multi_thread")]
async fn parses_leniently_raw_lines_and_stderr_pass_through_a_crash_still_reports_exit() {
    let ctx = Ctx::new().await;
    let (_s, t) = ctx.start(ctx.opts(json!([[
        {"raw": "garbage {"},
        {"raw": "{\"type\":\"rate_limit_event\"}"},
        {"stderr": "warn\n"},
        {"exit": 3},
    ]])));
    assert_eq!(t.exit().await, (Some(3), None));
    assert!(t.has(&out(OutputStream::Debug, "garbage {")));
    assert!(t.has(&out(OutputStream::Debug, "{\"type\":\"rate_limit_event\"}")));
    let stderr: String = t
        .events()
        .iter()
        .filter_map(|e| match e {
            DriverEvent::Output {
                stream: OutputStream::Stderr,
                text,
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .concat();
    assert!(stderr.contains("warn"));
    assert_eq!(t.kinds(), ["claude_session_id", "exit"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_error_turns_and_permission_denials_refuses_a_guarded_complete_state() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[
        {"ask_user": "Q?"},
        {"complete_state": {"early": true}},
        {"denials": 2},
        {"error": "error_max_turns"},
    ]])));
    t.turn_ends(1).await;
    let turn_end = t
        .events()
        .into_iter()
        .find(|e| matches!(e, DriverEvent::TurnEnd { .. }));
    assert_eq!(
        turn_end,
        Some(DriverEvent::TurnEnd {
            is_error: true,
            subtype: "error_max_turns".into(),
            permission_denials: 2
        })
    );
    assert!(!t.kinds().contains(&"complete_state"));
    s.end();
    t.exit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_binary_yields_stderr_output_and_an_exit_event() {
    let ctx = Ctx::new().await;
    let d = create_cli_driver(CliDriverOptions {
        claude_bin: Some(ctx.dir().join("no-such-claude").to_string_lossy().into()),
        extra_state_env: Some(fake_env()),
        ..CliDriverOptions::new(ctx.server.clone())
    });
    let (s, t) = ctx.start_with(&d, ctx.opts(json!([])));
    assert_eq!(t.exit().await, (None, None));
    assert!(t.has_output(OutputStream::Stderr, |s| s.contains("ENOENT")));
    assert_eq!(ctx.server.size(), 0);
    assert!(s.send_input("x").is_err());
    assert_eq!(s.pid(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_cmd_is_refused_with_the_install_hint_before_anything_is_registered() {
    // U-110: Windows only (POSIX runs any executable).
    if !windows() {
        return;
    }
    let ctx = Ctx::new().await;
    let shim = write_fake_bin(ctx.dir(), "claude", "", Platform::Windows).unwrap();
    let d = create_cli_driver(CliDriverOptions {
        claude_bin: Some(shim.to_string_lossy().into()),
        ..CliDriverOptions::new(ctx.server.clone())
    });
    let before = ctx.server.size();
    match d.start_cli(ctx.opts(json!([[{"say": "x"}]]))) {
        Err(DriverError::Other(msg)) => assert!(
            msg.contains("not a native .exe: conductor needs the native Claude Code (claude.exe)"),
            "{msg}"
        ),
        other => panic!("expected the U-110 refusal, got {other:?}"),
    }
    assert_eq!(ctx.server.size(), before);
}

// ADR-0023 permission prompts

fn held_scenario() -> Value {
    json!([[
        {"tool": "permission", "args": {"tool_name": "Bash", "input": {"command": "pnpm i"}, "tool_use_id": "toolu_x"}},
        {"say": "after"},
    ]])
}

/// The held prompt's request id, once it arrives.
async fn prompt(t: &Track) -> (String, String, JsonObjectOf, Option<String>) {
    match t
        .wait_for(|e| matches!(e, DriverEvent::PermissionRequest { .. }))
        .await
    {
        DriverEvent::PermissionRequest {
            request_id,
            tool,
            input,
            tool_use_id,
            ..
        } => (request_id, tool, input, tool_use_id),
        _ => unreachable!(),
    }
}

type JsonObjectOf = conductor_protocol::JsonObject;

/// The permission tool's result as Claude saw it.
async fn tool_result(t: &Track) -> Value {
    match t
        .wait_for(|e| {
            matches!(e, DriverEvent::Output { stream: OutputStream::ToolResult, text } if text.contains("behavior"))
        })
        .await
    {
        DriverEvent::Output { text, .. } => serde_json::from_str(&text).unwrap(),
        _ => unreachable!(),
    }
}

fn decision(behavior: PermissionBehavior) -> PermissionDecision {
    PermissionDecision {
        behavior,
        scope: PermissionScope::Once,
        message: None,
        rule: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_call_resolves_on_allow_claude_gets_the_input_back() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(held_scenario()));
    let (id, tool, input, tool_use_id) = prompt(&t).await;
    assert_eq!(tool, "Bash");
    assert_eq!(
        serde_json::to_value(&input).unwrap(),
        json!({"command": "pnpm i"})
    );
    assert_eq!(tool_use_id.as_deref(), Some("toolu_x"));
    // held: the turn does not go on until a decision
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!t.has_output(OutputStream::Assistant, |s| s == "after"));
    assert_eq!(
        s.resolve_permission(&id, decision(PermissionBehavior::Allow)),
        PermissionResolution::Resolved
    );
    assert_eq!(
        tool_result(&t).await,
        json!({"behavior": "allow", "updatedInput": {"command": "pnpm i"}})
    );
    t.turn_ends(1).await;
    assert_eq!(
        s.resolve_permission(&id, decision(PermissionBehavior::Allow)),
        PermissionResolution::Duplicate
    );
    s.end();
    t.exit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_call_resolves_on_deny_with_the_default_text() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(held_scenario()));
    let (id, ..) = prompt(&t).await;
    s.resolve_permission(&id, decision(PermissionBehavior::Deny));
    assert_eq!(
        tool_result(&t).await,
        json!({"behavior": "deny", "message": PERMISSION_DENIED_ON_BOARD})
    );
    s.end();
    t.exit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_call_is_denied_at_the_timeout() {
    let ctx = Ctx::with_server(OutcomeServerOptions {
        permission_timeout: Some(Duration::from_millis(200)),
        ..OutcomeServerOptions::default()
    })
    .await;
    let (s, t) = ctx.start(ctx.opts(held_scenario()));
    let (id, ..) = prompt(&t).await;
    assert_eq!(
        tool_result(&t).await,
        json!({"behavior": "deny", "message": permission_timeout_text(Duration::from_millis(200))})
    );
    assert_eq!(
        s.resolve_permission(&id, decision(PermissionBehavior::Allow)),
        PermissionResolution::Unknown
    );
    s.end();
    t.exit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_while_held_the_call_is_denied_and_the_process_exits() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(held_scenario()));
    let (id, ..) = prompt(&t).await;
    s.kill(Some(Duration::from_millis(1_000)));
    t.exit().await;
    assert_eq!(
        s.resolve_permission(&id, decision(PermissionBehavior::Allow)),
        PermissionResolution::Unknown
    );
    assert!(!s.deny_permission(&id, PERMISSION_SESSION_ENDED));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_announces_auto_mode_an_old_cli_falls_back_with_a_warning() {
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[{"say": "up"}]])));
    t.turn_ends(1).await;
    assert!(t.has(&out(
        OutputStream::Debug,
        "conductor: running in auto mode; permission prompts go to the conductor board"
    )));
    s.end();
    t.exit().await;

    let old = create_cli_driver(CliDriverOptions {
        permission_prompts: Some(false),
        ..ctx.options()
    });
    let (o, to) = ctx.start_with(&old, ctx.opts(json!([[{"say": "up"}]])));
    to.turn_ends(1).await;
    assert!(to.has_output(OutputStream::Debug, |s| s.contains("old flags")));
    o.end();
    to.exit().await;
    let argv = argv_of(&ctx.argv_log()[1]);
    assert_eq!(flag_of(&argv, "--permission-prompts"), Some("none"));
    assert!(!argv.contains(&"--permission-prompt-tool".to_string()));
    let legacy = agent_permission_mode(&user_settings_file());
    assert_eq!(
        argv.contains(&"--permission-mode".to_string()),
        legacy.is_some()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn defaults_claude_bin_to_conductor_claude_bin() {
    // The env is process-wide: the variable is read only through `default_claude_bin`, and no
    // other test sets it.
    let ctx = Ctx::new().await;
    // SAFETY: no other test in this binary reads or writes CONDUCTOR_CLAUDE_BIN.
    unsafe { std::env::set_var(CLAUDE_BIN_ENV, node()) };
    let d = create_cli_driver(CliDriverOptions {
        extra_state_env: Some(fake_env()),
        claude_prefix_args: vec![fake_claude()],
        ..CliDriverOptions::new(ctx.server.clone())
    });
    // SAFETY: as above.
    unsafe { std::env::remove_var(CLAUDE_BIN_ENV) };
    let (s, t) = ctx.start_with(&d, ctx.opts(json!([[{"say": "env bin"}]])));
    t.turn_ends(1).await;
    s.end();
    assert_eq!(t.exit().await.0, Some(0));
}

// ---- Real claude (opt-in, `E2E_REAL_CLAUDE`), as `cli-driver.real.test.ts` ----
//   E2E_REAL_CLAUDE=flags        zero cost: the CLI accepts the ADR-0005 argv
//   E2E_REAL_CLAUDE=1            spends ~$0.01 on haiku: ask_user → send_input → complete_state
//   E2E_REAL_CLAUDE=permission   spends ~$0.02 on haiku (ADR-0023)
// Run: E2E_REAL_CLAUDE=1 cargo nextest run -p conductor-daemon real_claude --run-ignored only

fn real_mode() -> Option<String> {
    std::env::var("E2E_REAL_CLAUDE").ok()
}

fn real_base(dir: &Path) -> DriverStartOptions {
    let mut o = DriverStartOptions::new(
        dir,
        "",
        ToolPolicy {
            builtin: ["Read", "Glob", "Grep"].map(String::from).to_vec(),
            allow: ["Read(./**)", "Glob(./**)", "Grep(./**)"]
                .map(String::from)
                .to_vec(),
            deny: vec!["Bash(git push:*)".into()],
        },
        uuid::Uuid::new_v4().to_string(),
        false,
    );
    o.model = Some("haiku".into());
    o.max_turns = Some(6);
    o.max_budget_usd = Some(0.2);
    o.append_system_prompt = Some("You are driven by an orchestrator.".into());
    o
}

fn noop_handlers() -> OutcomeHandlers {
    OutcomeHandlers {
        on_complete_state: Arc::new(|_, _| {}),
        on_ask_user: Arc::new(|_, _, _| {}),
        on_permission_request: None,
        on_attach_file: None,
        on_publish_page: None,
        on_run_gate: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "E2E_REAL_CLAUDE=flags|1: runs the installed claude"]
async fn real_claude_accepts_the_exact_adr_0005_argv_and_exits_0_on_stdin_eof() {
    if !matches!(real_mode().as_deref(), Some("flags" | "1")) {
        return;
    }
    let server = start_outcome_server(OutcomeServerOptions::default())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let reg = server.register(noop_handlers(), OutcomeRegisterOptions::default());
    let guard = tempfile::tempdir_in(dir.path()).unwrap();
    let settings = write_edit_guard(guard.path(), dir.path(), None).unwrap();
    let args = build_claude_args(
        &real_base(dir.path()),
        reg.mcp_config(),
        &settings.to_string_lossy(),
        &PermissionArgs::Host,
    );
    let out = tokio::process::Command::new(default_claude_bin())
        .args(&args)
        .current_dir(dir.path())
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    reg.unregister();
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
    assert_eq!(out.status.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "E2E_REAL_CLAUDE=1: spends money"]
async fn real_claude_asks_takes_the_live_answer_completes() {
    if real_mode().as_deref() != Some("1") {
        return;
    }
    let server = Arc::new(
        start_outcome_server(OutcomeServerOptions::default())
            .await
            .unwrap(),
    );
    let dir = tempfile::tempdir().unwrap();
    let d = create_cli_driver(CliDriverOptions::new(server));
    let mut o = real_base(dir.path());
    o.prompt = "Call the ask_user tool with the question \"Which colour?\". Then end your turn. \
                When the answer arrives, call complete_state with result {\"colour\": <the answer>} and stop."
        .into();
    let s = d.start_cli(o).unwrap();
    let events: Arc<Mutex<Vec<DriverEvent>>> = Arc::default();
    let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (e, sw, ans) = (events.clone(), Arc::downgrade(&s), answered.clone());
    s.on(Arc::new(move |ev: &DriverEvent| {
        let mut evs = e.lock().unwrap();
        evs.push(ev.clone());
        if matches!(ev, DriverEvent::TurnEnd { .. }) {
            let done = evs
                .iter()
                .any(|e| matches!(e, DriverEvent::CompleteState { .. }));
            let asked = evs.iter().any(|e| matches!(e, DriverEvent::AskUser { .. }));
            drop(evs);
            let Some(s) = sw.upgrade() else { return };
            use std::sync::atomic::Ordering::SeqCst;
            if asked && !done && !ans.load(SeqCst) {
                ans.store(true, SeqCst); // parked with a live process: answer into stdin
                let _ = s.send_input("green");
            } else {
                s.end();
            }
        }
    }));
    let start = Instant::now();
    while !events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, DriverEvent::Exit { .. }))
    {
        assert!(
            start.elapsed() < Duration::from_secs(180),
            "{:?}",
            events.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let evs = events.lock().unwrap().clone();
    let kinds: Vec<_> = evs
        .iter()
        .filter(|e| !matches!(e, DriverEvent::Output { .. }))
        .map(DriverEvent::kind)
        .collect();
    println!("cli_version {:?} {kinds:?}", s.cli_version());
    assert!(
        s.cli_version()
            .is_some_and(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
    );
    assert!(evs.contains(&DriverEvent::ClaudeSessionId {
        id: s.claude_session_id()
    }));
    assert!(evs.iter().any(|e| matches!(e, DriverEvent::CompleteState { result, .. } if result.get("colour") == Some(&json!("green")))));
    assert_eq!(
        evs.last(),
        Some(&DriverEvent::Exit {
            code: Some(0),
            signal: None
        })
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "E2E_REAL_CLAUDE=permission: spends money"]
async fn real_claude_git_push_never_reaches_the_prompt_tool_touch_does_and_runs() {
    if real_mode().as_deref() != Some("permission") {
        return;
    }
    let server = start_outcome_server(OutcomeServerOptions::default())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let prompts: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let reg_slot: Arc<Mutex<Option<OutcomeRegistration>>> = Arc::default();
    let (p, slot) = (prompts.clone(), reg_slot.clone());
    let reg = server.register(
        OutcomeHandlers {
            on_permission_request: Some(Arc::new(move |prompt| {
                p.lock().unwrap().push((
                    prompt.tool.clone(),
                    serde_json::to_value(&prompt.input).unwrap(),
                ));
                // A human clicks Allow a moment later.
                let slot = slot.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if let Some(reg) = slot.lock().unwrap().as_ref() {
                        reg.resolve_permission(
                            &prompt.request_id,
                            &decision(PermissionBehavior::Allow),
                        );
                    }
                });
                Ok(())
            })),
            ..noop_handlers()
        },
        OutcomeRegisterOptions::default(),
    );
    *reg_slot.lock().unwrap() = Some(reg.clone());
    let guard = tempfile::tempdir_in(dir.path()).unwrap();
    let settings = write_edit_guard(guard.path(), dir.path(), None).unwrap();
    let mut o = real_base(dir.path());
    o.tools = ToolPolicy {
        builtin: vec!["Bash".into()],
        allow: vec![],
        deny: vec!["Bash(git push:*)".into()],
    };
    // The worker argv, but in `manual` mode: auto mode's classifier would approve a plain touch
    // without asking, and this probe needs a prompt.
    let args: Vec<String> = build_claude_args(
        &o,
        reg.mcp_config(),
        &settings.to_string_lossy(),
        &PermissionArgs::Host,
    )
    .into_iter()
    .map(|a| if a == "auto" { "manual".into() } else { a })
    .collect();
    assert!(args.contains(&"--permission-prompt-tool".to_string()));
    let (env, _) = agent_env(&BTreeMap::new(), None, true);
    let mut child = tokio::process::Command::new(default_claude_bin())
        .args(&args)
        .current_dir(dir.path())
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            user_message_line(
                "Use the Bash tool to run exactly `git push origin HEAD`. Whatever happens, then use \
                 the Bash tool to run exactly `touch probe.txt`. Then reply DONE and stop. Do not \
                 call any other tool.",
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let mut stdin = Some(stdin);
    let mut result: Option<Value> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(j) = serde_json::from_str::<Value>(&line)
            && j["type"] == "result"
        {
            result = Some(j);
            stdin = None; // stdin EOF ends the session
        }
    }
    drop(stdin);
    let _ = child.wait().await;
    reg.unregister();
    let prompts = prompts.lock().unwrap().clone();
    println!("prompts {prompts:?} result {result:?}");
    // Deny rules first: no prompt ever named git push.
    assert!(
        !prompts
            .iter()
            .any(|(_, i)| i.to_string().contains("git push"))
    );
    // touch reached the prompt tool and, allowed, ran.
    assert!(
        prompts
            .iter()
            .any(|(t, i)| t == "Bash" && i.to_string().contains("touch"))
    );
    assert!(dir.path().join("probe.txt").exists());
}

/// Rust-only: the session's tasks may run before the caller attaches, so events emitted before
/// the first listener are held for it (the TS event loop gives this for free).
#[tokio::test(flavor = "multi_thread")]
async fn events_before_the_first_listener_are_delivered_to_it_in_order() {
    let ctx = Ctx::new().await;
    let d = create_cli_driver(CliDriverOptions {
        claude_bin: Some(ctx.dir().join("no-such-claude").to_string_lossy().into()),
        ..CliDriverOptions::new(ctx.server.clone())
    });
    let s = d.start_cli(ctx.opts(json!([]))).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await; // the session has exited by now
    let t = Track::new(&s);
    assert_eq!(t.exit().await, (None, None));
    let kinds: Vec<_> = t.events().iter().map(DriverEvent::kind).collect();
    assert_eq!(kinds.last(), Some(&"exit"));
    assert!(t.has(&out(
        OutputStream::Debug,
        "conductor: MCP: only conductor's server"
    )));
    // A second listener sees only what comes later (nothing, after exit).
    let late = Track::new(&s);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(late.events().is_empty());
}

/// 06 §Attachments: each extra dir is one `--add-dir`; none by default.
#[test]
fn add_dirs_become_add_dir_flags() {
    let plain = build_claude_args(&base_opts(), "{}", "s.json", &PermissionArgs::Host);
    assert_eq!(count(&plain, "--add-dir"), 0);
    let mut o = base_opts();
    o.add_dirs = vec![PathBuf::from("/root/artifacts/s/attachments")];
    let args = build_claude_args(&o, "{}", "s.json", &PermissionArgs::Host);
    assert_eq!(count(&args, "--add-dir"), 1);
    assert_eq!(
        flag_of(&args, "--add-dir"),
        Some("/root/artifacts/s/attachments")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn background_tasks_changed_from_the_cli_becomes_a_background_tasks_event() {
    // ADR-0035: the shape claude 2.1.318 prints when a run_in_background job starts and ends.
    let ctx = Ctx::new().await;
    let (s, t) = ctx.start(ctx.opts(json!([[
        {"raw": "{\"type\":\"system\",\"subtype\":\"background_tasks_changed\",\"tasks\":[{\"task_id\":\"b1\",\"task_type\":\"local_bash\"}]}"},
        {"say": "running in the background"},
        {"raw": "{\"type\":\"system\",\"subtype\":\"background_tasks_changed\",\"tasks\":[]}"},
    ]])));
    t.turn_ends(1).await;
    let counts: Vec<u32> = t
        .events()
        .iter()
        .filter_map(|e| match e {
            DriverEvent::BackgroundTasks { running } => Some(*running),
            _ => None,
        })
        .collect();
    assert_eq!(counts, [1, 0]);
    s.end();
    t.exit().await;
}
