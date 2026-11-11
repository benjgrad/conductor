//! ADR-0033 P2 (MR-T12 FR-4), Rust only: `assistant_job` dispatch. The job's claude is a fake
//! `claude -p` (a node script behind `fake_bin`): the process boundary is the runner's (its own
//! tests cover it); here it only has to produce a result.

use super::*;
use crate::claude::transcript::transcript_path_for;
use crate::test_support::fake_bin::write_fake_bin;

/// Echoes its stdin back as the structured result after `delay_ms`.
fn fake_oneshot(dir: &Path, delay_ms: u64) -> String {
    let js = format!(
        r#"let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => setTimeout(() => {{
  process.stdout.write(JSON.stringify({{ type: 'result', is_error: false, structured_output: {{ input }}, total_cost_usd: 0.001 }}));
}}, {delay_ms}));
"#
    );
    write_fake_bin(dir, "fake-oneshot", &js, Platform::current())
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn job(cid: Uuid, extra: Value) -> OrchestratorToDaemon {
    let mut p = json!({
        "command_id": cid,
        "job_id": Uuid::new_v4(),
        "kind": "session_insight",
        "model": "haiku",
        "prompt": "Digest only.",
        "json_schema": { "type": "object" },
        "timeout_ms": 20_000,
    });
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    machine_msg("assistant_job", p)
}

fn make(c: &Ctx, delay_ms: u64) -> Daemon {
    let bin = fake_oneshot(&c.tmp, delay_ms);
    c.make(
        driver(complete(json!({}))),
        Make {
            claude_bin: Some(bin),
            ..Make::default()
        },
    )
}

fn results(c: &Ctx) -> Vec<Value> {
    c.of_type("assistant_result")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn register_advertises_the_assistant_job_feature() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    let reg = c.until(|| c.of_type("register").into_iter().next()).await;
    // 06 §Attachments: the daemon also downloads ticket attachments. ADR-0038: it publishes pages.
    // ADR-0043: it knows the `triage` tool alias.
    assert_eq!(
        reg["payload"]["features"],
        json!([
            "assistant_job",
            "ticket_attachments",
            "agent_attachments",
            "pages",
            "permission_mode",
            "triage"
        ])
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_is_acked_then_its_result_is_a_durable_machine_level_assistant_result() {
    let c = Ctx::new().await;
    make(&c, 0);
    c.registered_and_asked().await;
    let cid = Uuid::new_v4();
    c.send(&job(cid, json!({})));
    assert_eq!(
        c.ack(cid).await,
        json!({ "command_id": cid, "accepted": true })
    );
    let ack = &c.ack_frames(cid)[0];
    assert_eq!(ack["session_id"], Value::Null);
    assert_eq!(ack["fencing_token"], Value::Null);
    let r = c.until_for(15_000, || results(&c).into_iter().next()).await;
    assert!(r["seq"].is_i64());
    assert_eq!(r["session_id"], Value::Null);
    assert_eq!(r["payload"]["command_id"], json!(cid));
    assert_eq!(r["payload"]["result"]["input"], "Digest only.");
    assert!(r["payload"].get("error").is_none(), "{r}");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_re_sent_job_is_re_acked_and_not_re_run() {
    let c = Ctx::new().await;
    make(&c, 0);
    c.registered_and_asked().await;
    let cid = Uuid::new_v4();
    let m = job(cid, json!({}));
    c.send(&m);
    c.until_for(15_000, || results(&c).into_iter().next()).await;
    c.send(&m);
    c.until_true(|| c.acks(cid).len() == 2).await;
    assert!(c.acks(cid).iter().all(|a| a.accepted));
    wait_ms(500).await;
    assert_eq!(results(&c).len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_light_slot_queue_refuses_light_slot_busy() {
    let c = Ctx::new().await;
    // One running plus ASSISTANT_JOB_QUEUE_MAX waiting (light_slots = 1).
    make(&c, 1_500);
    c.registered_and_asked().await;
    let max = 1 + conductor_protocol::ASSISTANT_JOB_QUEUE_MAX;
    for _ in 0..max {
        let cid = Uuid::new_v4();
        c.send(&job(cid, json!({})));
        assert_eq!(c.ack(cid).await["accepted"], true);
    }
    let over = Uuid::new_v4();
    c.send(&job(over, json!({})));
    assert_eq!(
        c.ack(over).await,
        json!({ "command_id": over, "accepted": false, "reason": "light_slot_busy" })
    );
    // The first job still finishes.
    c.until_for(15_000, || results(&c).into_iter().next()).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_result_produced_while_disconnected_is_replayed_after_registered() {
    let c = Ctx::new().await;
    make(&c, 800);
    c.registered_and_asked().await;
    let cid = Uuid::new_v4();
    c.send(&job(cid, json!({})));
    c.ack(cid).await;
    // Hold the link down until the result exists: the reconnect backoff is 20-100 ms, so drop
    // it repeatedly while the job runs.
    let d = &c.orch;
    for _ in 0..8 {
        d.drop_socket();
        wait_ms(100).await;
    }
    let r = c.until_for(15_000, || results(&c).into_iter().next()).await;
    assert!(r["seq"].is_i64());
    assert_eq!(r["payload"]["command_id"], json!(cid));
    assert!(c.of_type("register").len() >= 2);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_job_holds_no_session_slot() {
    let c = Ctx::new().await;
    let n = Arc::new(Mutex::new(0));
    c.orch.set_work_reply(move |_| {
        *n.lock().unwrap() += 1;
        Some(machine_msg("retry_after", json!({ "ms": 50 })))
    });
    make(&c, 1_500);
    c.registered_and_asked().await;
    let cid = Uuid::new_v4();
    c.send(&job(cid, json!({})));
    c.ack(cid).await;
    let after = c.of_type("request_work").len();
    c.until_true(|| c.of_type("request_work").len() > after + 1)
        .await;
    assert!(results(&c).is_empty(), "the job is still running");
    let rw = c.of_type("request_work");
    assert_eq!(rw.last().unwrap()["payload"]["free_slots"], 2);
    let hb = c.of_type("heartbeat");
    assert_eq!(hb.last().unwrap()["payload"]["sessions"], json!([]));
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_transcript_is_found_from_the_store_by_session_id() {
    let c = Ctx::new().await;
    let fake = driver(complete(json!({})));
    let bin = fake_oneshot(&c.tmp, 0);
    c.make(
        fake.clone(),
        Make {
            claude_bin: Some(bin),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("exit").await;
    let wt = PathBuf::from(c.data("started")[0]["worktree_path"].as_str().unwrap());
    let file =
        transcript_path_for(&c.claude_dir(), &wt, &fake.starts()[0].claude_session_id).unwrap();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/transcript.jsonl"),
        &file,
    )
    .unwrap();

    let cid = Uuid::new_v4();
    c.send(&job(
        cid,
        json!({ "transcript": { "session_id": sid, "max_chars": 100_000 } }),
    ));
    let r = c.until_for(15_000, || results(&c).into_iter().next()).await;
    let input = r["payload"]["result"]["input"].as_str().unwrap();
    assert!(input.starts_with("Digest only."));
    assert!(
        input.contains("Created greeting.txt and committed it."),
        "{input}"
    );

    // A session this daemon never ran: no transcript, an error result.
    let other = Uuid::new_v4();
    c.send(&job(
        other,
        json!({ "transcript": { "session_id": Uuid::new_v4(), "max_chars": 1000 } }),
    ));
    let r = c
        .until_for(15_000, || {
            results(&c)
                .into_iter()
                .find(|x| x["payload"]["command_id"] == json!(other))
        })
        .await;
    assert_eq!(r["payload"]["error"], "no_transcript");
    c.done().await;
}
