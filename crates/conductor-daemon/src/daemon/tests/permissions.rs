//! `daemon.test.ts › daemon core: ADR-0023 permission prompts`.

use super::*;

const REQ: &str = "5b0c3a52-0f7e-4b8e-9b51-3d2f6f0e7a11";

fn held() -> FakeClaudeScript {
    script(vec![vec![
        FakeTurnAction::Permission {
            request_id: REQ.into(),
            tool: "Bash".into(),
            input: serde_json::from_value(json!({ "command": "pnpm i" })).unwrap(),
        },
        ask("park here"),
    ]])
}

fn decision(sid: Uuid, over: Value) -> (OrchestratorToDaemon, Uuid) {
    let cid = Uuid::new_v4();
    let mut p =
        json!({ "command_id": cid, "request_id": REQ, "behavior": "allow", "scope": "once" });
    for (k, v) in over.as_object().unwrap() {
        p[k] = v.clone();
    }
    (cmd("permission_decision", sid, p, 1), cid)
}

async fn started(c: &Ctx, drv: Arc<FakeClaudeDriver>) -> (Daemon, Uuid, Value) {
    let d = c.make(drv, Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    let req = c
        .until(|| c.of_type("permission_request").into_iter().next())
        .await;
    (d, sid, req)
}

fn reply(drv: &FakeClaudeDriver) -> Option<Value> {
    drv.last()
        .unwrap()
        .permission_replies()
        .get(REQ)
        .map(|r| serde_json::to_value(r).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sends_a_durable_permission_request_on_the_session_envelope() {
    let c = Ctx::new().await;
    let (_, sid, req) = started(&c, driver(held())).await;
    assert_eq!(req["session_id"], json!(sid));
    assert_eq!(req["fencing_token"], 1);
    assert!(req["seq"].is_i64());
    let p = &req["payload"];
    assert_eq!(p["request_id"], REQ);
    assert_eq!(p["session_id"], json!(sid));
    assert_eq!(p["tool"], "Bash");
    assert_eq!(p["input"], json!({ "command": "pnpm i" }));
    // seq is shared with session_events: strictly after `started`.
    let started_seq = c.events(Some("started"))[0]["seq"].as_i64().unwrap();
    assert!(req["seq"].as_i64().unwrap() > started_seq);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_decision_resolves_the_held_call_once_a_second_decision_is_accepted_and_ignored_unknown_is_refused()
 {
    let c = Ctx::new().await;
    let drv = driver(held());
    let (_, sid, _) = started(&c, drv.clone()).await;
    let (allow, aid) = decision(sid, json!({ "scope": "always", "rule": "Bash(pnpm i)" }));
    c.send(&allow);
    assert_eq!(
        c.ack(aid).await,
        json!({ "command_id": aid, "accepted": true })
    );
    let r = reply(&drv).unwrap();
    assert_eq!(r["behavior"], "allow");
    assert_eq!(r["updatedInput"], json!({ "command": "pnpm i" }));
    assert_eq!(
        r["updatedPermissions"],
        json!([{
            "type": "addRules",
            "rules": [{ "toolName": "Bash", "ruleContent": "pnpm i" }],
            "behavior": "allow",
            "destination": "session",
        }])
    );

    // The same command again: re-acked from the dedupe store, not re-run.
    c.send(&allow);
    c.until_true(|| c.acks(aid).len() == 2).await;

    // Another decision (another command_id) for the resolved request: accepted, ignored.
    let (late, lid) = decision(sid, json!({ "behavior": "deny" }));
    c.send(&late);
    assert_eq!(c.ack(lid).await["accepted"], true);
    assert_eq!(reply(&drv).unwrap()["behavior"], "allow");

    // A request this daemon doesn't hold.
    let (unknown, uid) = decision(sid, json!({ "request_id": Uuid::new_v4() }));
    c.send(&unknown);
    assert_eq!(
        c.ack(uid).await,
        json!({ "command_id": uid, "accepted": false, "reason": "unknown_permission_request" })
    );

    // No live process for the session at all.
    let (none, nid) = decision(Uuid::new_v4(), json!({}));
    c.send(&none);
    assert_eq!(c.ack(nid).await["reason"], "unknown_permission_request");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deny_carries_the_human_note_to_claude() {
    let c = Ctx::new().await;
    let drv = driver(held());
    let (_, sid, _) = started(&c, drv.clone()).await;
    let (deny, id) = decision(
        sid,
        json!({ "behavior": "deny", "message": "not on this machine" }),
    );
    c.send(&deny);
    c.ack(id).await;
    assert_eq!(
        reply(&drv).unwrap(),
        json!({
            "behavior": "deny",
            "message": "Permission denied by a human on the board: not on this machine",
        })
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_server_s_protocol_error_naming_the_request_denies_the_held_call_at_once() {
    let c = Ctx::new().await;
    let drv = driver(held());
    let (_, _, req) = started(&c, drv.clone()).await;
    c.send(&machine_msg(
        "protocol_error",
        json!({ "code": "invalid_message", "message": "unknown type", "ref_msg_id": req["msg_id"] }),
    ));
    let r = c.until(|| reply(&drv)).await;
    assert_eq!(
        r,
        json!({ "behavior": "deny", "message": PERMISSION_UNSUPPORTED_SERVER })
    );
    // An unrelated protocol_error changes nothing.
    c.send(&machine_msg(
        "protocol_error",
        json!({ "code": "internal", "message": "x", "ref_msg_id": Uuid::new_v4() }),
    ));
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_request_is_replayed_after_a_socket_drop_durable_seq_same_msg_id() {
    let c = Ctx::new().await;
    let drv = driver(held());
    let (_, _, req) = started(&c, drv.clone()).await;
    let seq = req["seq"].as_i64().unwrap();
    c.orch.set_last_seq(Some(seq - 1)); // the orchestrator never processed it
    c.orch.drop_socket();
    c.until_true(|| c.of_type("register").len() == 2).await;
    let replays = c
        .until(|| {
            let all = c.of_type("permission_request");
            (all.len() == 2).then_some(all)
        })
        .await;
    assert_eq!(replays[1]["msg_id"], req["msg_id"]);
    assert_eq!(replays[1]["seq"], req["seq"]);
    assert_eq!(drv.last().unwrap().pending_permissions(), [REQ]); // still held
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_shutdown_denies_every_held_call() {
    let c = Ctx::new().await;
    let drv = driver(held());
    let (d, _, _) = started(&c, drv.clone()).await;
    d.stop(true);
    assert_eq!(
        reply(&drv).unwrap(),
        json!({ "behavior": "deny", "message": PERMISSION_SHUTDOWN })
    );
    c.done().await;
}
