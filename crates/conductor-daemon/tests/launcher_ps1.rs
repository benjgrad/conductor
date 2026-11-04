//! The Windows launcher, `assets/conductor-launch.ps1` (MR-T13c), run as the Scheduled Task runs
//! it: `powershell.exe -File <root>\bin\conductor-launch.ps1`, against a fake
//! `daemon\current\bin\conductor-daemon.exe`. These tests spawn Windows PowerShell on purpose: what
//! is under test is the script itself (its restart policy by exit code, its environment, and that
//! it re-resolves the `current` junction before every start), and only PowerShell can run it.
//!
//! The fake daemon is a tiny C# console program compiled with `Add-Type -OutputAssembly` (in
//! every Windows PowerShell 5.1). Each run appends `CONDUCTOR_SUPERVISED|CONDUCTOR_ROOT|args|
//! version` to `<fake>\calls.txt` and exits with the next code from `<fake>\codes.txt`; if
//! `<fake>\switch-to.txt` exists it first re-points `daemon\current` there (MR-T14's switch).
#![cfg(windows)]

use conductor_daemon::commands::service::LAUNCHER_PS1;
use std::path::{Path, PathBuf};
use std::process::Command;

const FAKE_DAEMON_CS: &str = r#"
using System;
using System.IO;
using System.Collections.Generic;
public static class FakeDaemon {
  public static int Main(string[] args) {
    string dir = Environment.GetEnvironmentVariable("FAKE_DIR");
    string self = System.Reflection.Assembly.GetEntryAssembly().Location;
    string version = File.ReadAllText(Path.Combine(Path.GetDirectoryName(self), "version.txt")).Trim();
    File.AppendAllText(Path.Combine(dir, "calls.txt"),
      Environment.GetEnvironmentVariable("CONDUCTOR_SUPERVISED") + "|" +
      Environment.GetEnvironmentVariable("CONDUCTOR_ROOT") + "|" +
      string.Join(" ", args) + "|" + version + "\r\n");
    string sw = Path.Combine(dir, "switch-to.txt");
    if (File.Exists(sw)) {
      string target = File.ReadAllText(sw).Trim();
      File.Delete(sw);
      string current = Environment.GetEnvironmentVariable("CONDUCTOR_ROOT") + "\\daemon\\current";
      var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe",
        "/d /c rmdir \"" + current + "\" && mklink /J \"" + current + "\" \"" + target + "\"") {
        UseShellExecute = false, CreateNoWindow = true });
      p.WaitForExit();
    }
    string codesFile = Path.Combine(dir, "codes.txt");
    var codes = new List<string>(File.ReadAllLines(codesFile));
    int code = int.Parse(codes[0]);
    codes.RemoveAt(0);
    File.WriteAllLines(codesFile, codes.ToArray());
    return code;
  }
}
"#;

struct Root {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    fake: PathBuf,
}

fn mklink_junction(link: &Path, target: &Path) {
    let st = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(st.status.success(), "{st:?}");
}

/// `<root>` with the launcher in `bin`, versions `v1` and `v2` of the fake daemon, and
/// `daemon\current` → `v1`.
fn setup(codes: &[i32]) -> Root {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("conductor root"); // a space, as under C:\Users\First Last
    let fake = tmp.path().join("fake");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::write(root.join("bin").join("conductor-launch.ps1"), LAUNCHER_PS1).unwrap();
    let cs = fake.join("fake.cs");
    std::fs::write(&cs, FAKE_DAEMON_CS).unwrap();
    let exe = fake.join("conductor-daemon.exe");
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(
            "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:FAKE_CS)) \
             -OutputAssembly $env:FAKE_EXE -OutputType ConsoleApplication",
        )
        .env("FAKE_CS", &cs)
        .env("FAKE_EXE", &exe)
        .output()
        .unwrap();
    assert!(out.status.success(), "Add-Type: {out:?}");
    for v in ["v1", "v2"] {
        let bin = root.join("daemon").join(v).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::copy(&exe, bin.join("conductor-daemon.exe")).unwrap();
        std::fs::write(bin.join("version.txt"), v).unwrap();
    }
    mklink_junction(
        &root.join("daemon").join("current"),
        &root.join("daemon").join("v1"),
    );
    let codes: Vec<String> = codes.iter().map(i32::to_string).collect();
    std::fs::write(fake.join("codes.txt"), codes.join("\r\n")).unwrap();
    Root {
        _tmp: tmp,
        root,
        fake,
    }
}

/// Run the launcher as the task does (no restart delay); its exit code.
fn launch(r: &Root) -> i32 {
    let out = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(r.root.join("bin").join("conductor-launch.ps1"))
        .args(["-RestartDelaySeconds", "0"])
        .env("FAKE_DIR", &r.fake)
        .env_remove("CONDUCTOR_SUPERVISED")
        .env_remove("CONDUCTOR_ROOT")
        .output()
        .unwrap();
    out.status.code().expect("an exit code")
}

/// `calls.txt` as (supervised, root, args, version) rows.
fn calls(r: &Root) -> Vec<(String, String, String, String)> {
    std::fs::read_to_string(r.fake.join("calls.txt"))
        .unwrap_or_default()
        .lines()
        .map(|l| {
            let f: Vec<&str> = l.split('|').collect();
            (f[0].into(), f[1].into(), f[2].into(), f[3].into())
        })
        .collect()
}

fn same_dir(a: &str, b: &Path) -> bool {
    std::fs::canonicalize(a).unwrap() == std::fs::canonicalize(b).unwrap()
}

#[test]
fn restarts_on_75_and_crashes_and_stops_on_78() {
    let r = setup(&[75, 1, 78]);
    assert_eq!(launch(&r), 78);
    let c = calls(&r);
    assert_eq!(c.len(), 3, "{c:?}");
    for (sup, root, args, version) in &c {
        assert_eq!(sup, "schtasks");
        assert!(same_dir(root, &r.root), "{root}");
        assert_eq!(args, "run");
        assert_eq!(version, "v1");
    }
    let logs = r.root.join("logs");
    assert!(!logs.join("daemon.pid").exists());
    let launcher_log = std::fs::read_to_string(logs.join("launcher.log")).unwrap();
    let restarts: Vec<&str> = launcher_log.lines().collect();
    assert_eq!(restarts.len(), 2, "{launcher_log}");
    assert!(restarts[0].contains("daemon exited 75; restarting"));
    assert!(restarts[1].contains("daemon exited 1; restarting"));
    assert!(logs.join("daemon.log").exists());
    assert!(logs.join("daemon.log.1").exists());
}

#[test]
fn a_clean_exit_stops() {
    let r = setup(&[0]);
    assert_eq!(launch(&r), 0);
    assert_eq!(calls(&r).len(), 1);
    assert!(!r.root.join("logs").join("launcher.log").exists());
}

#[test]
fn a_switched_current_junction_takes_effect_on_the_restart() {
    let r = setup(&[75, 78]);
    std::fs::write(
        r.fake.join("switch-to.txt"),
        r.root
            .join("daemon")
            .join("v2")
            .to_string_lossy()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(launch(&r), 78);
    let versions: Vec<String> = calls(&r).into_iter().map(|c| c.3).collect();
    assert_eq!(versions, ["v1", "v2"]);
}
