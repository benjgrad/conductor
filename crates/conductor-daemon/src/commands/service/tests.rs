//! Port of `commands/service.test.ts` (M2-T18). The unit files are pure renderers; the install /
//! uninstall / restart flow runs against an in-process fake of launchctl / systemctl (the TS test
//! spawned fake tools on PATH; here the `run` seam is the boundary, so nothing is spawned). The
//! install and restart flows are POSIX-only, as in TS.

use super::*;
use crate::commands::CapturedOutput;
use crate::platform::Platform;
use crate::ws_client::EXIT_FATAL_AUTH;

const EXIT_RESTART_FOR_UPDATE: i32 = 75; // ADR-0021 §2

fn inputs() -> UnitInputs {
    UnitInputs {
        root: "/Users/ann/.conductor".into(),
        path: "/opt/homebrew/bin:/usr/bin:/bin".into(),
        home: "/Users/ann".into(),
    }
}

/// The TS snapshot (`__snapshots__/service.test.ts.snap`) without the CONDUCTOR_NODE entry.
const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by conductor-daemon service install; re-run it rather than editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.conductor.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/ann/.conductor/bin/conductor-launch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>/Users/ann</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONDUCTOR_SUPERVISED</key>
    <string>launchd</string>
    <key>CONDUCTOR_ROOT</key>
    <string>/Users/ann/.conductor</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/ann/.conductor/logs/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/ann/.conductor/logs/daemon.log</string>
</dict>
</plist>
"#;

const UNIT: &str = r#"# Written by conductor-daemon service install; re-run it rather than editing this file.
[Unit]
Description=conductor daemon
After=network-online.target

[Service]
Type=simple
ExecStart="/Users/ann/.conductor/bin/conductor-launch"
Environment="CONDUCTOR_SUPERVISED=systemd"
Environment="CONDUCTOR_ROOT=/Users/ann/.conductor"
Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"
WorkingDirectory=%h
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
"#;

/// What the unit tells systemd to do when the main process exits with `code`.
fn systemd_restarts(unit: &str, code: i32) -> bool {
    assert!(unit.lines().any(|l| l == "Restart=on-failure"));
    let prevent = unit
        .lines()
        .find_map(|l| l.strip_prefix("RestartPreventExitStatus="))
        .unwrap_or("");
    code != 0 && !prevent.split_whitespace().any(|c| c == code.to_string())
}

/// What launchd does: KeepAlive {SuccessfulExit: false} restarts any non-zero exit of a loaded job.
fn launchd_restarts(plist: &str, code: i32, booted_out: bool) -> bool {
    assert!(plist.contains(
        "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>"
    ));
    code != 0 && !booted_out
}

#[test]
fn launchd_on_macos_systemd_on_linux_none_on_windows() {
    assert_eq!(service_manager_for("darwin"), Some(ServiceManager::Launchd));
    assert_eq!(service_manager_for("linux"), Some(ServiceManager::Systemd));
    assert_eq!(service_manager_for("win32"), None);
    assert_eq!(
        service_manager().is_none(),
        Platform::current().is_windows()
    );
}

#[test]
fn the_launchd_plist_runs_the_launcher_supervised_with_logs_and_a_throttle() {
    let plist = render_plist(&inputs());
    assert_eq!(plist, PLIST);
    assert!(plist.contains(
        "<key>ProgramArguments</key>\n  <array>\n    <string>/Users/ann/.conductor/bin/conductor-launch</string>"
    ));
    assert!(plist.contains("<key>CONDUCTOR_SUPERVISED</key>\n    <string>launchd</string>"));
    // The Rust binary needs no Node: no CONDUCTOR_NODE pin (the intended difference from TS).
    assert!(!plist.contains("CONDUCTOR_NODE"));
    assert!(plist.contains("<key>ThrottleInterval</key>\n  <integer>30</integer>"));
    assert!(plist.contains("<string>/Users/ann/.conductor/logs/daemon.log</string>"));
}

#[test]
fn the_systemd_unit_runs_the_launcher_supervised_and_never_restarts_on_78() {
    let unit = render_systemd_unit(&inputs()).unwrap();
    assert_eq!(unit, UNIT);
    assert!(unit.contains("ExecStart=\"/Users/ann/.conductor/bin/conductor-launch\""));
    assert!(unit.contains("Environment=\"CONDUCTOR_SUPERVISED=systemd\""));
    assert!(unit.lines().any(|l| l == "RestartPreventExitStatus=78"));
    assert!(!unit.contains("CONDUCTOR_NODE"));
}

#[test]
fn escapes_xml_and_systemd_specifiers_and_refuses_what_systemd_cannot_quote() {
    let odd = UnitInputs {
        root: "/home/a&b/100%<x>".into(),
        ..inputs()
    };
    assert!(
        render_plist(&odd)
            .contains("<string>/home/a&amp;b/100%&lt;x&gt;/bin/conductor-launch</string>")
    );
    assert!(
        render_systemd_unit(&odd)
            .unwrap()
            .contains("ExecStart=\"/home/a&b/100%%<x>/bin/conductor-launch\"")
    );
    let bad = UnitInputs {
        path: "/bin:/x\"y".into(),
        ..inputs()
    };
    let e = render_systemd_unit(&bad).unwrap_err();
    assert!(e.contains("systemd unit"), "{e}");
}

#[test]
fn restart_policy_75_and_crashes_restart_0_and_78_do_not() {
    let unit = render_systemd_unit(&inputs()).unwrap();
    assert!(systemd_restarts(&unit, 1));
    assert!(systemd_restarts(&unit, EXIT_RESTART_FOR_UPDATE));
    assert!(!systemd_restarts(&unit, 0));
    assert!(!systemd_restarts(&unit, EXIT_FATAL_AUTH));

    let plist = render_plist(&inputs());
    let mut booted: Vec<Vec<String>> = Vec::new();
    let env: Env = [("CONDUCTOR_SUPERVISED".to_string(), "launchd".to_string())].into();
    let mut exit_under_launchd = |code: i32| {
        // The daemon's fatal path (main's on_fatal, MR-T13b) runs stop_supervised_job before 78.
        if code == EXIT_FATAL_AUTH {
            stop_supervised_job(&env, Some(501), &mut |f, a| {
                let mut c = vec![f.to_string()];
                c.extend(a.iter().cloned());
                booted.push(c);
            });
        }
        launchd_restarts(&plist, code, !booted.is_empty())
    };
    assert!(exit_under_launchd(1));
    assert!(exit_under_launchd(EXIT_RESTART_FOR_UPDATE));
    assert!(!exit_under_launchd(0));
    assert!(!exit_under_launchd(EXIT_FATAL_AUTH));
    assert_eq!(
        booted,
        vec![vec![
            "launchctl".to_string(),
            "bootout".into(),
            format!("gui/501/{LAUNCHD_LABEL}")
        ]]
    );
}

#[test]
fn stop_supervised_job_does_nothing_when_unsupervised_or_under_systemd() {
    let mut calls = 0;
    let mut rec = |_: &str, _: &[String]| calls += 1;
    stop_supervised_job(&Env::new(), Some(501), &mut rec);
    let systemd: Env = [("CONDUCTOR_SUPERVISED".to_string(), "systemd".to_string())].into();
    stop_supervised_job(&systemd, Some(501), &mut rec);
    let launchd: Env = [("CONDUCTOR_SUPERVISED".to_string(), "launchd".to_string())].into();
    stop_supervised_job(&launchd, None, &mut rec);
    assert_eq!(calls, 0);
}

#[test]
fn the_launcher_is_the_ts_daemon_asset_byte_for_byte() {
    let ts = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/daemon/assets/conductor-launch.sh"
    ))
    .unwrap();
    assert_eq!(LAUNCHER, ts);
    assert!(LAUNCHER.contains("exec \"$root/daemon/current/bin/conductor-daemon\" run \"$@\""));
}

// ------------------------------------------------------------------ install / uninstall / restart

/// launchctl / systemctl as the TS test's FAKE_CTL: logs `<tool> <args>`, `print` succeeds once
/// bootstrapped, `bootout` unloads, `is-active` prints `active`.
#[derive(Default)]
struct FakeCtl {
    calls: Vec<String>,
    loaded: bool,
}

impl FakeCtl {
    fn call(&mut self, file: &str, args: &[String]) -> RunResult {
        self.calls.push(format!("{file} {}", args.join(" ")));
        let mut r = RunResult {
            status: Some(0),
            ..Default::default()
        };
        match args.first().map(String::as_str) {
            Some("print") => r.status = Some(if self.loaded { 0 } else { 113 }),
            Some("bootstrap") => self.loaded = true,
            Some("bootout") => self.loaded = false,
            _ => {}
        }
        if args.get(1).map(String::as_str) == Some("is-active") {
            r.stdout = "active\n".into();
        }
        r
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    root: PathBuf,
    env: Env,
    ctl: FakeCtl,
    io: CapturedOutput,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let root = home.join(".conductor");
        let bin = root.join("daemon").join("current").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("conductor-daemon"), "#!/bin/sh\n").unwrap();
        std::fs::write(root.join("machine.json"), "{}").unwrap();
        let env: Env = [
            ("HOME".to_string(), home.to_string_lossy().into_owned()),
            (
                "PATH".to_string(),
                "/fake/bin:/usr/bin:relative:/bin:/usr/bin".into(),
            ),
        ]
        .into();
        Fixture {
            _tmp: tmp,
            home,
            root,
            env,
            ctl: FakeCtl::default(),
            io: CapturedOutput::default(),
        }
    }

    fn service(&mut self, manager: Option<ServiceManager>, argv: &[&str]) -> i32 {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let ctl = &mut self.ctl;
        let mut run = |f: &str, a: &[String]| ctl.call(f, a);
        let mut d = ServiceDeps {
            manager,
            home: self.home.clone(),
            uid: Some(501),
            env: &self.env,
            run: &mut run,
            io: &mut self.io,
            wsl: false,
        };
        service_command(&argv, &mut d)
    }

    fn unit_file(&self, m: ServiceManager) -> String {
        let home = self.home.to_string_lossy();
        match m {
            ServiceManager::Launchd => plist_path(&home),
            ServiceManager::Systemd => systemd_unit_path(&home),
        }
    }

    fn root(&self) -> String {
        root_dir_from(&self.env, &self.home)
            .to_string_lossy()
            .into_owned()
    }
}

const MANAGERS: [ServiceManager; 2] = [ServiceManager::Launchd, ServiceManager::Systemd];

#[test]
fn install_writes_the_unit_and_the_launcher_a_second_install_changes_nothing() {
    // POSIX only, as the TS suite (`describe.skipIf(win32)`): no launchd or systemd on Windows,
    // and a Windows root (`C:\…`) has a `\`, which a systemd unit can't quote.
    if Platform::current().is_windows() {
        return;
    }
    for m in MANAGERS {
        let mut f = Fixture::new();
        assert_eq!(f.service(Some(m), &["install"]), 0, "{}", f.io.all());
        let unit_file = f.unit_file(m);
        let inputs = UnitInputs {
            root: f.root(),
            // Absolute entries only, deduplicated.
            path: "/fake/bin:/usr/bin:/bin".into(),
            home: f.home.to_string_lossy().into_owned(),
        };
        let expected = match m {
            ServiceManager::Launchd => render_plist(&inputs),
            ServiceManager::Systemd => render_systemd_unit(&inputs).unwrap(),
        };
        assert_eq!(std::fs::read_to_string(&unit_file).unwrap(), expected);
        let launcher = f.root.join("bin").join("conductor-launch");
        assert_eq!(std::fs::read_to_string(&launcher).unwrap(), LAUNCHER);
        if let Some(mode) = posix_mode(&launcher) {
            assert_eq!(mode & 0o777, 0o755);
        }
        if let Some(mode) = posix_mode(Path::new(&unit_file)) {
            assert_eq!(mode & 0o777, 0o644);
        }
        assert!(f.root.join("logs").is_dir());
        let first = f.ctl.calls.clone();
        let t = format!("gui/501/{LAUNCHD_LABEL}");
        assert_eq!(
            first,
            match m {
                ServiceManager::Launchd => vec![
                    format!("launchctl print {t}"),
                    format!("launchctl enable {t}"),
                    format!("launchctl bootstrap gui/501 {unit_file}"),
                ],
                ServiceManager::Systemd => vec![
                    "systemctl --user daemon-reload".to_string(),
                    "systemctl --user enable conductor-daemon.service".into(),
                    "systemctl --user restart conductor-daemon.service".into(),
                ],
            }
        );

        let snap = |p: &Path| {
            (
                std::fs::read_to_string(p).unwrap(),
                std::fs::metadata(p).unwrap().modified().unwrap(),
            )
        };
        let before = [snap(Path::new(&unit_file)), snap(&launcher)];
        assert_eq!(f.service(Some(m), &["install"]), 0);
        assert_eq!([snap(Path::new(&unit_file)), snap(&launcher)], before);
        // Nothing re-bootstrapped or reloaded: only a check (launchd) or the idempotent enable.
        assert_eq!(
            f.ctl.calls[first.len()..].to_vec(),
            match m {
                ServiceManager::Launchd => vec![format!("launchctl print {t}")],
                ServiceManager::Systemd =>
                    vec!["systemctl --user enable --now conductor-daemon.service".to_string()],
            }
        );
    }
}

#[test]
fn restart_status_and_uninstall_sudo_is_never_used() {
    // POSIX only, as the TS suite (`describe.skipIf(win32)`): no launchd or systemd on Windows,
    // and a Windows root (`C:\…`) has a `\`, which a systemd unit can't quote.
    if Platform::current().is_windows() {
        return;
    }
    for m in MANAGERS {
        let mut f = Fixture::new();
        assert_eq!(f.service(Some(m), &["restart"]), 1);
        assert!(f.io.err.join("\n").contains("not installed"));
        assert_eq!(f.service(Some(m), &["install"]), 0);
        assert_eq!(f.service(Some(m), &["restart"]), 0);
        let t = format!("gui/501/{LAUNCHD_LABEL}");
        assert_eq!(
            f.ctl.calls.last().unwrap(),
            &match m {
                ServiceManager::Launchd => format!("launchctl kickstart -k {t}"),
                ServiceManager::Systemd =>
                    "systemctl --user restart conductor-daemon.service".into(),
            }
        );
        let status = f.service(Some(m), &["status"]);
        let unit_file = f.unit_file(m);
        assert!(f.io.out.join("\n").contains(&unit_file));
        // The fake's `print` has no pid: launchd reports "loaded, not running" (3).
        assert_eq!(status, if m == ServiceManager::Launchd { 3 } else { 0 });
        assert_eq!(f.service(Some(m), &["uninstall"]), 0);
        assert!(!Path::new(&unit_file).exists());
        assert!(f.ctl.calls.contains(&match m {
            ServiceManager::Launchd => format!("launchctl bootout {t}"),
            ServiceManager::Systemd =>
                "systemctl --user disable --now conductor-daemon.service".into(),
        }));
        assert_eq!(f.service(Some(m), &["uninstall"]), 0); // nothing left: still fine
        assert!(
            !f.ctl
                .calls
                .iter()
                .any(|c| c.split_whitespace().any(|w| w == "sudo"))
        );
    }
}

#[test]
fn refuses_without_an_installed_daemon() {
    for m in MANAGERS {
        let mut f = Fixture::new();
        std::fs::remove_dir_all(f.root.join("daemon")).unwrap();
        assert_eq!(f.service(Some(m), &["install"]), 1);
        assert!(
            f.io.err
                .join("\n")
                .contains("install conductor with install.sh first")
        );
        assert!(!Path::new(&f.unit_file(m)).exists());
        assert!(f.ctl.calls.is_empty());
    }
}

#[test]
fn usage_errors_and_an_os_without_a_service_manager_exit_2() {
    let mut f = Fixture::new();
    assert_eq!(f.service(Some(ServiceManager::Systemd), &["bogus"]), 2);
    assert_eq!(f.service(Some(ServiceManager::Systemd), &[]), 2);
    assert_eq!(
        f.service(Some(ServiceManager::Systemd), &["install", "extra"]),
        2
    );
    assert!(f.io.err.iter().all(|l| l == SERVICE_USAGE));
    assert_eq!(f.service(None, &["install"]), 2);
    assert!(
        f.io.err
            .last()
            .unwrap()
            .contains("not supported on this OS")
    );
    assert!(f.ctl.calls.is_empty());
}

#[test]
fn launchd_status_reads_the_pid_and_failures_name_the_tool() {
    assert_eq!(launchd_pid("state = running\n\tpid = 4242\n"), Some("4242"));
    assert_eq!(launchd_pid("ppid = 1\n"), None);
    assert_eq!(launchd_pid("nothing"), None);
    let r = RunResult {
        status: Some(5),
        stdout: String::new(),
        stderr: "Bootstrap failed: 5: Input/output error\nmore".into(),
    };
    assert_eq!(failed(&r), "Bootstrap failed: 5: Input/output error");
    assert_eq!(
        failed(&RunResult {
            status: None,
            ..Default::default()
        }),
        "exit error"
    );
    assert_eq!(unit_path_var(Some("/a::b:/a:/c")), "/a:/c");
}
