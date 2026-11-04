//! `daemon.test.ts › daemon core: run_action (ADR-0010 open_pr)`.

use super::*;
use crate::platform::workflow_shell;

/// ADR-0010 open_pr's fake gh: `repo view` → main, `pr view` → none, `pr create` → a PR URL.
pub fn fake_gh(script_lines: &[&str]) -> GhCommand {
    GhCommand {
        cmd: workflow_shell(Platform::current())
            .unwrap()
            .file
            .to_string_lossy()
            .into_owned(),
        args: vec!["-c".into(), script_lines.join("\n"), "gh".into()],
    }
}

fn open_pr_action(sid: Uuid, over: Value, token: i64) -> (OrchestratorToDaemon, Uuid) {
    let cid = Uuid::new_v4();
    let mut p = json!({
        "command_id": cid,
        "workflow_state": "x",
        "target_state": "y",
        "action": "open_pr",
        "idempotency_key": "k",
        "args": {},
        "branch": "b",
        "expected_sha": null,
    });
    for (k, v) in over.as_object().unwrap() {
        p[k] = v.clone();
    }
    (cmd("run_action", sid, p, token), cid)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acks_pushes_the_session_branch_to_origin_opens_the_pr_with_gh_reports_action_result() {
    let c = Ctx::new().await;
    c.make(
        driver(complete(json!({}))),
        Make {
            gh: Some(fake_gh(&[
                "if [ \"$1\" = --version ]; then echo \"gh version 2.103.3 (2025-01-01)\"; exit 0; fi",
                "if [ \"$1\" = repo ]; then echo main; exit 0; fi",
                "if [ \"$2\" = view ]; then exit 1; fi",
                "echo https://github.com/benjgrad/fixture-app/pull/9",
            ])),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 4).msg);
    c.first_event("exit").await;
    let (action, id) = open_pr_action(
        sid,
        json!({
            "workflow_state": "implementing → waiting_external (entry)",
            "target_state": "waiting_external",
            "idempotency_key": format!("{sid}:waiting_external:1"),
            "args": { "title": "Add /health", "body": "Opened by conductor." },
            "branch": "ignored/the-daemon-uses-its-own-record",
            // The worktree was branched from the fixture's HEAD and has no new commits.
            "expected_sha": git(&c.repo, &["rev-parse", "HEAD"]),
        }),
        4,
    );
    c.send(&action);
    assert_eq!(c.ack(id).await["accepted"], true);
    // Several git / gh subprocesses: allow for a loaded test machine.
    let res = c
        .until_for(15_000, || c.data("action_result").into_iter().next())
        .await;
    assert_eq!(
        res,
        json!({
            "command_id": id,
            "action": "open_pr",
            "result": { "pr_url": "https://github.com/benjgrad/fixture-app/pull/9" },
            "error": null,
        })
    );
    // The session branch (the daemon's own record) is now on the origin repo.
    git(
        &c.repo,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", branch_for(sid)),
        ],
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_run_action_for_an_unknown_session() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    let (action, id) = open_pr_action(Uuid::new_v4(), json!({}), 1);
    c.send(&action);
    assert_eq!(c.ack(id).await["reason"], "unknown_session");
    c.done().await;
}
