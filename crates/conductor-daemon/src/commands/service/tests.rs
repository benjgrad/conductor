//! Port of `commands/service.test.ts` (M2-T18). The unit files are pure renderers; the install /
//! uninstall / restart flow runs against an in-process fake of launchctl / systemctl (the TS test
//! spawned fake tools on PATH; here the `run` seam is the boundary, so nothing is spawned). The
//! launchd / systemd install and restart flows are POSIX-only, as in TS; the Scheduled Task ones
//! (MR-T13c, no TS counterpart) run on every OS against a fake schtasks.

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
fn launchd_on_macos_systemd_on_linux_scheduled_task_on_windows() {
    assert_eq!(service_manager_for("darwin"), Some(ServiceManager::Launchd));
    assert_eq!(service_manager_for("linux"), Some(ServiceManager::Systemd));
    assert_eq!(
        service_manager_for("win32"),
        Some(ServiceManager::ScheduledTask)
    );
    assert_eq!(service_manager_for("freebsd"), None);
    assert!(service_manager().is_some());
    assert_eq!(
        service_manager() == Some(ServiceManager::ScheduledTask),
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
    // Under the Scheduled Task the launcher itself stops on 78.
    let schtasks: Env = [("CONDUCTOR_SUPERVISED".to_string(), "schtasks".to_string())].into();
    stop_supervised_job(&schtasks, None, &mut rec);
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
///
/// It is also schtasks (`/Query` succeeds once `/Create`d, `/Delete` unregisters), the status
/// PowerShell (prints `task_state`) and tasklist (prints `tasklist`).
#[derive(Default)]
struct FakeCtl {
    calls: Vec<String>,
    loaded: bool,
    registered: bool,
    task_state: String,
    tasklist: String,
}

impl FakeCtl {
    fn call(&mut self, file: &str, args: &[String]) -> RunResult {
        self.calls.push(format!("{file} {}", args.join(" ")));
        let mut r = RunResult {
            status: Some(0),
            ..Default::default()
        };
        match file {
            "schtasks" => {
                match args[0].as_str() {
                    "/Query" => r.status = Some(if self.registered { 0 } else { 1 }),
                    "/Create" => self.registered = true,
                    "/Delete" => self.registered = false,
                    _ => {}
                }
                return r;
            }
            "powershell.exe" => {
                if self.registered {
                    r.stdout = format!("{}\r\n", self.task_state);
                } else {
                    r.status = Some(1);
                }
                return r;
            }
            "tasklist" => {
                r.stdout = self.tasklist.clone();
                return r;
            }
            "taskkill" => return r,
            _ => {}
        }
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
        std::fs::write(bin.join("conductor-daemon.exe"), "MZ").unwrap();
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
            user_sid: Some(SID.to_string()),
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
            ServiceManager::ScheduledTask => task_xml_path(&self.root()),
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
            ServiceManager::ScheduledTask => unreachable!(),
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
                ServiceManager::ScheduledTask => unreachable!(),
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
                ServiceManager::ScheduledTask => unreachable!(),
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
                ServiceManager::ScheduledTask => unreachable!(),
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
            ServiceManager::ScheduledTask => unreachable!(),
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
    for m in [
        ServiceManager::Launchd,
        ServiceManager::Systemd,
        ServiceManager::ScheduledTask,
    ] {
        let mut f = Fixture::new();
        std::fs::remove_dir_all(f.root.join("daemon")).unwrap();
        assert_eq!(f.service(Some(m), &["install"]), 1);
        let installer = if m == ServiceManager::ScheduledTask {
            "conductor-daemon.exe is missing: install conductor with install.ps1 first"
        } else {
            "install conductor with install.sh first"
        };
        assert!(f.io.err.join("\n").contains(installer), "{:?}", f.io.err);
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

// ------------------------------------------------------------------ Scheduled Task (MR-T13c)

const SID: &str = "S-1-5-21-1-2-3-1001";

fn task_inputs() -> TaskInputs {
    TaskInputs {
        root: r"C:\Users\ann\.conductor".into(),
        home: r"C:\Users\ann".into(),
        user_sid: SID.into(),
    }
}

#[test]
fn the_task_runs_the_ps1_launcher_hidden_at_this_users_logon_without_a_time_limit() {
    let x = render_task_xml(&task_inputs()).unwrap();
    assert!(x.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task version=\"1.2\""));
    assert!(x.contains(&format!(
        "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>{SID}</UserId>\n    </LogonTrigger>"
    )));
    assert!(x.contains(&format!(
        "<UserId>{SID}</UserId>\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>"
    )));
    for setting in [
        "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "<Hidden>true</Hidden>",
        "<Priority>5</Priority>",
        "<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>999</Count>",
    ] {
        assert!(x.contains(setting), "{setting}");
    }
    assert!(x.contains("<Command>powershell.exe</Command>"));
    assert!(x.contains(
        "<Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;C:\\Users\\ann\\.conductor\\bin\\conductor-launch.ps1&quot;</Arguments>"
    ));
    assert!(x.contains(r"<WorkingDirectory>C:\Users\ann</WorkingDirectory>"));
    // Nothing elevated, no other account.
    assert!(!x.contains("HighestAvailable"));
    assert!(!x.contains("SYSTEM"));
}

#[test]
fn the_task_escapes_xml_and_refuses_a_root_powershell_cannot_be_given() {
    let odd = TaskInputs {
        root: r"C:\Users\a&b c\<x>\".into(),
        ..task_inputs()
    };
    let x = render_task_xml(&odd).unwrap();
    assert!(x.contains(r"-File &quot;C:\Users\a&amp;b c\&lt;x&gt;\bin\conductor-launch.ps1&quot;"));
    let bad = TaskInputs {
        root: "C:\\x\"y".into(),
        ..task_inputs()
    };
    assert!(
        render_task_xml(&bad)
            .unwrap_err()
            .contains("powershell -File")
    );
}

#[test]
fn the_task_file_is_utf16le_with_a_bom() {
    let x = render_task_xml(&task_inputs()).unwrap();
    let b = utf16le_bom(&x);
    assert_eq!(&b[..2], &[0xFF, 0xFE]);
    let units: Vec<u16> = b[2..]
        .chunks(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    assert_eq!(String::from_utf16(&units).unwrap(), x);
}

#[test]
fn the_ps1_launcher_supervises_by_exit_code_and_follows_current() {
    assert!(LAUNCHER_PS1.is_ascii());
    // PowerShell's own line handling is fine with LF; CRLF would only differ by checkout settings.
    assert!(!LAUNCHER_PS1.contains("$env:PATH ="));
    assert!(LAUNCHER_PS1.contains("$env:CONDUCTOR_SUPERVISED = 'schtasks'"));
    assert!(LAUNCHER_PS1.contains("$env:CONDUCTOR_ROOT = $root"));
    assert!(LAUNCHER_PS1.contains("$root = Split-Path -Parent $PSScriptRoot"));
    assert!(LAUNCHER_PS1.contains("if ($code -eq 0 -or $code -eq 78) {"));
    // daemon\current is resolved inside the loop, so a switched junction takes effect (MR-T14).
    let lp = LAUNCHER_PS1.find("while ($true) {").unwrap();
    let cur = LAUNCHER_PS1
        .find("Join-Path $root 'daemon\\current\\bin\\conductor-daemon.exe'")
        .unwrap();
    assert!(cur > lp);
}

#[test]
fn task_install_registers_and_runs_a_second_install_changes_nothing() {
    let mut f = Fixture::new();
    let m = Some(ServiceManager::ScheduledTask);
    assert_eq!(f.service(m, &["install"]), 0, "{}", f.io.all());
    let xml_file = f.unit_file(ServiceManager::ScheduledTask);
    let expected = render_task_xml(&TaskInputs {
        root: f.root(),
        home: f.home.to_string_lossy().into_owned(),
        user_sid: SID.into(),
    })
    .unwrap();
    assert_eq!(std::fs::read(&xml_file).unwrap(), utf16le_bom(&expected));
    let launcher = f.root.join("bin").join("conductor-launch.ps1");
    assert_eq!(std::fs::read_to_string(&launcher).unwrap(), LAUNCHER_PS1);
    assert!(f.root.join("logs").is_dir());
    assert_eq!(
        f.ctl.calls,
        vec![
            format!("schtasks /Query /TN {TASK_NAME}"),
            format!("schtasks /Create /TN {TASK_NAME} /XML {xml_file} /F"),
            format!("schtasks /Run /TN {TASK_NAME}"),
        ]
    );
    assert!(f.io.out.join("\n").contains(&xml_file));

    let snap = |p: &Path| {
        (
            std::fs::read(p).unwrap(),
            std::fs::metadata(p).unwrap().modified().unwrap(),
        )
    };
    let before = [snap(Path::new(&xml_file)), snap(&launcher)];
    let n = f.ctl.calls.len();
    assert_eq!(f.service(m, &["install"]), 0);
    assert_eq!([snap(Path::new(&xml_file)), snap(&launcher)], before);
    assert_eq!(
        f.ctl.calls[n..].to_vec(),
        vec![
            format!("schtasks /Query /TN {TASK_NAME}"),
            format!("schtasks /Run /TN {TASK_NAME}"),
        ]
    );

    // A changed definition stops the running task first, then re-registers and starts it.
    std::fs::write(&xml_file, "old").unwrap();
    let n = f.ctl.calls.len();
    assert_eq!(f.service(m, &["install"]), 0);
    assert_eq!(
        f.ctl.calls[n..].to_vec(),
        vec![
            format!("schtasks /Query /TN {TASK_NAME}"),
            format!("schtasks /End /TN {TASK_NAME}"),
            format!("schtasks /Create /TN {TASK_NAME} /XML {xml_file} /F"),
            format!("schtasks /Run /TN {TASK_NAME}"),
        ]
    );
}

#[test]
fn task_restart_status_and_uninstall_never_elevate() {
    let mut f = Fixture::new();
    let m = Some(ServiceManager::ScheduledTask);
    assert_eq!(f.service(m, &["restart"]), 1);
    assert!(f.io.err.join("\n").contains("not installed"));
    assert_eq!(f.service(m, &["status"]), 3);
    assert!(f.io.out.join("\n").contains("state: not registered"));
    assert_eq!(f.service(m, &["install"]), 0);
    let n = f.ctl.calls.len();
    assert_eq!(f.service(m, &["restart"]), 0);
    assert_eq!(
        f.ctl.calls[n..].to_vec(),
        vec![
            format!("schtasks /End /TN {TASK_NAME}"),
            format!("schtasks /Run /TN {TASK_NAME}"),
        ]
    );
    f.ctl.task_state = "Running".into();
    assert_eq!(f.service(m, &["status"]), 0);
    let out = f.io.out.join("\n");
    assert!(out.contains("state: Running"), "{out}");
    assert!(out.contains(&f.unit_file(ServiceManager::ScheduledTask)));
    assert!(f.ctl.calls.contains(&format!(
        "powershell.exe -NoProfile -NonInteractive -Command (Get-ScheduledTask -TaskName '{TASK_NAME}' -ErrorAction Stop).State"
    )));
    f.ctl.task_state = "Ready".into();
    assert_eq!(f.service(m, &["status"]), 3);

    assert_eq!(f.service(m, &["uninstall"]), 0);
    assert!(!Path::new(&f.unit_file(ServiceManager::ScheduledTask)).exists());
    assert!(f.ctl.calls.ends_with(&[
        format!("schtasks /Query /TN {TASK_NAME}"),
        format!("schtasks /End /TN {TASK_NAME}"),
        format!("schtasks /Delete /TN {TASK_NAME} /F"),
    ]));
    let n = f.ctl.calls.len();
    assert_eq!(f.service(m, &["uninstall"]), 0); // nothing left: still fine
    assert_eq!(
        f.ctl.calls[n..].to_vec(),
        vec![format!("schtasks /Query /TN {TASK_NAME}")]
    );
    for c in &f.ctl.calls {
        assert!(
            !c.contains("runas") && !c.contains("/RU") && !c.contains("SYSTEM"),
            "{c}"
        );
    }
}

#[test]
fn task_stop_kills_a_leftover_daemon_only_when_the_pid_is_still_ours() {
    let mut f = Fixture::new();
    let m = Some(ServiceManager::ScheduledTask);
    assert_eq!(f.service(m, &["install"]), 0);
    let pid_file = f.root.join("logs").join("daemon.pid");

    std::fs::write(&pid_file, "4242").unwrap();
    f.ctl.tasklist = "\"notepad.exe\",\"4242\",\"Console\",\"1\",\"9,000 K\"\r\n".into();
    let n = f.ctl.calls.len();
    assert_eq!(f.service(m, &["restart"]), 0);
    assert!(f.ctl.calls[n..].contains(&"tasklist /FI PID eq 4242 /FO CSV /NH".to_string()));
    assert!(!f.ctl.calls.iter().any(|c| c.starts_with("taskkill")));
    assert!(!pid_file.exists());

    std::fs::write(&pid_file, "4242\r\n").unwrap();
    f.ctl.tasklist = "\"conductor-daemon.exe\",\"4242\",\"Console\",\"1\",\"20,000 K\"\r\n".into();
    let n = f.ctl.calls.len();
    assert_eq!(f.service(m, &["restart"]), 0);
    assert_eq!(
        f.ctl.calls[n..].to_vec(),
        vec![
            format!("schtasks /End /TN {TASK_NAME}"),
            "tasklist /FI PID eq 4242 /FO CSV /NH".to_string(),
            "taskkill /PID 4242 /T /F".to_string(),
            format!("schtasks /Run /TN {TASK_NAME}"),
        ]
    );
    assert!(tasklist_has_daemon("\"Conductor-Daemon.exe\",\"1\""));
    assert!(!tasklist_has_daemon(
        "INFO: No tasks are running which match the specified criteria."
    ));
}

#[test]
fn task_install_needs_the_users_sid() {
    let mut f = Fixture::new();
    let argv = vec!["install".to_string()];
    let ctl = &mut f.ctl;
    let mut run = |file: &str, a: &[String]| ctl.call(file, a);
    let mut d = ServiceDeps {
        manager: Some(ServiceManager::ScheduledTask),
        home: f.home.clone(),
        uid: None,
        user_sid: None,
        env: &f.env,
        run: &mut run,
        io: &mut f.io,
        wsl: false,
    };
    assert_eq!(service_command(&argv, &mut d), 1);
    assert!(f.io.err.join("\n").contains("user SID"));
    assert!(f.ctl.calls.is_empty());
}
