//! The `conductor-daemon` command line (MR-T13a), run as the real binary: what is under test is the
//! process boundary (argv parsing, stdout/stderr, exit codes). The subcommands' behaviour is
//! tested in-process in `src/commands/*/tests.rs`; these are kept few on purpose.

use assert_cmd::Command;
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

#[test]
fn run_without_a_valid_config_exits_1() {
    // `run` itself is in tests/run.rs; here only its config error path (no network needed).
    let t = tempfile::tempdir().unwrap();
    daemon(t.path())
        .arg("run")
        .env("CONDUCTOR_PORT", "not-a-port")
        .assert()
        .code(1)
        .stderr(predicate::str::contains("[conductor-daemon] fatal:"));
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
