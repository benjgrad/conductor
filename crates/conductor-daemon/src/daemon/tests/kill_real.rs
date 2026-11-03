//! `daemon.kill.test.ts`: BUG-1 FR-2, a kill for a parked agent process (alive, idle, blocked
//! reading stdin for an answer) ends it and is acked; BUG-1b against a real process. The real CLI
//! driver against the process-boundary fake (`fake-claude.mjs` under node), so a real process
//! group (win32: a real tree) is signalled; that boundary is what is under test.

use super::*;
use crate::claude::cli_driver::{CliDriverOptions, create_cli_driver};
use crate::claude::outcome_server::{OutcomeServerOptions, start_outcome_server};
use std::sync::OnceLock;

fn fake_claude() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/daemon/test/fixtures/fake-claude.mjs")
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

async fn cli_driver() -> Arc<dyn ClaudeDriver> {
    let server = Arc::new(
        start_outcome_server(OutcomeServerOptions::default())
            .await
            .unwrap(),
    );
    Arc::new(create_cli_driver(CliDriverOptions {
        claude_bin: Some(node()),
        claude_prefix_args: vec![fake_claude()],
        kill_grace: Some(Duration::from_millis(2_000)),
        extra_state_env: Some(Arc::new(|k: &str| k.starts_with("FAKE_CLAUDE_"))),
        ..CliDriverOptions::new(server)
    }))
}

async fn make(c: &Ctx, claude_bin: Option<String>, logs: Option<Logs>) -> Daemon {
    let driver = cli_driver().await;
    let resources = c.resources.clone();
    c.make(
        driver,
        Make {
            claude_bin,
            logs,
            sysinfo: Some(Arc::new(move |_: &Path| *resources.lock().unwrap())),
            config: Some(Box::new(|cfg| cfg.kill_grace_ms = 2_000)),
            ..Make::default()
        },
    )
}

fn parked_start(c: &Ctx, sid: Uuid) -> Start {
    c.start(
        sid,
        json!({
            "tools": ["read"],
            "env": {
                "FAKE_CLAUDE_SCENARIO": json!([[{ "ask_user": "Which colour?" }]]).to_string(),
                "FAKE_CLAUDE_STATE_DIR": c.tmp.join("fake-state").to_string_lossy(),
            },
        }),
        1,
    )
}

fn agent_of(d: &Daemon, sid: Uuid) -> Option<AgentRecord> {
    d.store()
        .session(&sid.to_string())
        .and_then(|s| s.agent.clone().flatten())
}

async fn a_kill_ends_it_within_5_s_and_is_acked(aimed: bool) {
    let c = Ctx::new().await;
    let d = make(&c, None, None).await;
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = parked_start(&c, sid);
    c.send(&start.msg);
    // Parked: ask_user reported, the process idle waiting for an answer on stdin.
    c.first_event("ask_user").await;
    let pid = agent_of(&d, sid).unwrap().pid.unwrap();
    assert!(pid > 0);
    assert!(alive(pid));

    let kill_id = Uuid::new_v4();
    let sent_at = std::time::Instant::now();
    let target = aimed.then_some(start.cid);
    c.send(&kill(sid, Some(kill_id), target, "session done", 1));
    let exit = c
        .until_for(5_000, || c.events(Some("exit")).into_iter().next())
        .await;
    assert!(sent_at.elapsed() < Duration::from_secs(5));
    assert_eq!(exit["payload"]["data"]["command_id"], json!(start.cid));
    assert!(c.acks(kill_id)[0].accepted);
    c.until_for(2_000, || (!alive(pid)).then_some(())).await;
    assert_eq!(agent_of(&d, sid), None);
    assert_eq!(
        d.store().session(&sid.to_string()).unwrap().agent,
        Some(None)
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_aimed_at_its_start_session_ends_it_within_5_s_and_is_acked() {
    a_kill_ends_it_within_5_s_and_is_acked(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_with_a_null_target_at_its_fencing_token_ends_it_within_5_s_and_is_acked() {
    a_kill_ends_it_within_5_s_and_is_acked(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_1_the_start_time_is_persisted_at_spawn_a_restarted_daemon_kills_its_orphan() {
    let c = Ctx::new().await;
    let d1 = make(&c, None, None).await;
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&parked_start(&c, sid).msg);
    c.first_event("ask_user").await;
    let agent = agent_of(&d1, sid).unwrap();
    let pid = agent.pid.unwrap();
    let started_at = agent.started_at.unwrap();
    assert_eq!(started_at, read_proc_info(pid).unwrap().started_at_ms);
    assert!((started_at - now_ms()).abs() < 10_000);
    // The daemon dies with the process still running (a detached `node fake-claude.mjs
    // --session-id <id> …`, the launcher form of argv).
    d1.stop(false);
    let logs = Logs::default();
    make(&c, Some(fake_claude()), Some(logs.clone())).await;
    c.until_for(5_000, || (!alive(pid)).then_some(())).await;
    assert!(logs.lines().contains(&format!(
        "startup: killed orphaned claude process {pid} of session {sid}"
    )));
    c.until(|| {
        c.data("exit")
            .into_iter()
            .find(|e| e["signal"] == "daemon_restart")
    })
    .await;
    platform::signal_tree(pid, Signal::Kill); // the fake's own group / tree, started here
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_2_b_a_recorded_pid_whose_start_time_differs_reused_is_left_alone() {
    let c = Ctx::new().await;
    let d1 = make(&c, None, None).await;
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&parked_start(&c, sid).msg);
    c.first_event("ask_user").await;
    let pid = agent_of(&d1, sid).unwrap().pid.unwrap();
    d1.stop(false);
    // As if the pid now belonged to another process: same pid, another start time.
    {
        let mut store = DaemonStore::for_root(&c.root()).unwrap();
        let s = store.session(&sid.to_string()).unwrap().clone();
        let mut a = s.agent.clone().flatten().unwrap();
        a.started_at = a.started_at.map(|t| t - 60_000);
        store
            .put_session(
                &sid.to_string(),
                PersistedSession {
                    agent: Some(Some(a)),
                    ..s
                },
            )
            .unwrap();
    }
    let logs = Logs::default();
    make(&c, Some(fake_claude()), Some(logs.clone())).await;
    let want = format!("pid {pid} alive but not ours (start time differs");
    c.until_true(|| logs.lines().iter().any(|l| l.contains(&want)))
        .await;
    assert!(alive(pid));
    platform::signal_tree(pid, Signal::Kill);
    c.done().await;
}
