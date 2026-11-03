//! `daemon.test.ts › daemon core: ADR-0011 transitions`.

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passes_start_session_transitions_to_the_driver_and_forwards_transition_reason() {
    let c = Ctx::new().await;
    let transitions = json!([
        { "name": "plan_ready", "when": "The plan is complete.", "question": false },
        { "name": "scope_changed", "when": null, "question": true },
    ]);
    let drv = driver(script(vec![vec![
        // Refused once (the outcome-server nudge).
        FakeTurnAction::CompleteState {
            result: Default::default(),
            transition: Some("nope".into()),
            reason: None,
        },
        FakeTurnAction::CompleteState {
            result: json!({ "plan": "p" }).as_object().unwrap().clone(),
            transition: Some("plan_ready".into()),
            reason: Some("All files named.".into()),
        },
    ]]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    c.send(
        &c.start(Uuid::new_v4(), json!({ "transitions": transitions }), 1)
            .msg,
    );
    let done = c.first_data("complete_state").await;
    assert_eq!(
        serde_json::to_value(drv.starts()[0].transitions.clone().unwrap()).unwrap(),
        transitions
    );
    assert_eq!(
        done,
        json!({ "result": { "plan": "p" }, "transition": "plan_ready", "reason": "All files named." })
    );
    assert_eq!(c.data("complete_state").len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_start_session_no_transitions_forwards_complete_state_without_the_fields() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "ok": true })));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    assert_eq!(
        c.first_data("complete_state").await,
        json!({ "result": { "ok": true } })
    );
    assert_eq!(drv.starts()[0].transitions, None);
    c.done().await;
}
