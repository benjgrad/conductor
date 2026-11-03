//! `daemon.test.ts › daemon core: misc`.

use super::*;
use crate::system_prompt::CONDUCTOR_INSTRUCTIONS;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_exit_daemon_restart_for_a_process_that_died_with_the_previous_daemon() {
    let c = Ctx::new().await;
    let d1 = c.make(driver(script(vec![vec![ask("q")]])), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 7);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    d1.stop(false); // simulate a crash: no exit event from the driver
    c.make(driver(complete(json!({}))), Make::default());
    let exit = c.first_event("exit").await;
    assert_eq!(
        exit["payload"]["data"],
        json!({ "command_id": start.cid, "code": null, "signal": "daemon_restart" })
    );
    assert_eq!(exit["fencing_token"], 7);
    assert_eq!(exit["session_id"], json!(sid));
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn omits_the_claude_md_section_when_the_worktree_has_none() {
    let c = Ctx::with_repo(false).await;
    let drv = driver(complete(json!({})));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    c.first_event("exit").await;
    assert_eq!(
        drv.starts()[0].append_system_prompt.as_deref(),
        Some(CONDUCTOR_INSTRUCTIONS)
    );
    let file = c.root().join("state").join("daemon.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    assert_eq!(v["lastSeq"], 4);
    c.done().await;
}
