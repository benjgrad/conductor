//! `daemon.test.ts › daemon core: run_cmd and kill`.

use super::*;
use crate::commands::fake_runner::FakeCommandScript;

/// A run_cmd envelope at `token`.
fn run_cmd(sid: Uuid, payload: Value, token: i64) -> (OrchestratorToDaemon, Uuid) {
    let cid = Uuid::new_v4();
    let mut p =
        json!({ "command_id": cid, "workflow_state": "test", "cwd": null, "timeout_ms": null });
    for (k, v) in payload.as_object().unwrap() {
        p[k] = v.clone();
    }
    (cmd("run_cmd", sid, p, token), cid)
}

/// An ADR-0010 entry check at token 3.
fn check(
    sid: Uuid,
    command: &str,
    sha: Option<&str>,
    setup: &str,
    last: bool,
) -> OrchestratorToDaemon {
    run_cmd(
        sid,
        json!({
            "workflow_state": "implementing → waiting_external (entry)",
            "cmd": command,
            "timeout_ms": 1000,
            "require_clean": true,
            "checkout": { "sha": sha, "setup": setup, "last": last },
        }),
        3,
    )
    .0
}

/// R3: an entry check with `paths` at token 3.
fn check_paths(
    sid: Uuid,
    command: &str,
    sha: Option<&str>,
    last: bool,
    paths: &[&str],
) -> OrchestratorToDaemon {
    run_cmd(
        sid,
        json!({
            "workflow_state": "implementing → waiting_external (entry)",
            "cmd": command,
            "timeout_ms": 1000,
            "require_clean": true,
            "checkout": { "sha": sha, "setup": "", "last": last, "paths": paths },
        }),
        3,
    )
    .0
}

async fn started_session(c: &Ctx, runner: FakeCommandRunner, token: i64) -> (Uuid, PathBuf) {
    c.make(
        driver(complete(json!({}))),
        Make {
            runner: Some(runner),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), token).msg);
    c.first_event("exit").await;
    let wt = PathBuf::from(c.data("started")[0]["worktree_path"].as_str().unwrap());
    (sid, wt)
}

/// One commit on the session branch: a branch with none ahead of origin's default has nothing
/// to check, and its entry checks are not run.
fn commit_ahead(wt: &Path) {
    std::fs::write(wt.join("work.txt"), "work\n").unwrap();
    git(wt, &["add", "."]);
    git(
        wt,
        &[
            "-c",
            "user.email=t@x",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "work",
        ],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_a_command_through_the_injected_command_runner_and_reports_build_slot_cmd_exit() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, false)
        .script("npm test", FakeCommandScript::exit(1).output("FAIL\n"));
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    let (r1, id1) = run_cmd(sid, json!({ "cmd": "npm test", "timeout_ms": 1000 }), 3);
    let (r2, _) = run_cmd(sid, json!({ "cmd": "npm test", "cwd": "sub" }), 3);
    c.send(&r1);
    c.send(&r2);
    c.first_data("build_slot").await;
    assert_eq!(c.data("build_slot")[0], json!({ "waiting": true }));
    c.until_true(|| runner.running_count() == 1).await;
    runner.release("npm test");
    c.until_true(|| c.data("build_slot").len() == 2).await;
    c.until_true(|| runner.running_count() == 1).await;
    runner.release("npm test");
    c.until_true(|| c.data("cmd_exit").len() == 2).await;

    // The two commands race for the build slot, so match by command_id / cwd, not by order.
    let exit1 = c
        .data("cmd_exit")
        .into_iter()
        .find(|d| d["command_id"] == json!(id1))
        .unwrap();
    assert_eq!(
        exit1,
        json!({
            "command_id": id1,
            "exit_code": 1,
            "signal": null,
            "timed_out": false,
            "duration_ms": 0,
            "output_tail": "FAIL\n",
            // ADR-0010: the worktree HEAD the command ran on.
            "head_sha": git(&c.repo, &["rev-parse", "HEAD"]),
        })
    );
    let calls = runner.calls();
    let call1 = calls.iter().find(|x| x.cwd == wt).unwrap();
    assert_eq!(call1.session_id, sid);
    assert_eq!(call1.timeout, Some(Duration::from_millis(1000)));
    assert_eq!(call1.env["PORT"], "42000");
    assert_eq!(call1.env["CONDUCTOR_TICKET_ID"], TICKET);
    assert!(calls.iter().any(|x| x.cwd == wt.join("sub")));
    assert!(
        c.of_type("output")
            .iter()
            .any(|o| { o["payload"]["stream"] == "stdout" && o["payload"]["text"] == "FAIL\n" })
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0010_ben_2026_10_26_entry_checks_run_in_a_fresh_checkout_of_the_commit_setup_once_then_it_is_removed()
 {
    let c = Ctx::new().await;
    let runner =
        FakeCommandRunner::new(1, true).script("npm run build", FakeCommandScript::exit(0));
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt);
    let head = git(&wt, &["rev-parse", "HEAD"]);
    c.send(&check(sid, "npm run build", None, "make deps", false));
    c.until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    c.send(&check(sid, "npm test", Some(&head), "make deps", true));
    c.until_for(10_000, || c.data("cmd_exit").get(1).cloned())
        .await;
    let got: Vec<(Value, Value)> = c
        .data("cmd_exit")
        .iter()
        .map(|e| (e["exit_code"].clone(), e["head_sha"].clone()))
        .collect();
    assert_eq!(got, vec![(json!(0), json!(head)), (json!(0), json!(head))]);
    // Setup once, then both checks, all in the same fresh checkout under <root>/private.
    let cmds: Vec<String> = runner.calls().iter().map(|x| x.cmd.clone()).collect();
    assert_eq!(cmds, ["make deps", "npm run build", "npm test"]);
    let dirs: HashSet<PathBuf> = runner.calls().iter().map(|x| x.cwd.clone()).collect();
    assert_eq!(dirs.len(), 1);
    let dir = dirs.into_iter().next().unwrap();
    assert!(
        dir.to_string_lossy().starts_with(
            &c.root()
                .join("private")
                .join("check-")
                .to_string_lossy()
                .into_owned()
        ),
        "{}",
        dir.display()
    );
    assert_ne!(dir, wt);
    // The last check removed it.
    assert!(!dir.exists());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0010_a_session_kill_between_checks_removes_the_kept_checkout() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt);
    c.send(&check(sid, "npm run build", None, "", false));
    c.until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    let dir = runner.calls()[0].cwd.clone();
    assert!(dir.exists()); // kept for the next check
    // The step ends (cancel / timeout / budget): the engine's session kill.
    let kid = Uuid::new_v4();
    c.send(&kill(sid, Some(kid), None, "x", 3));
    c.ack(kid).await;
    assert!(!dir.exists());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0010_an_older_run_cleanup_never_removes_a_newer_checkout_of_the_same_session() {
    let c = Ctx::new().await;
    let runner =
        FakeCommandRunner::new(2, false).script("npm run build", FakeCommandScript::exit(1));
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt);
    let send = |command: &str, sha: Option<&str>| {
        c.send(
            &run_cmd(
                sid,
                json!({
                    "workflow_state": "x",
                    "cmd": command,
                    "timeout_ms": 5000,
                    "require_clean": true,
                    "checkout": { "sha": sha, "setup": "", "last": false },
                }),
                3,
            )
            .0,
        )
    };
    // Visit 1's check runs (and will fail) in checkout A.
    send("npm run build", None);
    c.until_true(|| !runner.calls().is_empty()).await;
    let a = runner.calls()[0].cwd.clone();
    // A newer visit: a new commit, its check in checkout B (A is replaced).
    std::fs::write(wt.join("next.txt"), "x").unwrap();
    git(&wt, &["add", "."]);
    git(
        &wt,
        &[
            "-c",
            "user.email=t@x",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "next",
        ],
    );
    let head2 = git(&wt, &["rev-parse", "HEAD"]);
    send("npm test", Some(&head2));
    c.until_true(|| runner.calls().len() >= 2).await;
    let b = runner.calls()[1].cwd.clone();
    assert_ne!(b, a);
    assert!(!a.exists());
    // Visit 1's check now fails: its cleanup must not touch checkout B.
    runner.release("npm run build");
    c.until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert!(b.exists());
    runner.release("npm test");
    c.until_for(10_000, || c.data("cmd_exit").get(1).cloned())
        .await;
    assert!(b.exists()); // passed, not last: kept
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0010_a_failed_setup_is_reported_setup_failed_the_check_does_not_run_the_checkout_goes()
{
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true).script(
        "make deps",
        FakeCommandScript::exit(2).output("deps: no such target\n"),
    );
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt);
    c.send(&check(sid, "npm run build", None, "make deps", false));
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert_eq!(exit["exit_code"], 2);
    assert_eq!(exit["setup_failed"], true);
    assert_eq!(exit["output_tail"], "deps: no such target\n");
    assert_eq!(exit["setup_cmd"], "make deps");
    // The setup fails everywhere here, so it fails on the base's tip too: conductor's config.
    assert_eq!(exit["setup_on_base"], "fail");
    assert!(exit["base_ref"].is_string());
    // The branch's setup, then the base probe's; the check never ran and both checkouts are gone.
    let cmds: Vec<String> = runner.calls().iter().map(|x| x.cmd.clone()).collect();
    assert_eq!(cmds, ["make deps", "make deps"]);
    for x in runner.calls() {
        assert!(!x.cwd.exists());
    }
    c.done().await;
}

/// A real git worktree and clone (the probe's fetch and checkout are what's under test); the
/// setup itself is the fake runner, decided by what its checkout contains.
async fn setup_probe(c: &Ctx, prepare: impl FnOnce(&Path)) -> (Value, FakeCommandRunner) {
    let runner = FakeCommandRunner::new(1, true).script_by("make deps", |o| {
        if o.cwd.join("BROKEN").exists() {
            FakeCommandScript::exit(2).output("deps: broken\n")
        } else {
            FakeCommandScript::default()
        }
    });
    let (sid, wt) = started_session(c, runner.clone(), 3).await;
    std::fs::write(wt.join("BROKEN"), "x").unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(&wt)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["add", "."]);
    git(&[
        "-c",
        "user.email=t@x",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        "b",
    ]);
    prepare(&wt);
    c.send(&check(sid, "npm run build", None, "make deps", false));
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    (exit, runner)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_setup_that_fails_only_on_the_branch_passes_on_the_base_setup_on_base_pass() {
    let c = Ctx::new().await;
    let (exit, runner) = setup_probe(&c, |_| {}).await;
    assert_eq!(exit["setup_failed"], true);
    assert_eq!(exit["setup_cmd"], "make deps");
    assert_eq!(exit["setup_on_base"], "pass");
    assert_eq!(exit["output_tail"], "deps: broken\n");
    // The branch's setup, then the base's; the check never ran and both checkouts are gone.
    let calls = runner.calls();
    let cmds: Vec<String> = calls.iter().map(|x| x.cmd.clone()).collect();
    assert_eq!(cmds, ["make deps", "make deps"]);
    assert_ne!(calls[0].cwd, calls[1].cwd);
    for x in &calls {
        assert!(!x.cwd.exists());
    }
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_origin_head_the_probe_cannot_run_setup_on_base_unknown() {
    let c = Ctx::new().await;
    let (exit, runner) = setup_probe(&c, |wt| {
        let ok = std::process::Command::new("git")
            .args(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"])
            .current_dir(wt)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    })
    .await;
    assert_eq!(exit["setup_failed"], true);
    assert_eq!(exit["setup_on_base"], "unknown");
    let cmds: Vec<String> = runner.calls().iter().map(|x| x.cmd.clone()).collect();
    assert_eq!(cmds, ["make deps"]);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_branch_with_no_commits_ahead_of_the_default_branch_is_not_checked_and_says_so() {
    // 2026-11-06: a no-code spike's gate reported "killed by a signal" 5 min in. Now it is told
    // up front: no fresh checkout, no setup, no command.
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    let head = git(&wt, &["rev-parse", "HEAD"]);
    c.send(&check(sid, "sleep 600", None, "make deps", false));
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert_eq!(exit["exit_code"], Value::Null);
    assert_eq!(exit["no_commits"], true, "{exit}");
    assert_eq!(exit["head_sha"], json!(head));
    let why = exit["not_run"].as_str().unwrap();
    assert!(why.contains("has no commits ahead of origin/"), "{why}");
    assert!(
        exit["output_tail"]
            .as_str()
            .unwrap()
            .contains("nothing to check")
    );
    assert!(runner.calls().is_empty());
    let private = c.root().join("private");
    let left = std::fs::read_dir(&private).map_or(0, |d| d.count());
    assert_eq!(left, 0);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0010_a_require_clean_check_on_a_dirty_worktree_is_not_run_cmd_exit_reports_dirty() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    std::fs::write(wt.join("uncommitted.txt"), "x").unwrap();
    let (m, _) = run_cmd(
        sid,
        json!({
            "workflow_state": "implementing → waiting_external (entry)",
            "cmd": "npm run build",
            "timeout_ms": 1000,
            "require_clean": true,
        }),
        3,
    );
    c.send(&m);
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert_eq!(exit["exit_code"], Value::Null);
    assert_eq!(exit["head_sha"], Value::Null);
    assert_eq!(exit["dirty"], json!(["?? uncommitted.txt"]));
    assert!(
        exit["output_tail"]
            .as_str()
            .unwrap()
            .contains("?? uncommitted.txt")
    );
    assert!(runner.calls().is_empty());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_run_cmd_for_an_unknown_session_and_a_cwd_outside_the_worktree() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    let (unknown, id) = run_cmd(
        Uuid::new_v4(),
        json!({ "workflow_state": "s", "cmd": "x" }),
        1,
    );
    c.send(&unknown);
    assert_eq!(c.ack(id).await["reason"], "unknown_session");

    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("exit").await;
    let (escape, eid) = run_cmd(
        sid,
        json!({ "workflow_state": "s", "cmd": "x", "cwd": "../.." }),
        1,
    );
    c.send(&escape);
    assert_eq!(c.ack(eid).await["reason"], "invalid_cwd");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_rule_target_command_id_kills_only_that_process_null_kills_at_or_below_the_envelope_token()
 {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(2, false);
    let drv = driver(script(vec![vec![ask("q")]]));
    c.make(
        drv.clone(),
        Make {
            runner: Some(runner.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 5).msg);
    c.first_event("ask_user").await;

    // A kill aimed at another start_session is a no-op.
    c.send(&kill(
        sid,
        None,
        Some(Uuid::new_v4()),
        "superseded_start",
        5,
    ));
    // A kill under an older token can't hit the newer claim's process.
    c.send(&kill(sid, None, None, "stale_fencing_token", 4));
    wait_ms(50).await;
    assert!(!drv.last().unwrap().killed());

    // A running command at token 5 is aborted by a null-target kill at token 5.
    c.send(&run_cmd(sid, json!({ "workflow_state": "b", "cmd": "sleep" }), 5).0);
    c.until_true(|| runner.running_count() == 1).await;
    let k = Uuid::new_v4();
    c.send(&kill(sid, Some(k), None, "cancel", 5));
    c.first_event("exit").await;
    let exit = c.first_data("cmd_exit").await;
    assert!(drv.last().unwrap().killed());
    assert_eq!(exit["exit_code"], Value::Null);
    assert_eq!(exit["signal"], "SIGTERM");
    assert!(c.acks(k)[0].accepted);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_with_target_command_id_kills_the_process_that_start_spawned() {
    let c = Ctx::new().await;
    c.make(driver(script(vec![vec![ask("q")]])), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    c.send(&kill(sid, None, Some(start.cid), "ack_timeout", 1));
    c.first_event("exit").await;
    assert_eq!(
        c.data("exit")[0],
        json!({ "command_id": start.cid, "code": null, "signal": "SIGTERM" })
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r3_a_check_whose_paths_match_no_change_is_skipped_and_the_last_one_removes_the_checkout() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt); // changes work.txt only
    let head = git(&wt, &["rev-parse", "HEAD"]);
    c.send(&check(sid, "npm test", None, "", false));
    c.until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    let dir = runner.calls()[0].cwd.clone();
    assert!(dir.exists()); // kept for the next check
    c.send(&check_paths(
        sid,
        "cargo nextest run",
        Some(&head),
        true,
        &["crates/**", "Cargo.*"],
    ));
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").get(1).cloned())
        .await;
    assert_eq!(exit["exit_code"], 0, "{exit}");
    assert_eq!(exit["head_sha"], json!(head));
    assert_eq!(exit["not_run"], Value::Null);
    let why = exit["skipped"].as_str().unwrap();
    assert!(
        why.starts_with("no changes match paths: crates/**, Cargo.*"),
        "{why}"
    );
    assert!(why.contains("(diff against origin/"), "{why}");
    // Never run, and as the last check its skip removed the gate's checkout.
    let cmds: Vec<String> = runner.calls().iter().map(|x| x.cmd.clone()).collect();
    assert_eq!(cmds, ["npm test"]);
    assert!(!dir.exists());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r3_a_check_whose_paths_match_a_change_runs() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt);
    c.send(&check_paths(
        sid,
        "npm test",
        None,
        true,
        &["docs/**", "*.txt"],
    ));
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert_eq!(exit["exit_code"], 0, "{exit}");
    assert_eq!(exit["skipped"], Value::Null);
    assert_eq!(runner.calls().len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r3_td_221_forged_refs_do_not_skip_a_check_the_recorded_base_says_must_run() {
    // The agent changes crates/, commits once more, then moves origin/main past its Rust commit
    // and drops origin/HEAD: diffed against its refs, only work.txt would have changed.
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    std::fs::create_dir_all(wt.join("crates/x")).unwrap();
    std::fs::write(wt.join("crates/x/lib.rs"), "fn x() {}\n").unwrap();
    commit_ahead(&wt); // commits crates/x/lib.rs and work.txt
    let rust = git(&wt, &["rev-parse", "HEAD"]);
    std::fs::write(wt.join("work.txt"), "more\n").unwrap();
    git(&wt, &["add", "."]);
    git(
        &wt,
        &[
            "-c",
            "user.email=t@x",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "more",
        ],
    );
    git(
        &wt,
        &["update-ref", "refs/remotes/origin/main", rust.trim()],
    );
    git(&wt, &["remote", "set-head", "origin", "--delete"]);
    c.send(&check_paths(
        sid,
        "cargo nextest run",
        None,
        true,
        &["crates/**"],
    ));
    let exit = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert_eq!(exit["skipped"], Value::Null, "{exit}");
    assert_eq!(exit["exit_code"], 0, "{exit}");
    assert_eq!(runner.calls().len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r3_a_skipped_check_runs_no_setup_and_the_next_check_runs_it_first_in_the_same_checkout() {
    let c = Ctx::new().await;
    let runner = FakeCommandRunner::new(1, true);
    let (sid, wt) = started_session(&c, runner.clone(), 3).await;
    commit_ahead(&wt);
    let head = git(&wt, &["rev-parse", "HEAD"]);
    let with_setup = |cmd: &str, sha: Option<&str>, last: bool, paths: &[&str]| {
        let mut co = json!({ "sha": sha, "setup": "make deps", "last": last });
        if !paths.is_empty() {
            co["paths"] = json!(paths);
        }
        run_cmd(
            sid,
            json!({
                "workflow_state": "implementing → waiting_external (entry)",
                "cmd": cmd,
                "timeout_ms": 1000,
                "require_clean": true,
                "checkout": co,
            }),
            3,
        )
        .0
    };
    c.send(&with_setup(
        "cargo nextest run",
        None,
        false,
        &["crates/**"],
    ));
    let first = c
        .until_for(10_000, || c.data("cmd_exit").into_iter().next())
        .await;
    assert!(first["skipped"].is_string(), "{first}");
    assert!(
        runner.calls().is_empty(),
        "no setup, no command for a skipped check"
    );
    c.send(&with_setup("npm test", Some(&head), true, &[]));
    let second = c
        .until_for(10_000, || c.data("cmd_exit").get(1).cloned())
        .await;
    assert_eq!(second["exit_code"], 0, "{second}");
    let cmds: Vec<String> = runner.calls().iter().map(|x| x.cmd.clone()).collect();
    assert_eq!(cmds, ["make deps", "npm test"]);
    c.done().await;
}
