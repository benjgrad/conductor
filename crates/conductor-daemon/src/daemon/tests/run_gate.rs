//! R4: `run_gate` from the daemon core: a worker gets the handler (a reviewer doesn't), and a
//! dirty worktree is refused before anything is sent. A real git worktree, because `git status`
//! (check_clean) is the boundary under test.

use super::*;
use crate::claude::outcome_server::RunGateRequest;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_gets_run_gate_which_refuses_uncommitted_changes_before_asking_the_server() {
    let c = Ctx::new().await;
    let drv = driver(script(vec![vec![FakeTurnAction::AwaitMessage]]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.until_true(|| !drv.starts().is_empty()).await;
    let opts = drv.starts()[0].clone();
    let hook = opts.run_gate.clone().expect("a worker gets run_gate");
    let call = |t: &str| {
        (hook.0)(RunGateRequest {
            transition: t.into(),
        })
    };

    // Dirty: refused with the files, and the server is never asked.
    std::fs::write(opts.cwd.join("wip.txt"), "not committed").unwrap();
    let dirty = call("ship")
        .await
        .expect("a refusal is an answer, not an error");
    assert!(
        dirty.starts_with("Not run: you have uncommitted changes. Commit them first"),
        "{dirty}"
    );
    assert!(dirty.contains("wip.txt"), "{dirty}");

    // Clean: now it asks the server (the fake orchestrator doesn't serve it: an error).
    std::fs::remove_file(opts.cwd.join("wip.txt")).unwrap();
    let asked = call("ship").await.unwrap_err();
    assert!(asked.contains("conductor server"), "{asked}");

    // A reviewer never gets it.
    c.send(
        &c.start(
            Uuid::new_v4(),
            json!({ "prompt": "# Requirements review", "tools": ["review"], "review": true }),
            1,
        )
        .msg,
    );
    c.until_true(|| drv.starts().len() >= 2).await;
    assert!(drv.starts()[1].run_gate.is_none());
}
