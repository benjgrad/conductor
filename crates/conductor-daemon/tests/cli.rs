//! The `conductor-daemon` command line (MR-T13a), run as the real binary: what is under test is the
//! process boundary (argv parsing, stdout/stderr, exit codes). The subcommands' behaviour is
//! tested in-process in `src/commands/*/tests.rs`; these are kept few on purpose.

use assert_cmd::Command;
use conductor_daemon::test_support::fake_orchestrator::FakeOrchestrator;
use predicates::prelude::*;
use std::path::Path;

fn daemon(home: &Path) -> Command {
    let mut c = Command::cargo_bin("conductor-daemon").unwrap();
    c.env_clear()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("CONDUCTOR_ROOT", home.join("root"))
        .env("PATH", std::env::var_os("PATH").unwrap_or_default());
    // Windows processes expect these.
    for k in ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    c
}

#[test]
fn help_prints_the_usage_on_stdout() {
    let t = tempfile::tempdir().unwrap();
    for arg in ["help", "--help", "-h"] {
        daemon(t.path())
            .arg(arg)
            .assert()
            .code(0)
            .stdout(predicate::str::starts_with("usage: conductor-daemon [run]"))
            .stdout(predicate::str::contains("conductor-daemon enroll --url"))
            .stdout(predicate::str::contains("conductor-daemon config show"))
            .stdout(predicate::str::contains("conductor-daemon service install"))
            .stdout(predicate::str::contains("conductor-daemon rescan"));
    }
}

#[test]
fn version_prints_the_version_alone() {
    let t = tempfile::tempdir().unwrap();
    daemon(t.path())
        .arg("--version")
        .env("CONDUCTOR_BUILD_SHA", "abc123")
        .assert()
        .code(0)
        .stdout(format!("{}+abc123\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn an_unknown_command_is_usage_2() {
    let t = tempfile::tempdir().unwrap();
    daemon(t.path())
        .arg("bogus")
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "[conductor-daemon] unknown command: bogus",
        ))
        .stderr(predicate::str::contains("usage: conductor-daemon"));
    daemon(t.path()).args(["hook", "frob"]).assert().code(2);
}

/// `run` as a real process against the fake orchestrator: the exit codes and signals are the
/// process boundary under test (the logic is tested in-process in `src/commands/run/tests.rs`).
/// Each takes the daemon's 5 s kill grace before it exits, as TS.
fn run_daemon_cmd(home: &Path, url: &str) -> std::process::Command {
    // win32: the daemon makes its root private, which needs a private parent (ADR-0024).
    conductor_daemon::platform::mkdir_private(home).unwrap();
    let mut c = std::process::Command::new(assert_cmd::cargo::cargo_bin("conductor-daemon"));
    c.env_clear()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("CONDUCTOR_ROOT", home.join("root"))
        .env("CONDUCTOR_ORCHESTRATOR_URL", url)
        .env("CONDUCTOR_MACHINE_ID", "cli-test")
        // No claude: both startup probes fail at once.
        .env("CONDUCTOR_CLAUDE_BIN", home.join("no-such-claude"))
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    for k in ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    c
}

/// Wait (off the runtime) for the child to exit, at most 30 s.
async fn exit_of(child: std::process::Child) -> (Option<i32>, String) {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking(move || child.wait_with_output().unwrap()),
    )
    .await
    .expect("the daemon exits")
    .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_exits_78_when_the_orchestrator_refuses_the_machine() {
    let orch = FakeOrchestrator::start().await.unwrap();
    orch.set_reject_upgrade(Some(401));
    let t = tempfile::tempdir().unwrap();
    let child = run_daemon_cmd(t.path(), &orch.url()).spawn().unwrap();
    let (code, stderr) = exit_of(child).await;
    assert_eq!(code, Some(78), "{stderr}");
    assert!(
        stderr.contains("[conductor-daemon] cli-test → ws://"),
        "{stderr}"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_registers_and_exits_0_on_sigterm() {
    let orch = FakeOrchestrator::start().await.unwrap();
    let t = tempfile::tempdir().unwrap();
    let child = run_daemon_cmd(t.path(), &orch.url()).spawn().unwrap();
    let pid = nix::unistd::Pid::from_raw(child.id() as i32);
    let register = orch
        .until(
            || orch.of_type("register").into_iter().next(),
            Some(std::time::Duration::from_secs(20)),
        )
        .await
        .unwrap();
    // ADR-0033 P2: the binary advertises the assistant job (the workflow advisor's insights);
    // 06 §Attachments: and that it downloads ticket attachments.
    let register = serde_json::to_value(&register).unwrap();
    let payload = register.get("payload").unwrap_or(&register);
    assert_eq!(
        payload["features"],
        serde_json::json!(["assistant_job", "ticket_attachments", "agent_attachments"]),
        "{register}"
    );
    nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM).unwrap();
    let (code, stderr) = exit_of(child).await;
    assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn subcommand_usage_errors_exit_2() {
    let t = tempfile::tempdir().unwrap();
    daemon(t.path())
        .args(["enroll", "--token", "x"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("missing --url"));
    daemon(t.path())
        .arg("config")
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "usage: conductor-daemon config roots",
        ));
    daemon(t.path())
        .args(["service", "frob"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "usage: conductor-daemon service install|uninstall|restart|status",
        ));
}

#[test]
fn the_enroll_token_env_var_is_read_and_never_echoed() {
    let t = tempfile::tempdir().unwrap();
    // Plain http to a non-loopback host is refused before any request: the token came from the
    // environment (no "missing --token"), and nothing prints it.
    daemon(t.path())
        .args(["enroll", "--url", "http://conductor.example.com"])
        .env("CONDUCTOR_ENROLL_TOKEN", "tok-secret-xyz")
        .assert()
        .code(2)
        .stderr(predicate::str::contains("must be https"))
        .stderr(predicate::str::contains("tok-secret-xyz").not());
}

#[test]
fn config_show_prints_the_effective_config() {
    let t = tempfile::tempdir().unwrap();
    let out = daemon(t.path())
        .args(["config", "show"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["roots_from"], "file");
    assert_eq!(v["roots"], serde_json::json!([]));
}

#[test]
fn rescan_writes_the_trigger_file() {
    let t = tempfile::tempdir().unwrap();
    daemon(t.path())
        .arg("rescan")
        .assert()
        .code(0)
        .stdout(predicate::str::contains("rescan requested"));
    assert!(t.path().join("root").join("state").join("rescan").exists());
}
