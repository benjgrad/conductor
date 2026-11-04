//! `conductor-daemon run` as the real binary (TD-211, wired in MR-T15): what is under test is the
//! wiring in `main.rs` (config → outcome server → CLI driver → daemon core → exit code), which no
//! in-process test reaches. The daemon core's behaviour is tested in `src/daemon/tests`. One case,
//! on purpose: it spawns the binary and waits out its kill grace (5 s) on the way out.

use conductor_daemon::test_support::fake_orchestrator::FakeOrchestrator;
use conductor_protocol::CLOSE_REVOKED;
use std::process::Stdio;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn run_registers_with_assistant_job_and_exits_78_on_a_fatal_close() {
    let o = FakeOrchestrator::start().await.unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut cmd = tokio::process::Command::new(assert_cmd::cargo::cargo_bin("conductor-daemon"));
    cmd.arg("run")
        .env_clear()
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("CONDUCTOR_ROOT", home.path().join("root"))
        .env("CONDUCTOR_ORCHESTRATOR_URL", o.url())
        .env("CONDUCTOR_MACHINE_ID", "m-run")
        .env("CONDUCTOR_BUILD_SHA", "abc1234")
        // No Claude here: the version probe and the permission-prompt probe fail fast.
        .env("CONDUCTOR_CLAUDE_BIN", home.path().join("no-claude"))
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for k in [
        "SystemRoot",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    let child = cmd.spawn().unwrap();

    let register = o
        .until(
            || o.of_type("register").into_iter().next(),
            Some(Duration::from_secs(30)),
        )
        .await
        .unwrap();
    let register = serde_json::to_value(&register).unwrap();
    let payload = register.get("payload").unwrap_or(&register);
    assert_eq!(payload["machine_id"], "m-run", "{register}");
    assert_eq!(
        payload["daemon_version"],
        format!("{}+abc1234", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(payload["features"], serde_json::json!(["assistant_job"]));

    o.close_with(CLOSE_REVOKED);
    let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .expect("the daemon exits after a fatal close")
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(78), "{stderr}");
    assert!(stderr.contains("m-run →"), "{stderr}");
}
