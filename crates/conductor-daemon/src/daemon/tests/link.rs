//! `daemon.test.ts › daemon core: link`.

use super::*;
use conductor_protocol::CLOSE_REVOKED;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registers_then_sends_heartbeat_inventory_repo_inventory_and_request_work() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    let types = c.types();
    assert_eq!(
        types[..5],
        [
            "register",
            "heartbeat",
            "inventory",
            "repo_inventory",
            "request_work"
        ]
    );
    let reg = &c.of_type("register")[0]["payload"];
    assert_eq!(reg["machine_id"], "test-machine");
    assert_eq!(reg["enrollment_token"], Value::Null);
    assert!(reg.as_object().unwrap().contains_key("enrollment_token"));
    assert_eq!(reg["max_sessions"], 2);
    assert_eq!(reg["max_concurrent_builds"], 2);
    assert_eq!(reg["claude_code_version"], "2.1.308");
    assert_eq!(reg["protocol_version"], 2);
    assert_eq!(conductor_protocol::PROTOCOL_VERSION, 2);
    assert_eq!(reg["daemon_version"], DAEMON_VERSION);
    // Local mode: no credential header.
    assert_eq!(c.orch.auth_headers(), vec![None]);
    let hb = &c.of_type("heartbeat")[0]["payload"];
    assert_eq!(hb["mem_free_mb"], 8000);
    assert_eq!(hb["sessions"], json!([]));
    let rw = &c.of_type("request_work")[0]["payload"];
    assert_eq!(rw["free_slots"], 2);
    assert_eq!(rw["mem_free_mb"], 8000);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn register_daemon_version_carries_conductor_build_sha() {
    let c = Ctx::new().await;
    c.make(
        driver(complete(json!({}))),
        Make {
            env: vec![("CONDUCTOR_BUILD_SHA", "abc1234".into())],
            ..Make::default()
        },
    );
    let reg = c.until(|| c.of_type("register").into_iter().next()).await;
    assert_eq!(
        reg["payload"]["daemon_version"],
        format!("{DAEMON_VERSION}+abc1234")
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enrolled_the_enrolled_machine_id_the_bearer_header_no_enrollment_token() {
    let c = Ctx::new().await;
    let root = c.root();
    crate::credential::write_credential(
        &root,
        &crate::credential::MachineCredential {
            url: "http://127.0.0.1".into(),
            machine_id: "m-enrolled".into(),
            credential: "secret-cred".into(),
        },
        false,
    )
    .unwrap();
    c.make(
        driver(complete(json!({}))),
        Make {
            root: Some(root),
            ..Make::default()
        },
    );
    let reg = c.until(|| c.of_type("register").into_iter().next()).await;
    assert_eq!(reg["payload"]["machine_id"], "m-enrolled");
    assert!(
        !reg["payload"]
            .as_object()
            .unwrap()
            .contains_key("enrollment_token")
    );
    assert_eq!(reg["payload"]["protocol_version"], 2);
    assert_eq!(
        c.orch.auth_headers(),
        vec![Some("Bearer secret-cred".to_string())]
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_4001_revoked_stops_the_link_and_calls_on_fatal_no_re_register() {
    let c = Ctx::new().await;
    let fatal = Arc::new(Mutex::new(Vec::<u16>::new()));
    let f = fatal.clone();
    let d = c.make(
        driver(complete(json!({}))),
        Make {
            on_fatal: Some(Arc::new(move |code: u16, _: &str| {
                f.lock().unwrap().push(code)
            })),
            ..Make::default()
        },
    );
    c.until_true(|| d.is_registered()).await;
    c.orch.close_with(CLOSE_REVOKED);
    c.until_true(|| fatal.lock().unwrap().len() == 1).await;
    wait_ms(300).await; // reconnect backoff is 20-100 ms here
    assert_eq!(*fatal.lock().unwrap(), vec![CLOSE_REVOKED]);
    assert!(!d.is_registered());
    assert_eq!(c.of_type("register").len(), 1);
    assert_eq!(c.orch.connections(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnects_with_backoff_after_the_socket_drops_and_registers_again() {
    let c = Ctx::new().await;
    let d = c.make(driver(complete(json!({}))), Make::default());
    c.until_true(|| d.is_registered()).await;
    c.orch.drop_socket();
    c.until_true(|| c.of_type("register").len() == 2 && c.orch.connections() == 2)
        .await;
    c.until_true(|| d.is_registered()).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn asks_for_work_again_after_retry_after() {
    let c = Ctx::new().await;
    let n = Arc::new(Mutex::new(0));
    c.orch.set_work_reply(move |_| {
        let mut n = n.lock().unwrap();
        *n += 1;
        (*n == 1).then(|| machine_msg("retry_after", json!({ "ms": 30 })))
    });
    c.make(driver(complete(json!({}))), Make::default());
    c.until_true(|| c.of_type("request_work").len() >= 2).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn logs_no_work_s_reason_only_when_it_changes_m2_t36() {
    let c = Ctx::new().await;
    let reasons = ["max_sessions", "max_sessions", "no_ready_ticket"];
    let n = Arc::new(Mutex::new(0usize));
    c.orch.set_work_reply(move |_| {
        let mut n = n.lock().unwrap();
        let r = reasons.get(*n).copied();
        *n += 1;
        r.map(|reason| machine_msg("no_work", json!({ "reason": reason })))
    });
    let logs = Logs::default();
    c.make(
        driver(complete(json!({}))),
        Make {
            env: vec![("CONDUCTOR_WORK_POLL_MS", "20".into())],
            logs: Some(logs.clone()),
            ..Make::default()
        },
    );
    c.until_true(|| c.of_type("request_work").len() >= 4).await;
    let lines: Vec<String> = logs
        .lines()
        .into_iter()
        .filter(|l| l.starts_with("no work: "))
        .collect();
    assert_eq!(lines, ["no work: max_sessions", "no work: no_ready_ticket"]);
    c.done().await;
}
