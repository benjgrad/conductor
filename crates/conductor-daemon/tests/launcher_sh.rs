//! The POSIX launcher, `assets/conductor-launch.sh` (ADR-0021 §3, MR-T14): its trial and
//! rollback, run with `/bin/sh` against a temp root with fake daemon versions. It spawns a shell
//! on purpose: the script is what is under test, and only a shell can run it.
#![cfg(unix)]

use conductor_daemon::commands::service::LAUNCHER;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Root {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl Root {
    fn d(&self) -> PathBuf {
        self.root.join("daemon")
    }

    fn current(&self) -> String {
        std::fs::read_link(self.d().join("current"))
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.d().join(name)).ok()
    }

    /// Run the launcher once; returns what the fake daemon printed (`<version> <args>`).
    fn launch(&self) -> String {
        let out = Command::new("/bin/sh")
            .arg(self.root.join("bin").join("conductor-launch"))
            .arg("--x")
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

fn fake_version(d: &Path, v: &str) {
    let bin = d.join(v).join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("conductor-daemon");
    std::fs::write(&exe, format!("#!/bin/sh\necho \"{v} $*\"\n")).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// `<root>` (with a space) with the launcher, versions 1.0.0 and 2.0.0, current → `current`.
fn setup(current: &str, trial: Option<&str>) -> Root {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("conductor root");
    let d = root.join("daemon");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::write(root.join("bin").join("conductor-launch"), LAUNCHER).unwrap();
    for v in ["1.0.0", "2.0.0"] {
        fake_version(&d, v);
    }
    std::os::unix::fs::symlink(current, d.join("current")).unwrap();
    if let Some(t) = trial {
        std::fs::write(d.join("trial"), t).unwrap();
    }
    Root { _tmp: tmp, root }
}

#[test]
fn without_a_trial_it_just_runs_current() {
    let r = setup("2.0.0", None);
    assert_eq!(r.launch(), "2.0.0 run --x");
    assert_eq!(r.read("trial"), None);
    assert_eq!(r.read("bad-versions"), None);
}

#[test]
fn each_start_counts_an_attempt_and_the_third_rolls_back() {
    let r = setup("2.0.0", Some("from=1.0.0\nto=2.0.0\nattempts=0\n"));
    assert_eq!(r.launch(), "2.0.0 run --x");
    assert_eq!(
        r.read("trial").as_deref(),
        Some("from=1.0.0\nto=2.0.0\nattempts=1\n")
    );
    assert_eq!(r.launch(), "2.0.0 run --x");
    assert_eq!(
        r.read("trial").as_deref(),
        Some("from=1.0.0\nto=2.0.0\nattempts=2\n")
    );
    // Third start: 2.0.0 failed twice.
    assert_eq!(r.launch(), "1.0.0 run --x");
    assert_eq!(r.current(), "1.0.0");
    assert_eq!(r.read("trial"), None);
    assert_eq!(r.read("bad-versions").as_deref(), Some("2.0.0\n"));
    let leftovers: Vec<String> = std::fs::read_dir(r.d())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.') || n.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn a_trial_with_unsafe_versions_is_dropped() {
    let r = setup("2.0.0", Some("from=../../etc\nto=2.0.0\nattempts=5\n"));
    assert_eq!(r.launch(), "2.0.0 run --x");
    assert_eq!(r.read("trial"), None);
    assert_eq!(r.current(), "2.0.0");
    assert_eq!(r.read("bad-versions"), None);
}

#[test]
fn a_missing_from_version_is_never_rolled_back_to() {
    let r = setup("2.0.0", Some("from=0.9.0\nto=2.0.0\nattempts=2\n"));
    assert_eq!(r.launch(), "2.0.0 run --x");
    assert_eq!(r.current(), "2.0.0");
    assert_eq!(
        r.read("trial").as_deref(),
        Some("from=0.9.0\nto=2.0.0\nattempts=3\n")
    );
}

#[test]
fn it_parses_a_trial_written_by_the_daemon() {
    use conductor_daemon::update::layout::{Trial, write_trial};
    let r = setup("2.0.0", None);
    write_trial(
        &r.root,
        &Trial {
            from: "1.0.0".into(),
            to: "2.0.0".into(),
            attempts: 2,
        },
    )
    .unwrap();
    assert_eq!(r.launch(), "1.0.0 run --x");
    assert_eq!(r.read("bad-versions").as_deref(), Some("2.0.0\n"));
}
