//! `run` (MR-T13b). The pure helpers directly. `run_daemon` runs in-process against the fake
//! orchestrator, with a scripted signal channel and a `claude` that doesn't exist (both probes fail
//! fast) or a fake one (the version probe).

use super::*;
use crate::config::machine_facts;
use crate::inventory::report::InventoryScan;
use crate::platform::Platform;
use crate::sysinfo::LiveResources;
use crate::test_support::fake_bin::write_fake_bin;
use crate::test_support::fake_orchestrator::FakeOrchestrator;
use futures_util::FutureExt;
use std::path::PathBuf;
use std::sync::Mutex;

#[test]
fn parse_claude_version_takes_the_first_semver_else_the_text() {
    assert_eq!(
        parse_claude_version("2.1.316 (Claude Code)\n").as_deref(),
        Some("2.1.316")
    );
    assert_eq!(
        parse_claude_version("Claude Code v10.20.30-beta").as_deref(),
        Some("10.20.30")
    );
    assert_eq!(
        parse_claude_version("1.2 then 3.4.5").as_deref(),
        Some("3.4.5")
    );
    assert_eq!(parse_claude_version("  weird \n").as_deref(), Some("weird"));
    assert_eq!(parse_claude_version(" \n"), None);
    assert_eq!(parse_claude_version(""), None);
}

#[test]
fn inside_dot_claude_matches_a_whole_component_only() {
    let base = PathBuf::from("home").join("u");
    assert!(inside_dot_claude(&base.join(".claude").join("x")));
    assert!(inside_dot_claude(&base.join(".claude")));
    assert!(!inside_dot_claude(&base.join(".claudex")));
    assert!(!inside_dot_claude(&base.join("x.claude")));
    assert!(!inside_dot_claude(&base.join(".conductor")));
    if Platform::current().is_windows() {
        assert!(inside_dot_claude(Path::new(r"C:\Users\u\.claude\root")));
    }
}

#[test]
fn startup_line_says_enrolled_or_local_mode() {
    let t = tempfile::tempdir().unwrap();
    let mut env = Env::new();
    env.insert(
        "CONDUCTOR_ROOT".into(),
        t.path().to_string_lossy().into_owned(),
    );
    env.insert("CONDUCTOR_MACHINE_ID".into(), "laptop".into());
    env.insert(
        "CONDUCTOR_ORCHESTRATOR_URL".into(),
        "ws://127.0.0.1:1/ws/daemon".into(),
    );
    let mut c = load_config(&env, &machine_facts()).unwrap();
    let local = startup_line(&c);
    assert_eq!(
        local,
        format!(
            "laptop → ws://127.0.0.1:1/ws/daemon (root {}, local mode)",
            c.root_dir.display()
        )
    );
    c.credential = Some("secret".into());
    assert!(startup_line(&c).ends_with(", enrolled)"));
    assert!(!startup_line(&c).contains("secret"));
}

/// The tools `start_detached` was asked to start.
type Started = Arc<Mutex<Vec<(String, Vec<String>)>>>;

struct Run {
    orch: FakeOrchestrator,
    _root: tempfile::TempDir,
    env: Env,
    signals: mpsc::UnboundedSender<DaemonSignal>,
    started: Started,
    logs: Arc<Mutex<Vec<String>>>,
    handle: tokio::task::JoinHandle<i32>,
}

impl Run {
    /// `run_daemon` against a fresh fake orchestrator. `claude` is `bin`, else a path that doesn't
    /// exist (both probes fail at once).
    async fn start(extra: &[(&str, &str)], bin: Option<String>, uid: Option<u32>) -> Run {
        let orch = FakeOrchestrator::start().await.unwrap();
        let root = tempfile::tempdir().unwrap();
        // win32: the daemon makes its root private, which needs a private parent (ADR-0024).
        crate::platform::mkdir_private(root.path()).unwrap();
        let mut env = Env::new();
        env.insert(
            "CONDUCTOR_ROOT".into(),
            root.path().join("root").to_string_lossy().into_owned(),
        );
        env.insert("CONDUCTOR_MACHINE_ID".into(), "run-test".into());
        env.insert("CONDUCTOR_ORCHESTRATOR_URL".into(), orch.url());
        env.insert(
            "CONDUCTOR_CLAUDE_BIN".into(),
            bin.unwrap_or_else(|| {
                root.path()
                    .join("no-such-claude")
                    .to_string_lossy()
                    .into_owned()
            }),
        );
        for (k, v) in extra {
            env.insert((*k).into(), (*v).into());
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let started: Started = Arc::new(Mutex::new(Vec::new()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let deps = RunDeps {
            signals: rx,
            start_detached: {
                let s = started.clone();
                Box::new(move |f: &str, a: &[String]| {
                    s.lock().unwrap().push((f.to_string(), a.to_vec()))
                })
            },
            uid,
            log: {
                let l = logs.clone();
                Arc::new(move |m: &str| l.lock().unwrap().push(m.to_string()))
            },
            exit_grace: Some(Duration::from_millis(10)),
            // Hermetic, as the daemon-core tests: no real gh / az / claude probes, no live
            // sysinfo (they are slow on the Windows runner).
            scan_inventory: Some(Arc::new(|| {
                async {
                    Ok(InventoryScan {
                        repos: vec![],
                        capabilities: vec![],
                        git_identity_missing: false,
                    })
                }
                .boxed()
            })),
            sysinfo: Some(Arc::new(|_: &Path| LiveResources {
                cpu_free: 4.0,
                mem_free_mb: 8192,
                disk_free_mb: 50_000,
            })),
        };
        let env2 = env.clone();
        let handle = tokio::spawn(async move { run_daemon(&env2, deps).await });
        Run {
            orch,
            _root: root,
            env,
            signals: tx,
            started,
            logs,
            handle,
        }
    }

    /// The `register` frame. On a timeout, or if `run_daemon` returned first, fail with its log.
    async fn registered(&self) -> serde_json::Value {
        let reg = self
            .orch
            .until(
                || {
                    if self.handle.is_finished() {
                        return Some(None);
                    }
                    self.orch.of_type("register").into_iter().next().map(Some)
                },
                Some(Duration::from_secs(30)),
            )
            .await;
        match reg {
            Ok(Some(reg)) => serde_json::to_value(reg).unwrap(),
            other => panic!(
                "no register ({}; run_daemon finished: {}); run's log:\n{}",
                if other.is_ok() {
                    "run_daemon returned"
                } else {
                    "timed out"
                },
                self.handle.is_finished(),
                self.logs.lock().unwrap().join("\n")
            ),
        }
    }

    async fn exit_code(self) -> i32 {
        tokio::time::timeout(Duration::from_secs(20), self.handle)
            .await
            .expect("run_daemon returns")
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_stops_the_daemon_and_exits_0() {
    let r = Run::start(&[], None, Some(501)).await;
    let reg = r.registered().await;
    assert_eq!(reg["payload"]["machine_id"], "run-test");
    let logs = r.logs.lock().unwrap().clone();
    assert!(
        logs.iter()
            .any(|l| l.starts_with("run-test → ws://") && l.ends_with(", local mode)")),
        "{logs:?}"
    );
    assert!(
        logs.iter()
            .any(|l| l.starts_with("WARNING: this Claude Code can't send permission prompts")),
        "{logs:?}"
    );
    r.signals.send(DaemonSignal::Shutdown).unwrap();
    let started = r.started.clone();
    assert_eq!(r.exit_code().await, 0);
    assert!(started.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revoked_link_exits_78_and_boots_the_launchd_job_out() {
    let r = Run::start(&[("CONDUCTOR_SUPERVISED", "launchd")], None, Some(501)).await;
    r.registered().await;
    r.orch.close_with(4001);
    let started = r.started.clone();
    assert_eq!(r.exit_code().await, 78);
    assert_eq!(
        *started.lock().unwrap(),
        vec![(
            "launchctl".to_string(),
            vec![
                "bootout".to_string(),
                "gui/501/com.conductor.daemon".to_string()
            ]
        )]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fatal_close_unsupervised_exits_78_without_a_bootout() {
    let r = Run::start(&[], None, Some(501)).await;
    r.registered().await;
    r.orch.close_with(4003);
    let started = r.started.clone();
    assert_eq!(r.exit_code().await, 78);
    assert!(started.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_of_fatal_and_shutdown_wins() {
    // launchd's bootout sends SIGTERM right after the fatal close: 78 must stay 78.
    let r = Run::start(&[("CONDUCTOR_SUPERVISED", "launchd")], None, Some(501)).await;
    r.registered().await;
    r.orch.close_with(4001);
    // Wait for the bootout (the fatal branch ran), then send the SIGTERM it causes.
    let started = r.started.clone();
    r.orch
        .until(|| (!started.lock().unwrap().is_empty()).then_some(()), None)
        .await
        .unwrap();
    let _ = r.signals.send(DaemonSignal::Shutdown);
    assert_eq!(r.exit_code().await, 78);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rescan_keeps_the_daemon_running() {
    let r = Run::start(&[], None, None).await;
    r.registered().await;
    r.signals.send(DaemonSignal::Rescan).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!r.handle.is_finished(), "a rescan must not stop the daemon");
    r.signals.send(DaemonSignal::Shutdown).unwrap();
    assert_eq!(r.exit_code().await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bad_config_exits_1_before_anything_starts() {
    let t = tempfile::tempdir().unwrap();
    let mut env = Env::new();
    env.insert(
        "CONDUCTOR_ROOT".into(),
        t.path().to_string_lossy().into_owned(),
    );
    env.insert("CONDUCTOR_WORK_POLL_MS".into(), "zero".into());
    let (_tx, rx) = mpsc::unbounded_channel();
    let logs = Arc::new(Mutex::new(Vec::new()));
    let deps = RunDeps {
        log: {
            let l = logs.clone();
            Arc::new(move |m: &str| l.lock().unwrap().push(m.to_string()))
        },
        ..RunDeps::new(rx, None)
    };
    assert_eq!(run_daemon(&env, deps).await, 1);
    let logs = logs.lock().unwrap();
    assert!(
        logs.iter().any(|l| l.contains("CONDUCTOR_WORK_POLL_MS")),
        "{logs:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn register_carries_the_claude_code_version() {
    // Windows only runs a native claude.exe (U-110), so a fake script reports no version there.
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_bin(
        dir.path(),
        "claude",
        "if (process.argv.includes('--version')) console.log('9.9.9 (Claude Code)');",
        Platform::current(),
    )
    .unwrap();
    let r = Run::start(&[], Some(bin.to_string_lossy().into_owned()), None).await;
    let reg = r.registered().await;
    let expected = if Platform::current().is_windows() {
        serde_json::Value::Null
    } else {
        serde_json::json!("9.9.9")
    };
    assert_eq!(reg["payload"]["claude_code_version"], expected);
    assert_eq!(r.env["CONDUCTOR_MACHINE_ID"], "run-test");
    r.signals.send(DaemonSignal::Shutdown).unwrap();
    assert_eq!(r.exit_code().await, 0);
}
