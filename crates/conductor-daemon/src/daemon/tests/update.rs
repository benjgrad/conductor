//! ADR-0021 in the daemon core (MR-T14a, Rust only): `update_available` → stage → drain → switch
//! → restart, the bounds, the opt-out, and the trial rules. Staging is faked (it makes the version
//! dir); `update::stage` has its own tests against a real HTTP server.

use super::*;
use crate::commands::service::{LAUNCHER, LAUNCHER_PS1};
use crate::update::layout::{
    Trial, add_bad_version, current_version, daemon_dir, read_trial, version_dir, write_trial,
};
use crate::update::switch::installed_launcher;
use crate::update::{DaemonBuild, UpdateError};
use conductor_protocol::UpdateFailedStage;
use std::sync::atomic::{AtomicUsize, Ordering};

const NEW: &str = "9.9.9";

fn update_available(version: &str) -> OrchestratorToDaemon {
    machine_msg(
        "update_available",
        json!({
            "version": version,
            "file": format!("conductor-daemon-{version}-x86_64-unknown-linux-gnu.tgz"),
            "sha256": "a".repeat(64),
            "size": 1234,
        }),
    )
}

/// Counts stagings and restarts.
#[derive(Clone, Default)]
struct Calls {
    staged: Arc<AtomicUsize>,
    restarts: Arc<AtomicUsize>,
}

impl Calls {
    fn staged(&self) -> usize {
        self.staged.load(Ordering::SeqCst)
    }
    fn restarts(&self) -> usize {
        self.restarts.load(Ordering::SeqCst)
    }
}

/// A root laid out as `install.sh` leaves it: `daemon/<own>`, `current` → it, and the launcher
/// (`trial_aware`: the shipped one, else M2-T18's plain one).
fn lay_out(root: &Path, trial_aware: bool) {
    let d = daemon_dir(root);
    std::fs::create_dir_all(d.join(DAEMON_VERSION).join("bin")).unwrap();
    platform::fs::repoint_dir_link(&d, "current", DAEMON_VERSION).unwrap();
    let launcher = installed_launcher(root);
    std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
    let text = if !trial_aware {
        "#!/bin/sh\nexec x\n"
    } else if windows() {
        LAUNCHER_PS1
    } else {
        LAUNCHER
    };
    std::fs::write(launcher, text).unwrap();
}

/// The `Make` for an update test: supervised, staging into `<root>/daemon/<version>` (or failing
/// with `fail`), counting restarts.
fn make_update(c: &Ctx, calls: &Calls, fail: Option<UpdateError>, logs: &Logs) -> Make {
    let root = c.root();
    let staged = calls.staged.clone();
    let restarts = calls.restarts.clone();
    Make {
        supervised: Some("systemd"),
        logs: Some(logs.clone()),
        stage_update: Some(Arc::new(move |b: DaemonBuild| {
            staged.fetch_add(1, Ordering::SeqCst);
            let (root, fail) = (root.clone(), fail.clone());
            Box::pin(async move {
                if let Some(e) = fail {
                    return Err(e);
                }
                let dir = version_dir(&root, &b.version);
                std::fs::create_dir_all(dir.join("bin")).unwrap();
                Ok(dir)
            })
        })),
        on_restart: Some(Arc::new(move || {
            restarts.fetch_add(1, Ordering::SeqCst);
        })),
        ..Make::default()
    }
}

fn drainings(c: &Ctx) -> Vec<Value> {
    c.of_type("heartbeat")
        .into_iter()
        .filter_map(|h| h["payload"].get("draining").cloned())
        .collect()
}

fn alerts(c: &Ctx) -> Vec<Value> {
    c.of_type("alert")
        .into_iter()
        .map(|a| a["payload"].clone())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_daemon_drains_switches_current_and_asks_to_restart() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let (calls, logs) = (Calls::default(), Logs::default());
    c.make(
        driver(complete(json!({}))),
        make_update(&c, &calls, None, &logs),
    );
    c.registered_and_asked().await;
    c.send(&update_available(NEW));
    c.until_true(|| calls.restarts() == 1).await;
    assert_eq!(
        drainings(&c),
        [json!({ "reason": "update", "version": NEW })]
    );
    assert_eq!(current_version(&c.root()).as_deref(), Some(NEW));
    assert_eq!(
        read_trial(&c.root()),
        Some(Trial {
            from: DAEMON_VERSION.into(),
            to: NEW.into(),
            attempts: 0
        })
    );
    // No new work is asked for once draining, and the announcement isn't acted on twice.
    let asked = c.of_type("request_work").len();
    c.send(&update_available(NEW));
    wait_ms(200).await;
    assert_eq!(c.of_type("request_work").len(), asked);
    assert_eq!(calls.staged(), 1);
    assert_eq!(calls.restarts(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_turn_holds_the_drain_until_it_parks_on_a_question() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let (calls, logs) = (Calls::default(), Logs::default());
    let drv = driver(script(vec![vec![
        say("working"),
        FakeTurnAction::AwaitMessage,
        ask("Which DB?"),
    ]]));
    c.make(drv.clone(), make_update(&c, &calls, None, &logs));
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.until_true(|| drv.last().is_some()).await;
    c.send(&update_available(NEW));
    c.until_true(|| !drainings(&c).is_empty()).await;
    let asked = c.of_type("request_work").len();
    wait_ms(300).await;
    assert_eq!(calls.restarts(), 0, "a live turn must not be cut");
    assert_eq!(current_version(&c.root()).as_deref(), Some(DAEMON_VERSION));
    // The orchestrator still reaches the session while draining.
    let cid = Uuid::new_v4();
    c.send(&cmd(
        "send_message",
        sid,
        json!({ "command_id": cid, "target_command_id": start.cid, "text": "go on" }),
        1,
    ));
    c.first_event("ask_user").await;
    c.until_true(|| calls.restarts() == 1).await;
    assert_eq!(current_version(&c.root()).as_deref(), Some(NEW));
    assert!(
        !drv.last().unwrap().exited(),
        "a parked session isn't killed by the drain"
    );
    assert_eq!(c.of_type("request_work").len(), asked);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_parked_for_a_human_does_not_block() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let (calls, logs) = (Calls::default(), Logs::default());
    let drv = driver(script(vec![vec![ask("Which DB?")]]));
    c.make(drv.clone(), make_update(&c, &calls, None, &logs));
    c.registered_and_asked().await;
    let start = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    c.send(&update_available(NEW));
    c.until_true(|| calls.restarts() == 1).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drain_that_hits_its_limit_resumes_work_and_raises_an_alert() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let (calls, logs) = (Calls::default(), Logs::default());
    let drv = driver(script(vec![vec![
        say("working"),
        FakeTurnAction::AwaitMessage,
    ]]));
    let mut m = make_update(&c, &calls, None, &logs);
    m.max_drain_ms = Some(300);
    // The no_work poll (60 s in these tests) would otherwise be the next request_work.
    m.env = vec![("CONDUCTOR_WORK_POLL_MS", "50".into())];
    c.make(drv.clone(), m);
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    c.until_true(|| drv.last().is_some()).await;
    let asked = c.of_type("request_work").len();
    c.send(&update_available(NEW));
    let alert = c.until(|| alerts(&c).into_iter().next()).await;
    assert_eq!(alert["kind"], "update_failed");
    assert_eq!(alert["version"], NEW);
    assert_eq!(alert["stage"], "drain_timeout");
    c.until_true(|| c.of_type("request_work").len() > asked)
        .await;
    assert_eq!(calls.restarts(), 0);
    assert_eq!(current_version(&c.root()).as_deref(), Some(DAEMON_VERSION));
    // Heartbeats stop saying draining; the alert is durable (it has a seq).
    c.until_true(|| {
        c.of_type("heartbeat")
            .last()
            .is_some_and(|h| h["payload"].get("draining").is_none())
    })
    .await;
    assert!(c.of_type("alert")[0]["seq"].is_i64());
    // Cooling down: the next announcement is not acted on.
    c.send(&update_available(NEW));
    wait_ms(100).await;
    assert_eq!(calls.staged(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_stage_raises_an_alert_and_keeps_working() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let (calls, logs) = (Calls::default(), Logs::default());
    let fail = UpdateError::new(UpdateFailedStage::Verify, "SHA-256 does not match");
    c.make(
        driver(complete(json!({}))),
        make_update(&c, &calls, Some(fail), &logs),
    );
    c.registered_and_asked().await;
    c.send(&update_available(NEW));
    let alert = c.until(|| alerts(&c).into_iter().next()).await;
    assert_eq!(alert["stage"], "verify");
    assert_eq!(alert["error"], "SHA-256 does not match");
    assert!(drainings(&c).is_empty());
    assert_eq!(calls.restarts(), 0);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_update_off_or_a_bad_version_is_ignored() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let mut cfg = crate::config::read_file_config(&c.root()).unwrap();
    cfg.auto_update = false;
    crate::config::write_file_config(&c.root(), &cfg).unwrap();
    std::fs::create_dir_all(daemon_dir(&c.root())).unwrap();
    add_bad_version(&c.root(), "8.8.8").unwrap();
    let (calls, logs) = (Calls::default(), Logs::default());
    c.make(
        driver(complete(json!({}))),
        make_update(&c, &calls, None, &logs),
    );
    c.registered_and_asked().await;
    c.send(&update_available(NEW));
    c.send(&update_available(NEW));
    c.until_true(|| {
        logs.lines()
            .iter()
            .any(|l| l.contains("auto-update is off"))
    })
    .await;
    assert_eq!(
        logs.lines()
            .iter()
            .filter(|l| l.contains("auto-update is off"))
            .count(),
        1,
        "logged once"
    );
    cfg.auto_update = true;
    crate::config::write_file_config(&c.root(), &cfg).unwrap();
    c.send(&update_available("8.8.8"));
    c.until_true(|| {
        logs.lines()
            .iter()
            .any(|l| l.contains("rolled back on this machine"))
    })
    .await;
    assert_eq!(calls.staged(), 0);
    // Turning it back on needs no restart.
    c.send(&update_available(NEW));
    c.until_true(|| calls.restarts() == 1).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupervised_or_with_an_old_launcher_it_only_stages() {
    for trial_aware in [true, false] {
        let c = Ctx::new().await;
        lay_out(&c.root(), trial_aware);
        let (calls, logs) = (Calls::default(), Logs::default());
        let mut m = make_update(&c, &calls, None, &logs);
        if trial_aware {
            m.supervised = None;
        }
        c.make(driver(complete(json!({}))), m);
        c.registered_and_asked().await;
        c.send(&update_available(NEW));
        c.until_true(|| calls.staged() == 1).await;
        let want = if trial_aware {
            "restart conductor-daemon to use it"
        } else {
            "Re-run the install command"
        };
        c.until_true(|| logs.lines().iter().any(|l| l.contains(want)))
            .await;
        c.send(&update_available(NEW));
        c.until_true(|| calls.staged() == 2).await;
        wait_ms(100).await;
        assert_eq!(
            logs.lines().iter().filter(|l| l.contains(want)).count(),
            1,
            "logged once"
        );
        assert!(drainings(&c).is_empty());
        assert_eq!(calls.restarts(), 0);
        assert_eq!(current_version(&c.root()).as_deref(), Some(DAEMON_VERSION));
        c.done().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_commits_a_trial_of_this_version_and_reports_rollbacks_once() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    let d = daemon_dir(&c.root());
    for v in ["0.0.1", "0.0.2"] {
        std::fs::create_dir_all(d.join(v)).unwrap();
    }
    write_trial(
        &c.root(),
        &Trial {
            from: "0.0.2".into(),
            to: DAEMON_VERSION.into(),
            attempts: 1,
        },
    )
    .unwrap();
    add_bad_version(&c.root(), "7.7.7").unwrap();
    let (calls, logs) = (Calls::default(), Logs::default());
    c.make(
        driver(complete(json!({}))),
        make_update(&c, &calls, None, &logs),
    );
    c.registered_and_asked().await;
    assert_eq!(read_trial(&c.root()), None);
    assert!(d.join("0.0.2").is_dir(), "the previous version is kept");
    assert!(!d.join("0.0.1").exists(), "older ones go");
    let alert = c.until(|| alerts(&c).into_iter().next()).await;
    assert_eq!(alert["stage"], "trial");
    assert_eq!(alert["version"], "7.7.7");
    // A reconnect doesn't report it again.
    c.orch.drop_socket();
    c.until_true(|| c.of_type("register").len() == 2).await;
    c.until_true(|| c.of_type("request_work").len() >= 2).await;
    assert_eq!(alerts(&c).len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_trial_start_that_reaches_the_server_but_never_registers_exits_for_the_launcher() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    write_trial(
        &c.root(),
        &Trial {
            from: "0.0.2".into(),
            to: DAEMON_VERSION.into(),
            attempts: 1,
        },
    )
    .unwrap();
    c.orch.set_silent_register(true);
    let (calls, logs) = (Calls::default(), Logs::default());
    let mut m = make_update(&c, &calls, None, &logs);
    m.trial_register_ms = Some(300);
    c.make(driver(complete(json!({}))), m);
    c.until_true(|| calls.restarts() == 1).await;
    assert!(read_trial(&c.root()).is_some(), "not committed");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_trial_a_slow_registration_is_not_a_failure() {
    let c = Ctx::new().await;
    lay_out(&c.root(), true);
    c.orch.set_silent_register(true);
    let (calls, logs) = (Calls::default(), Logs::default());
    let mut m = make_update(&c, &calls, None, &logs);
    m.trial_register_ms = Some(100);
    c.make(driver(complete(json!({}))), m);
    c.until_true(|| !c.of_type("register").is_empty()).await;
    wait_ms(400).await;
    assert_eq!(calls.restarts(), 0);
    c.done().await;
}
