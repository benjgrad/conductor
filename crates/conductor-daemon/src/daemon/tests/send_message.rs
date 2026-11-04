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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_ends_with_background_jobs_running_is_not_nudged_and_takes_messages() {
    // ADR-0035: the agent starts a job in the background and ends its turn. The daemon waits (no
    // nudge, not parked), a message is delivered, and the CLI's own turn when the job finishes
    // carries on. Once no job runs, an outcome-less turn is nudged as before (U-028).
    let c = Ctx::new().await;
    let bg = |n| FakeTurnAction::Emit(DriverEvent::BackgroundTasks { running: n });
    let drv = driver(script(vec![
        vec![bg(1), say("tests running in the background")],
        vec![say("2+2=4")],
        vec![bg(0), say("tests passed")],
        vec![complete_with(json!({ "ok": true }))],
    ]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    let waiting = |c: &Ctx| {
        c.of_type("output").iter().any(|o| {
            o["payload"]["text"]
                .as_str()
                .is_some_and(|t| t.contains("with 1 background job(s) running"))
        })
    };
    c.until_true(|| waiting(&c)).await;
    assert!(drv.last().unwrap().inputs().is_empty()); // no nudge

    // Not parked: a message is accepted and written; the idle CLI runs it as a turn.
    let (m, cid) = message(sid, start.cid, "what is 2+2?", 1);
    c.send(&m);
    assert_eq!(
        c.ack(cid).await,
        json!({ "command_id": cid, "accepted": true })
    );
    assert_eq!(drv.last().unwrap().messages(), ["what is 2+2?"]);
    drv.last().unwrap().cli_turn("what is 2+2?");
    c.until_true(|| {
        c.of_type("output")
            .iter()
            .any(|o| o["payload"]["text"] == "2+2=4")
    })
    .await;
    drv.last().unwrap().idle().await;
    assert!(drv.last().unwrap().inputs().is_empty()); // the job still runs: still no nudge

    // The job finishes: the CLI's own turn ends with no job left and no outcome → nudged.
    drv.last().unwrap().cli_turn("<task-notification>");
    c.until_true(|| drv.last().unwrap().inputs() == [NO_OUTCOME_NUDGE])
        .await;
    c.first_event("complete_state").await;
    c.first_event("exit").await;
    assert!(c.events(Some("no_outcome")).is_empty());
    c.done().await;
}
