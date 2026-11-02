//! The ADR-0006 edit-guard hook, run as Claude Code runs it (port of `claude/edit-guard.test.ts`):
//! the settings' command through a shell, PreToolUse JSON on stdin, exit 2 = blocked (any other
//! non-zero would let the edit through). These tests spawn the real `conductor-daemon` binary and
//! the shells on purpose: what is under test is the command string and the process's exit code.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use conductor_daemon::claude::edit_guard::{EDIT_GUARD_MATCHER, write_edit_guard};
use conductor_daemon::platform::{
    AclKind, AssertOwnerOnlyOptions, Platform, assert_owner_only, mkdir_private, workflow_shell,
};
use serde_json::{Value, json};

const EXE: &str = env!("CARGO_BIN_EXE_conductor-daemon");

fn on_windows() -> bool {
    Platform::current().is_windows()
}

/// `fs.realpathSync` without Windows' `\\?\`.
fn realpath(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    PathBuf::from(c.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(c))
}

fn symlink(target: &Path, link: &Path) {
    conductor_daemon::platform::fs::symlink(target, link).expect("symlink");
}

struct Guard {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    wt: PathBuf,
    command: String,
    settings: Value,
    guard_dir: PathBuf,
}

fn setup() -> Guard {
    // A space and a quote in the path (and `$` on POSIX; Windows refuses `$`, see platform/hook).
    let prefix = if on_windows() {
        "edit guard's x-"
    } else {
        "edit guard's $x-"
    };
    let tmp = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let dir = realpath(tmp.path());
    mkdir_private(&dir).unwrap();
    let wt = dir.join("wt");
    std::fs::create_dir(&wt).unwrap();
    let guard_dir = dir.join("guard");
    mkdir_private(&guard_dir).unwrap();
    let path = write_edit_guard(&guard_dir, &wt, Some(Path::new(EXE))).unwrap();
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_string();
    Guard {
        _tmp: tmp,
        dir,
        wt,
        command,
        settings,
        guard_dir,
    }
}

fn spawn_with_input(mut cmd: Command, input: &str) -> (Option<i32>, String) {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the shell");
    // The guard may exit before reading everything (a broken pipe is fine).
    let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[cfg(windows)]
fn cmd_exe(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let mut c = Command::new(Path::new(&root).join("System32").join("cmd.exe"));
    c.raw_arg(format!("/d /s /c \"{command}\""));
    c
}

#[cfg(not(windows))]
fn cmd_exe(_command: &str) -> Command {
    unreachable!("cmd.exe only on Windows")
}

/// Run the hook command through every shell Claude Code might use for it: sh on POSIX; on Windows
/// both cmd.exe and Git Bash (U-106), which must agree.
fn run_raw(command: &str, input: &str) -> (Option<i32>, String) {
    let mut shells: Vec<Command> = Vec::new();
    if on_windows() {
        shells.push(cmd_exe(command));
    }
    let sh = workflow_shell(Platform::current()).expect("a POSIX shell (Git Bash on Windows)");
    let mut c = Command::new(&sh.file);
    c.args(sh.args(command));
    shells.push(c);
    let rs: Vec<_> = shells
        .into_iter()
        .map(|c| spawn_with_input(c, input))
        .collect();
    assert!(
        rs.iter().all(|r| r.0 == rs[0].0),
        "every shell gives the same exit code: {rs:?}"
    );
    rs.into_iter().next().unwrap()
}

impl Guard {
    fn run(&self, tool_input: Value) -> (Option<i32>, String) {
        let input =
            json!({"hook_event_name": "PreToolUse", "cwd": self.wt, "tool_input": tool_input});
        run_raw(&self.command, &input.to_string())
    }
    fn code(&self, file_path: impl AsRef<str>) -> Option<i32> {
        self.run(json!({"file_path": file_path.as_ref()})).0
    }
    fn p(&self, rel: &str) -> String {
        self.wt.join(rel).to_string_lossy().into_owned()
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn settings_match_the_file_tools_and_pin_the_kill_switches_off() {
    let g = setup();
    assert_eq!(g.settings["disableAllHooks"], json!(false));
    assert_eq!(g.settings["env"], json!({"CLAUDE_CODE_SAFE_MODE": "0"}));
    assert_eq!(
        g.settings["hooks"]["PreToolUse"][0]["matcher"],
        json!(EDIT_GUARD_MATCHER)
    );
    let start = if on_windows() {
        format!("\"{}\" \"hook\" \"edit-guard\" ", EXE.replace('\\', "/"))
    } else {
        format!("'{EXE}' 'hook' 'edit-guard' ")
    };
    assert!(g.command.starts_with(&start), "{}", g.command);
    assert!(g.command.ends_with(" || exit 2"));
}

#[test]
fn writes_the_settings_0600_or_owner_only() {
    let g = setup();
    let f = g.guard_dir.join("settings.json");
    assert_owner_only(
        &f,
        AssertOwnerOnlyOptions {
            kind: AclKind::File,
            check_access: true,
        },
    )
    .unwrap();
    if let Some(mode) = conductor_daemon::platform::fs::posix_mode(&f) {
        assert_eq!(mode & 0o777, 0o600);
    }
    // No script any more: the hook is the daemon's own executable (ADR-0026).
    let names: Vec<_> = std::fs::read_dir(&g.guard_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["settings.json"]);
}

#[test]
fn a_path_cmd_or_git_bash_would_reinterpret_is_refused_at_setup() {
    if !on_windows() {
        return; // the Windows quoting rules only (POSIX single-quotes anything)
    }
    let g = setup();
    for (i, bad) in ["C:\\a%PATH%b", "C:\\a!b", "C:\\a^b", "C:\\a$b", "C:\\a\"b"]
        .iter()
        .enumerate()
    {
        let d = g.dir.join(format!("g-{i}"));
        mkdir_private(&d).unwrap();
        let e = write_edit_guard(&d, Path::new(bad), Some(Path::new(EXE))).unwrap_err();
        assert!(e.contains("cannot build the edit-guard hook"), "{e}");
        assert!(!d.join("settings.json").exists());
    }
}

#[test]
fn allows_absolute_paths_inside_the_worktree_including_new_dirs() {
    let g = setup();
    assert_eq!(g.code(g.p("src/deep/new.ts")), Some(0));
    assert_eq!(g.code(format!("{}/a/../b.txt", s(&g.wt))), Some(0));
    assert_eq!(g.run(json!({"notebook_path": g.p("n.ipynb")})).0, Some(0));
}

#[test]
fn blocks_paths_outside_the_worktree_with_exit_2_and_a_reason() {
    let g = setup();
    for p in [
        s(&g.dir.join("outside.txt")),
        format!(
            "{}{}..{}x",
            s(&g.wt),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        ),
        "/etc/hosts".to_string(),
        format!("{}-sib/x", s(&g.wt)),
    ] {
        let (code, stderr) = g.run(json!({"file_path": p}));
        assert_eq!(code, Some(2), "{p}");
        assert!(
            stderr.contains("limited to the session worktree")
                || stderr.contains("start with a drive letter"),
            "{p}: {stderr}"
        );
    }
}

#[test]
fn expands_tilde_and_blocks_home_paths_refuses_relative_paths() {
    let g = setup();
    assert_eq!(g.code("~/.zshrc"), Some(2));
    assert_eq!(g.code("~"), Some(2));
    let (code, stderr) = g.run(json!({"file_path": "README.md"}));
    assert_eq!(code, Some(2));
    assert!(stderr.contains("must be absolute"), "{stderr}");
}

#[test]
fn follows_symlinks_existing_missing_and_dotdot_after_a_link() {
    if on_windows() {
        // Symlinks need Developer Mode there; the Windows path-forms test covers junctions.
        return;
    }
    let g = setup();
    std::fs::create_dir(g.dir.join("secret")).unwrap();
    symlink(&g.dir.join("secret"), &g.wt.join("link"));
    assert_eq!(g.code(g.p("link/id_rsa")), Some(2));

    symlink(&g.dir.join("not-yet").join("f.txt"), &g.wt.join("dangling"));
    assert_eq!(g.code(g.p("dangling")), Some(2));

    std::fs::create_dir(g.dir.join("secret").join("sub")).unwrap();
    symlink(&g.dir.join("secret").join("sub"), &g.wt.join("lnk"));
    // POSIX: the kernel follows lnk first (secret/evil).
    assert_eq!(g.code(format!("{}/lnk/../evil", s(&g.wt))), Some(2));

    symlink(Path::new("inner"), &g.wt.join("rel-link")); // a relative link that stays inside
    assert_eq!(g.code(g.p("rel-link/f")), Some(0));
}

#[test]
fn checks_every_path_field_not_just_the_first() {
    let g = setup();
    let (code, _) =
        g.run(json!({"file_path": g.p("ok"), "notebook_path": s(&g.dir.join("out.ipynb"))}));
    assert_eq!(code, Some(2));
}

#[test]
fn fails_closed_on_bad_input_and_odd_types() {
    let g = setup();
    assert_eq!(g.run(json!({})).0, Some(2));
    assert_eq!(g.run(json!({"file_path": 42})).0, Some(2));
    assert_eq!(run_raw(&g.command, "not json").0, Some(2));
    assert_eq!(run_raw(&g.command, "null").0, Some(2));
    assert_eq!(run_raw(&g.command, "").0, Some(2));
}

#[test]
fn fails_closed_when_the_daemon_executable_is_missing() {
    let g = setup();
    let d = g.dir.join("guard-no-exe");
    mkdir_private(&d).unwrap();
    let missing = if on_windows() {
        "C:\\nope\\conductor-daemon.exe"
    } else {
        "/nope/conductor-daemon"
    };
    let path = write_edit_guard(&d, &g.wt, Some(Path::new(missing))).unwrap();
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cmd = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    let input = json!({"tool_input": {"file_path": g.p("ok")}}).to_string();
    assert_eq!(run_raw(cmd, &input).0, Some(2));
}

/// Windows: `mklink /J link target`.
#[cfg(windows)]
fn junction(target: &Path, link: &Path) {
    use std::os::windows::process::CommandExt;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let status = Command::new(Path::new(&root).join("System32").join("cmd.exe"))
        .raw_arg(format!(
            "/d /c mklink /J \"{}\" \"{}\"",
            link.display(),
            target.display()
        ))
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J");
}

/// Windows: the 8.3 short form of an existing path (the long one when 8.3 names are off).
#[cfg(windows)]
fn short_path(p: &Path) -> String {
    let out = cmd_exe(&format!("for %I in (\"{}\") do @echo %~sI", p.display()))
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

// ADR-0024 §6 / MW-T08: every out-of-worktree form is blocked (fail-closed), every inside one is
// allowed, under cmd.exe and Git Bash alike.
#[cfg(windows)]
#[test]
fn windows_allows_and_blocks_the_right_path_forms() {
    let g = setup();
    let (dir, wt) = (s(&g.dir), s(&g.wt));
    std::fs::create_dir(g.dir.join("secret")).unwrap();
    std::fs::create_dir(g.dir.join("long outside name")).unwrap();
    std::fs::create_dir_all(g.wt.join("deep").join("deeper")).unwrap();
    junction(&g.dir.join("secret"), &g.wt.join("j")); // out
    junction(&g.wt.join("deep"), &g.wt.join("k")); // in
    junction(&g.wt.join("deep").join("deeper"), &g.wt.join("a"));
    let fwd = |p: &str| p.replace('\\', "/");
    let other_drive = if wt.to_lowercase().starts_with('c') {
        "D:\\x.txt"
    } else {
        "C:\\x.txt"
    };
    let rows: Vec<(String, i32)> = vec![
        (format!("{wt}\\a.txt"), 0),
        (format!("{}/b.txt", fwd(&wt)), 0),
        (format!("{}\\c.txt", wt.to_uppercase()), 0),
        (format!("{}\\d.txt", wt.to_lowercase()), 0),
        (format!("{wt}\\x\\..\\e.txt"), 0),
        (format!("{wt}\\.\\f.txt"), 0),
        (format!("{wt}\\new\\dir\\g.txt"), 0),
        (format!("{}/sub\\h.txt", fwd(&wt)), 0),
        (format!("{wt}\\k\\y.txt"), 0),
        (format!("{wt}.\\i.txt"), 2),
        (format!("{wt}\\.. \\x"), 2),
        (format!("{wt}\\sub\\.. \\.. \\x"), 2),
        (format!("{wt}\\name \\x"), 2),
        (format!("{dir}\\outside.txt"), 2),
        (format!("{wt}\\..\\x"), 2),
        (format!("{wt}-sib\\x"), 2),
        (format!("{wt}\\..\\wt-evil\\x"), 2),
        ("C:\\Windows\\System32\\drivers\\etc\\hosts".into(), 2),
        (other_drive.into(), 2),
        ("\\\\server\\share\\x".into(), 2),
        ("//server/share/x".into(), 2),
        (format!("\\\\?\\{wt}\\x"), 2),
        (format!("\\\\.\\{wt}\\x"), 2),
        ("\\\\?\\UNC\\server\\share\\x".into(), 2),
        (format!("\\??\\{wt}\\x"), 2),
        ("C:x.txt".into(), 2),
        ("\\Windows\\x".into(), 2),
        (format!("{wt}\\file.txt:stream"), 2),
        (format!("{wt}:stream"), 2),
        (format!("{wt}\\j\\x"), 2),
        (format!("{wt}\\a\\..\\..\\x"), 2),
        (
            format!("{}\\x", short_path(&g.dir.join("long outside name"))),
            2,
        ),
        ("~\\x".into(), 2),
        ("x.txt".into(), 2),
    ];
    let wrong: Vec<_> = rows
        .iter()
        .map(|(p, want)| (p, *want, g.code(p)))
        .filter(|(_, want, got)| *got != Some(*want))
        .collect();
    assert!(wrong.is_empty(), "{wrong:#?}");
}
