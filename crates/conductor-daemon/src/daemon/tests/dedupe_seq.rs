//! `daemon.test.ts › daemon core: command_id dedupe and seq`.

use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_acks_a_re_sent_command_without_re_running_it_also_after_a_daemon_restart() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({})));
    let d1 = c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let start = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&start.msg);
    c.first_event("exit").await;
    c.send(&start.msg);
    c.until_true(|| c.acks(start.cid).len() == 2).await;
    assert_eq!(drv.starts().len(), 1);

    d1.stop(true);
    let drv2 = driver(complete(json!({})));
    c.make(drv2.clone(), Make::default());
    c.until_true(|| c.of_type("register").len() == 2).await;
    c.until_true(|| c.of_type("request_work").len() >= 2).await;
    c.send(&start.msg);
    c.until_true(|| c.acks(start.cid).len() == 3).await;
    assert!(c.acks(start.cid).iter().all(|a| a.accepted));
    assert!(drv2.starts().is_empty());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn next_seq_max_local_1_registered_last_seq_1() {
    let c = Ctx::new().await;
    let d1 = c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    c.first_event("exit").await;
    assert_eq!(c.events(None).last().unwrap()["seq"], 4);
    d1.stop(true);

    // The orchestrator is ahead (e.g. local state was restored from an old backup).
    c.orch.set_last_seq(Some(100));
    c.make(driver(complete(json!({}))), Make::default());
    c.until_true(|| c.of_type("register").len() == 2 && c.of_type("request_work").len() >= 2)
        .await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    c.until_true(|| c.events(Some("exit")).len() == 2).await;
    let seqs: Vec<i64> = c.events(None)[5..]
        .iter()
        .map(|e| e["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, [101, 102, 103, 104, 105]);
    assert_eq!(
        DaemonStore::for_root(&c.root()).unwrap().last_seq(),
        Some(105)
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn buffers_session_events_while_disconnected_and_replays_those_after_registered_last_seq() {
    let c = Ctx::new().await;
    let drv = driver(script(vec![
        vec![ask("q?")],
        vec![complete_with(json!({ "ok": true }))],
    ]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    // spend follows ask_user; wait for both so the count doesn't race it.
    c.until_true(|| !c.events(Some("ask_user")).is_empty() && !c.events(Some("spend")).is_empty())
        .await;
    let before = c.events(None).len(); // started, claude_session_id, ask_user, spend
    assert_eq!(before, 4);

    // Pretend the orchestrator only processed up to seq 1, and hold the reconnect until after
    // the agent has produced more events while disconnected.
    c.orch.set_last_seq(Some(1));
    c.orch.drop_socket();
    // Simulates progress while offline: complete_state, spend, exit.
    drv.last().unwrap().send_input("go").unwrap();
    c.until_true(|| c.of_type("register").len() == 2).await;
    c.first_event("exit").await;
    let replayed: Vec<(i64, String)> = c.events(None)[before..]
        .iter()
        .map(|e| {
            (
                e["seq"].as_i64().unwrap(),
                e["payload"]["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    // seq 2,3 (ask_user, spend) replayed, then the offline events get 4.. in order.
    let want: Vec<(i64, String)> = [
        (2, "ask_user"),
        (3, "spend"),
        (4, "complete_state"),
        (5, "spend"),
        (6, "exit"),
    ]
    .into_iter()
    .map(|(s, k)| (s, k.to_string()))
    .collect();
    assert_eq!(replayed, want);
    c.done().await;
}
