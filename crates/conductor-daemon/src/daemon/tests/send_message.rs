//! `daemon.test.ts › daemon core: send_message (ADR-0007)`.

use super::*;

fn message(sid: Uuid, target: Uuid, text: &str, token: i64) -> (OrchestratorToDaemon, Uuid) {
    let cid = Uuid::new_v4();
    (
        cmd(
            "send_message",
            sid,
            json!({ "command_id": cid, "target_command_id": target, "text": text }),
            token,
        ),
        cid,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_into_the_working_process_not_as_an_answer_and_leaves_the_u_028_nudge_state_alone() {
    // Turn 1 has no outcome → nudge. Turn 2 (the nudge) is working when the message arrives; it
    // is folded in, and the turn still ends without an outcome → no_outcome.
    let c = Ctx::new().await;
    let drv = driver(script(vec![
        vec![say("first")],
        vec![say("working"), FakeTurnAction::AwaitMessage, say("ok")],
    ]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.until_true(|| drv.last().is_some_and(|s| s.inputs().len() == 1))
        .await;
    let (m, cid) = message(sid, start.cid, "/context", 1);
    c.send(&m);
    assert_eq!(
        c.ack(cid).await,
        json!({ "command_id": cid, "accepted": true })
    );
    assert_eq!(drv.last().unwrap().messages(), ["/context"]);
    assert_eq!(drv.last().unwrap().inputs(), [NO_OUTCOME_NUDGE]); // no answer, no second nudge
    c.first_event("no_outcome").await;
    assert!(!drv.last().unwrap().exited());

    // A re-sent command is re-acked, never written twice (command_id dedupe).
    c.send(&m);
    c.until_true(|| c.acks(cid).len() == 2).await;
    assert_eq!(drv.last().unwrap().messages(), ["/context"]);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_parked_agent_parked_another_process_a_newer_process_token_or_none_no_live_process()
{
    let c = Ctx::new().await;
    let drv = driver(script(vec![vec![ask("Which DB?")]]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 5);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    let target = start.cid;
    let cases = [
        (message(sid, target, "hi", 5), "agent_parked"),
        (message(sid, Uuid::new_v4(), "hi", 5), "no_live_process"),
        (message(sid, target, "hi", 4), "no_live_process"),
        (message(Uuid::new_v4(), target, "hi", 5), "no_live_process"),
    ];
    for ((m, cid), reason) in cases {
        c.send(&m);
        let ack = c.ack(cid).await;
        assert_eq!(ack["accepted"], false);
        assert_eq!(ack["reason"], reason);
    }
    assert!(drv.last().unwrap().messages().is_empty());
    assert!(drv.last().unwrap().inputs().is_empty());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_with_no_live_process_once_the_process_completed() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.first_event("exit").await;
    let (m, cid) = message(sid, start.cid, "too late", 1);
    c.send(&m);
    assert_eq!(
        c.ack(cid).await,
        json!({ "command_id": cid, "accepted": false, "reason": "no_live_process" })
    );
    c.done().await;
}
