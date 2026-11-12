//! R2 (07 §Worktree setup): the repo's setup in the agent's worktree before Claude starts.

use super::*;
use crate::actions::worktree_setup::WORKTREE_SETUP_TIMEOUT;
use crate::commands::fake_runner::FakeCommandScript;

const SETUP: &str = "deps-install";

fn setup_start(c: &Ctx, sid: Uuid, token: i64) -> Start {
    c.start(sid, json!({ "worktree_setup": SETUP }), token)
}

/// Position of the first frame matching `f` among everything the orchestrator received.
fn position(c: &Ctx, f: impl Fn(&Value) -> bool) -> Option<usize> {
    c.orch
        .received()
        .iter()
        .map(|m| serde_json::to_value(m).unwrap())
        .position(|v| f(&v))
}

fn outputs(c: &Ctx) -> Vec<String> {
    c.of_type("output")
        .iter()
        .map(|o| o["payload"]["text"].as_str().unwrap_or("").to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_the_setup_in_the_worktree_before_the_agent_and_skips_it_while_unchanged() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    // Record whether Claude had started when the setup ran.
    let d2 = drv.clone();
    let spawned_before = Arc::new(Mutex::new(None));
    let seen = spawned_before.clone();
    let runner = FakeCommandRunner::new(2, true).script_by(SETUP, move |_| {
        *seen.lock().unwrap() = Some(!d2.starts().is_empty());
        FakeCommandScript::default()
    });
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = setup_start(&c, sid, 1);
    c.send(&start.msg);
    c.first_event("exit").await;

    let calls = runner.calls();
    assert_eq!(calls.len(), 1);
    let opts = drv.starts()[0].clone();
    assert_eq!(calls[0].cmd, SETUP);
    assert_eq!(calls[0].cwd, opts.cwd, "in the agent's worktree");
    assert_eq!(calls[0].timeout, Some(WORKTREE_SETUP_TIMEOUT));
    assert_eq!(calls[0].env["COREPACK_ENABLE_DOWNLOAD_PROMPT"], "0");
    assert_eq!(*spawned_before.lock().unwrap(), Some(false));
    // FR-4: the agent's environment too (the driver's pins, which no state env can drop).
    assert!(
        crate::claude::cli_driver::agent_env_pins()
            .iter()
            .any(|(k, v)| *k == "COREPACK_ENABLE_DOWNLOAD_PROMPT" && v == "0")
    );
    assert!(!opts.prompt.contains("Setup failed"));
    // Acked once, before the setup's process existed and before `started`.
    assert_eq!(
        serde_json::to_value(c.acks(start.cid)).unwrap(),
        json!([{ "command_id": start.cid, "accepted": true }])
    );
    let ack = position(&c, |v| v["type"] == "command_ack").unwrap();
    let started = position(&c, |v| v["payload"]["kind"] == "started").unwrap();
    assert!(ack < started);
    assert!(
        outputs(&c)
            .iter()
            .any(|t| t.contains("conductor: worktree setup `deps-install`"))
    );

    // The next start in the same worktree: the marker matches, nothing runs.
    let again = setup_start(&c, sid, 2);
    c.send(&again.msg);
    c.until_true(|| c.data("exit").len() == 2).await;
    assert_eq!(runner.calls().len(), 1);
    assert!(outputs(&c).iter().any(|t| t.contains("up to date")));
    assert_eq!(
        serde_json::to_value(c.acks(again.cid)).unwrap(),
        json!([{ "command_id": again.cid, "accepted": true }])
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_setup_still_starts_the_agent_and_its_prompt_says_whose_problem_it_is() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    // Fails in the worktree and on the base branch's tip alike.
    let runner = FakeCommandRunner::new(2, true).script(
        SETUP,
        FakeCommandScript::exit(1).output("boom: libfoo not found"),
    );
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = setup_start(&c, sid, 1);
    c.send(&start.msg);
    c.first_event("exit").await;

    // Accepted once, no refusal: the agent ran.
    assert_eq!(
        serde_json::to_value(c.acks(start.cid)).unwrap(),
        json!([{ "command_id": start.cid, "accepted": true }])
    );
    assert_eq!(c.data("started").len(), 1);
    let opts = drv.starts()[0].clone();
    assert!(
        opts.prompt
            .starts_with("Implement the ticket\n\n## Setup failed\n")
    );
    assert!(
        opts.prompt
            .contains("`deps-install` (from the repo checks override)")
    );
    assert!(opts.prompt.contains("(exit code 1)"));
    assert!(opts.prompt.contains("boom: libfoo not found"));
    assert!(
        opts.prompt.contains("fails on origin/main too"),
        "{}",
        opts.prompt
    );
    assert!(opts.prompt.contains("not your branch"));
    // A new branch is still at origin/main: the base is the same commit, so the probe decides
    // `fail` without running the setup again.
    let calls = runner.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].cwd, opts.cwd);
    assert!(
        outputs(&c)
            .iter()
            .any(|t| t.contains("base probe: origin/main is the commit under check"))
    );
    // Nothing was counted or routed by the daemon: the only exit is the agent's own.
    assert_eq!(
        c.data("exit"),
        vec![json!({ "command_id": start.cid, "code": 0, "signal": null })]
    );

    // A failure leaves no marker: the next start runs the setup again.
    let again = setup_start(&c, sid, 2);
    c.send(&again.msg);
    c.until_true(|| c.data("exit").len() == 2).await;
    assert_eq!(runner.calls().len(), 2);
    assert_eq!(runner.calls()[1].cwd, opts.cwd);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_during_the_setup_stops_it_and_nothing_is_spawned() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    let runner = FakeCommandRunner::new(2, false);
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = setup_start(&c, sid, 1);
    c.send(&start.msg);
    c.until_true(|| runner.running_count() == 1).await;
    assert_eq!(c.acks(start.cid).len(), 1);
    c.send(&kill(sid, Some(Uuid::new_v4()), None, "operator_cancel", 1));
    let exit = c.first_data("exit").await;
    assert_eq!(
        exit,
        json!({ "command_id": start.cid, "code": null, "signal": null, "stderr_tail": "killed" })
    );
    assert_eq!(runner.running_count(), 0, "the setup was killed");
    wait_ms(100).await;
    assert!(drv.starts().is_empty());
    assert!(c.data("started").is_empty());
    // One ack only: accepted (an acked start never becomes a refusal).
    assert_eq!(c.acks(start.cid).len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daemon_restart_during_the_setup_reports_the_acked_start_as_exited() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(2, false);
    let d1 = c.make(
        driver(complete(json!({}))),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = setup_start(&c, sid, 7);
    c.send(&start.msg);
    c.until_true(|| runner.running_count() == 1).await;
    // The setup can start before the ack reaches the fake server (slow Windows runners): wait for
    // the ack rather than asserting it the moment the setup runs.
    c.until_true(|| c.acks(start.cid).len() == 1).await;
    d1.stop(false); // a crash: the setup and the start die with it
    c.make(driver(complete(json!({}))), Make::default());
    let exit = c.first_event("exit").await;
    assert_eq!(
        exit["payload"]["data"],
        json!({ "command_id": start.cid, "code": null, "signal": "daemon_restart" })
    );
    assert_eq!(exit["fencing_token"], 7);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_newer_start_supersedes_a_start_in_its_setup() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    let runner = FakeCommandRunner::new(2, false);
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let a = setup_start(&c, sid, 1);
    c.send(&a.msg);
    c.until_true(|| runner.running_count() == 1).await;
    let b = setup_start(&c, sid, 2);
    c.send(&b.msg);
    // A's setup is cancelled; B's runs.
    c.until_true(|| runner.calls().len() == 2 && runner.running_count() == 1)
        .await;
    assert!(runner.release(SETUP));
    let started = c.first_data("started").await;
    assert_eq!(started["command_id"], json!(b.cid));
    assert_eq!(drv.starts().len(), 1);
    c.until_true(|| {
        c.data("exit")
            .iter()
            .any(|e| e["command_id"] == json!(a.cid) && e["stderr_tail"] == "superseded")
    })
    .await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_setup_waits_for_a_build_slot() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    let runner = FakeCommandRunner::new(1, false);
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let a = setup_start(&c, Uuid::new_v4(), 1);
    c.send(&a.msg);
    c.until_true(|| runner.running_count() == 1).await;
    let b = setup_start(&c, Uuid::new_v4(), 1);
    c.send(&b.msg);
    // B queues behind A's setup on the one build slot.
    c.until_true(|| {
        c.events(Some("build_slot")).iter().any(|e| {
            e["session_id"] == json!(b.sid) && e["payload"]["data"]["waiting"] == json!(true)
        })
    })
    .await;
    assert!(drv.starts().is_empty());
    runner.release_all();
    c.until_true(|| runner.running_count() == 1).await;
    runner.release_all();
    c.until_true(|| c.data("started").len() == 2).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reviewer_start_runs_no_setup() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "verdict": "pass" })));
    let runner = FakeCommandRunner::new(2, true);
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let start = c.start(
        Uuid::new_v4(),
        json!({ "worktree_setup": SETUP, "review": true, "tools": ["review"] }),
        1,
    );
    c.send(&start.msg);
    c.first_event("started").await;
    assert!(runner.calls().is_empty());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pnpm_repo_without_an_override_installs_from_its_lockfile() {
    if crate::actions::checkout::missing_manager("pnpm install", None).is_some() {
        eprintln!("skipped: pnpm is not on PATH");
        return;
    }
    let c = Ctx::new().await;
    std::fs::write(c.repo.join("package.json"), "{\"name\":\"x\"}\n").unwrap();
    std::fs::write(c.repo.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();
    git(&c.repo, &["add", "."]);
    git(&c.repo, &["commit", "--quiet", "-m", "pnpm"]);
    let drv = driver(complete(json!({ "summary": "done" })));
    let runner = FakeCommandRunner::new(2, true);
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    c.first_event("exit").await;
    let calls = runner.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].cmd, "pnpm install --frozen-lockfile");
    c.done().await;
}
