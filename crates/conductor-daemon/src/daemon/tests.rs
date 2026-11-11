//! The daemon core's tests (MR-T12): ports of `daemon.test.ts`, `daemon.kill.test.ts`,
//! `reopen-transcript.test.ts`, the daemon-over-the-link cases of `inventory/report.test.ts`, and
//! the Rust-only ADR-0033 `assistant_job` cases.
//!
//! As in TS: the daemon core against a fake orchestrator WS (`test_support::fake_orchestrator`),
//! with `FakeClaudeDriver`, `FakeCommandRunner` and real git in temp dirs (the worktree and clone
//! handling is what is under test). Real time, short timers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conductor_protocol::{CommandAckPayload, DaemonToOrchestrator, OrchestratorToDaemon};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::claude::fake_driver::{FakeClaudeDriver, FakeClaudeScript, FakeTurn, FakeTurnAction};
use crate::commands::fake_runner::FakeCommandRunner;
use crate::config::{Env, load_config};
use crate::sysinfo::LiveResources;
use crate::test_support::fake_orchestrator::{FakeOrchestrator, message_type};

mod append_tail;
mod assistant_job;
mod bug1;
mod conditions;
mod dedupe_seq;
mod inventory_link;
mod kill_real;
mod link;
mod misc;
mod orphan_sweep;
mod permissions;
mod reopen_transcript;
mod run_action;
mod run_cmd_kill;
mod run_gate;
mod send_message;
mod start_session;
mod transitions;
mod units;
mod update;
mod worktree_setup;

pub const TICKET: &str = "0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2";

/// The branch `sessionBranch(TICKET_REF, sid)` names (any valid name works here).
pub fn branch_for(sid: Uuid) -> String {
    format!("conductor/test-ticket-{}", &sid.to_string()[..8])
}

pub fn windows() -> bool {
    Platform::current().is_windows()
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A fixture origin repo with CLAUDE.md and README.md, one commit on `main`.
pub fn git_init(dir: &Path, claude_md: bool) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "--quiet", "-b", "main"]);
    git(dir, &["config", "user.email", "t@example.com"]);
    git(dir, &["config", "user.name", "test"]);
    if claude_md {
        std::fs::write(
            dir.join("CLAUDE.md"),
            "# Fixture repo\nAlways run npm test.\n",
        )
        .unwrap();
    }
    std::fs::write(dir.join("README.md"), "fixture\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "--quiet", "-m", "init"]);
}

/// Collected log lines.
#[derive(Clone, Default)]
pub struct Logs(Arc<Mutex<Vec<String>>>);

impl Logs {
    pub fn sink(&self) -> Log {
        let l = self.0.clone();
        Arc::new(move |m: &str| l.lock().unwrap().push(m.to_string()))
    }
    pub fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

/// A test's change to the loaded config.
pub type ConfigEdit = Box<dyn FnOnce(&mut DaemonConfig)>;

/// What `make` takes beyond the driver (the TS `makeDaemon` opts).
#[derive(Default)]
pub struct Make {
    pub runner: Option<FakeCommandRunner>,
    pub env: Vec<(&'static str, String)>,
    pub root: Option<PathBuf>,
    pub config: Option<ConfigEdit>,
    pub gh: Option<GhCommand>,
    pub on_fatal: Option<OnFatal>,
    pub logs: Option<Logs>,
    pub claude_bin: Option<String>,
    pub proc_info: Option<ProcInfoFn>,
    pub has_conversation: Option<HasConversation>,
    pub scan: Option<ScanFn>,
    pub sysinfo: Option<SysInfo>,
    pub max_sessions: Option<&'static str>,
    /// ADR-0021 (MR-T14a).
    pub supervised: Option<&'static str>,
    pub stage_update: Option<StageUpdateFn>,
    pub on_restart: Option<OnRestartForUpdate>,
    pub max_drain_ms: Option<u64>,
    pub trial_register_ms: Option<u64>,
}

/// One test's temp dir, fixture repo, fake orchestrator and daemons.
pub struct Ctx {
    pub tmp: PathBuf,
    _dir: tempfile::TempDir,
    pub repo: PathBuf,
    pub orch: FakeOrchestrator,
    pub resources: Arc<Mutex<LiveResources>>,
    daemons: Mutex<Vec<Daemon>>,
}

impl Drop for Ctx {
    fn drop(&mut self) {
        for d in self.daemons.lock().unwrap().drain(..) {
            d.stop(true);
        }
    }
}

impl Ctx {
    pub async fn new() -> Ctx {
        Self::with_repo(true).await
    }

    pub async fn with_repo(claude_md: bool) -> Ctx {
        let dir = tempfile::Builder::new()
            .prefix("conductor-daemon-")
            .tempdir()
            .unwrap();
        // fs.realpathSync: without Windows' `\\?\` verbatim prefix, which git and the root
        // path resolution can't use.
        let tmp = crate::claude::transcript::realpath(dir.path()).unwrap();
        // win32: the daemon makes its root private, which needs a private parent.
        mkdir_private(&tmp).unwrap();
        let repo = tmp.join("origin");
        git_init(&repo, claude_md);
        Ctx {
            tmp,
            _dir: dir,
            repo,
            orch: FakeOrchestrator::start().await.unwrap(),
            resources: Arc::new(Mutex::new(LiveResources {
                cpu_free: 4.0,
                mem_free_mb: 8000,
                disk_free_mb: 50_000,
            })),
            daemons: Mutex::new(Vec::new()),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.tmp.join("root")
    }

    pub fn claude_dir(&self) -> PathBuf {
        self.tmp.join("claude-config")
    }

    pub fn set_mem_free(&self, mb: u64) {
        self.resources.lock().unwrap().mem_free_mb = mb;
    }

    pub fn config(&self, m: &mut Make) -> DaemonConfig {
        let mut env: Env = HashMap::new();
        for (k, v) in [
            ("CONDUCTOR_ORCHESTRATOR_URL", self.orch.url()),
            (
                "CONDUCTOR_ROOT",
                m.root
                    .clone()
                    .unwrap_or_else(|| self.root())
                    .to_string_lossy()
                    .into_owned(),
            ),
            ("CONDUCTOR_MACHINE_ID", "test-machine".into()),
            (
                "CONDUCTOR_MAX_SESSIONS",
                m.max_sessions.unwrap_or("2").into(),
            ),
            ("CONDUCTOR_PORT_POOL", "42000-42029".into()),
            ("CONDUCTOR_MIN_FREE_MEM_MB", "1000".into()),
            ("CONDUCTOR_WORK_POLL_MS", "60000".into()),
            // The fixture origin is a local path (M1-T14).
            ("CONDUCTOR_ALLOW_LOCAL_REPOS", "1".into()),
            // Transcripts (the resume check) never come from ~/.claude.
            (
                "CLAUDE_CONFIG_DIR",
                self.claude_dir().to_string_lossy().into_owned(),
            ),
        ] {
            env.insert(k.to_string(), v);
        }
        for (k, v) in &m.env {
            env.insert(k.to_string(), v.clone());
        }
        let mut config = load_config(&env, &crate::config::machine_facts()).unwrap();
        config.reconnect = crate::config::BackoffConfig {
            initial_ms: 20,
            max_ms: 100,
            factor: 2.0,
        };
        config.end_grace_ms = 200;
        if let Some(f) = m.config.take() {
            f(&mut config);
        }
        config
    }

    /// `makeDaemon`: a started daemon with the fakes.
    pub fn make(&self, driver: Arc<dyn ClaudeDriver>, mut m: Make) -> Daemon {
        let config = self.config(&mut m);
        let runner = m
            .runner
            .take()
            .unwrap_or_else(|| FakeCommandRunner::new(2, true));
        let resources = self.resources.clone();
        let mut o = DaemonOptions::new(config, driver);
        o.create_command_runner = Some(Arc::new(move |_| {
            Arc::new(runner.clone()) as Arc<dyn CommandRunner>
        }));
        o.sysinfo = Some(
            m.sysinfo
                .take()
                .unwrap_or_else(|| Arc::new(move |_: &Path| *resources.lock().unwrap())),
        );
        o.claude_code_version = Some("2.1.308".into());
        // DAEMON_TEST_LOG=1 prints the daemon's log (debugging a test).
        let print = std::env::var_os("DAEMON_TEST_LOG").is_some();
        let sink = m.logs.as_ref().map(Logs::sink);
        o.log = Some(Arc::new(move |l: &str| {
            if print {
                eprintln!("[daemon] {l}");
            }
            if let Some(s) = &sink {
                s(l);
            }
        }));
        // M2-T10: hermetic: no real gh / az / ~/.claude probes.
        o.scan_inventory = Some(m.scan.take().unwrap_or_else(empty_scan));
        o.gh_command = m.gh.take();
        o.on_fatal = m.on_fatal.take();
        o.claude_bin = m.claude_bin.take();
        o.proc_info = m.proc_info.take();
        o.has_conversation = m.has_conversation.take();
        o.supervised = m.supervised.map(String::from);
        o.stage_update = m.stage_update.take();
        o.on_restart_for_update = m.on_restart.take();
        o.update_max_drain_ms = m.max_drain_ms;
        o.update_trial_register_ms = m.trial_register_ms;
        let d = Daemon::new(o).unwrap();
        self.daemons.lock().unwrap().push(d.clone());
        d.start();
        d
    }

    /// The TS afterEach: stop the daemons, close the orchestrator, no invalid frame.
    pub async fn done(self) {
        for d in self.daemons.lock().unwrap().drain(..) {
            d.stop(true);
        }
        self.orch.close();
        assert_eq!(self.orch.invalid(), Vec::<String>::new());
    }

    // ------------------------------------------------------------ waiting and reading

    pub async fn until<T>(&self, pred: impl FnMut() -> Option<T>) -> T {
        self.orch.until(pred, None).await.unwrap()
    }

    pub async fn until_for<T>(&self, ms: u64, pred: impl FnMut() -> Option<T>) -> T {
        self.orch
            .until(pred, Some(Duration::from_millis(ms)))
            .await
            .unwrap()
    }

    pub async fn until_true(&self, mut pred: impl FnMut() -> bool) {
        self.until(|| pred().then_some(())).await
    }

    pub fn of_type(&self, ty: &str) -> Vec<Value> {
        self.orch
            .of_type(ty)
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect()
    }

    pub fn types(&self) -> Vec<String> {
        self.orch.received().iter().map(message_type).collect()
    }

    /// `session_event` frames (optionally of one kind), as JSON.
    pub fn events(&self, kind: Option<&str>) -> Vec<Value> {
        self.orch
            .events(kind)
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect()
    }

    pub fn data(&self, kind: &str) -> Vec<Value> {
        self.orch.event_data(kind)
    }

    pub fn acks(&self, cid: Uuid) -> Vec<CommandAckPayload> {
        self.orch.ack(cid)
    }

    /// The `command_ack` frames for `cid`, as JSON (with their envelope).
    pub fn ack_frames(&self, cid: Uuid) -> Vec<Value> {
        self.orch
            .received()
            .iter()
            .filter(|m| matches!(m, DaemonToOrchestrator::CommandAck { payload, .. } if payload.command_id == cid))
            .map(|m| serde_json::to_value(m).unwrap())
            .collect()
    }

    pub async fn ack(&self, cid: Uuid) -> Value {
        let a = self.until(|| self.acks(cid).into_iter().next()).await;
        serde_json::to_value(a).unwrap()
    }

    pub async fn registered_and_asked(&self) {
        self.until(|| self.of_type("request_work").into_iter().next())
            .await;
    }

    pub async fn first_event(&self, kind: &str) -> Value {
        self.until(|| self.events(Some(kind)).into_iter().next())
            .await
    }

    pub async fn first_data(&self, kind: &str) -> Value {
        self.until(|| self.data(kind).into_iter().next()).await
    }

    pub fn send(&self, m: &OrchestratorToDaemon) {
        self.orch.send(m).unwrap();
    }

    // ------------------------------------------------------------ messages

    /// `startSession(sid, over, token)`.
    pub fn start(&self, sid: Uuid, over: Value, token: i64) -> Start {
        let cid = over
            .get("command_id")
            .and_then(Value::as_str)
            .map(|s| Uuid::parse_str(s).unwrap())
            .unwrap_or_else(Uuid::new_v4);
        let mut payload = json!({
            "command_id": cid,
            "ticket_id": TICKET,
            "repo": self.repo.to_string_lossy(),
            "base_ref": "HEAD",
            "branch": branch_for(sid),
            "workflow_state": "implement",
            "prompt": "Implement the ticket",
            "tools": ["read", "edit", "bash", "git"],
            "resume_claude_session_id": null,
            "max_budget_usd": 5,
            "env": { "CONDUCTOR_SESSION_ID": sid, "CONDUCTOR_TICKET_ID": TICKET },
        });
        if let Value::Object(o) = over {
            for (k, v) in o {
                payload[k] = v;
            }
        }
        let msg = cmd("start_session", sid, payload, token);
        Start { msg, cid, sid }
    }
}

/// A start_session and its ids.
pub struct Start {
    pub msg: OrchestratorToDaemon,
    pub cid: Uuid,
    pub sid: Uuid,
}

/// An orchestrator frame on the session envelope.
pub fn cmd(ty: &str, sid: Uuid, payload: Value, token: i64) -> OrchestratorToDaemon {
    serde_json::from_value(json!({
        "type": ty,
        "msg_id": Uuid::new_v4(),
        "seq": null,
        "session_id": sid,
        "fencing_token": token,
        "payload": payload,
    }))
    .unwrap_or_else(|e| panic!("a valid {ty}: {e}"))
}

/// A machine-level orchestrator frame.
pub fn machine_msg(ty: &str, payload: Value) -> OrchestratorToDaemon {
    serde_json::from_value(json!({
        "type": ty,
        "msg_id": Uuid::new_v4(),
        "seq": null,
        "session_id": null,
        "fencing_token": null,
        "payload": payload,
    }))
    .unwrap_or_else(|e| panic!("a valid {ty}: {e}"))
}

pub fn kill(
    sid: Uuid,
    cid: Option<Uuid>,
    target: Option<Uuid>,
    reason: &str,
    token: i64,
) -> OrchestratorToDaemon {
    cmd(
        "kill",
        sid,
        json!({ "command_id": cid, "target_command_id": target, "reason": reason }),
        token,
    )
}

pub fn send_input(sid: Uuid, text: &str) -> (OrchestratorToDaemon, Uuid) {
    let cid = Uuid::new_v4();
    (
        cmd(
            "send_input",
            sid,
            json!({ "command_id": cid, "input_request_id": Uuid::new_v4(), "text": text }),
            1,
        ),
        cid,
    )
}

pub fn empty_scan() -> ScanFn {
    Arc::new(|| {
        async {
            Ok(InventoryScan {
                repos: vec![],
                capabilities: vec![],
                git_identity_missing: false,
            })
        }
        .boxed()
    })
}

// ------------------------------------------------------------ fake Claude scripts

pub fn say(t: &str) -> FakeTurnAction {
    FakeTurnAction::say(t)
}

pub fn ask(q: &str) -> FakeTurnAction {
    FakeTurnAction::ask_user(q)
}

pub fn complete_with(v: Value) -> FakeTurnAction {
    FakeTurnAction::complete(v)
}

pub fn script(turns: Vec<Vec<FakeTurnAction>>) -> FakeClaudeScript {
    FakeClaudeScript::new(turns.into_iter().map(FakeTurn::from).collect())
}

/// `complete(result)`: say "working", then complete_state.
pub fn complete(result: Value) -> FakeClaudeScript {
    script(vec![vec![say("working"), complete_with(result)]])
}

pub fn driver(s: FakeClaudeScript) -> Arc<FakeClaudeDriver> {
    Arc::new(FakeClaudeDriver::new(s))
}

/// A short sleep (the TS `setTimeout` waits).
pub async fn wait_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// The test machine's view of `kill(pid, 0)`.
pub fn alive(pid: u32) -> bool {
    pid_liveness(pid) == Liveness::Alive
}
