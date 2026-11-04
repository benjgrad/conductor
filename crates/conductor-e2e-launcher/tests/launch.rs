//! The launcher across a real process boundary (spawns node on purpose: argv quoting, stdio
//! inheritance and exit-code forwarding are what is under test, and they only exist there).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The node script the sidecar runs: prints its args as JSON, echoes stdin, exits with the first arg (`node -e` puts it at argv[1]).
const SCRIPT: &str = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{\
process.stdout.write(JSON.stringify(process.argv.slice(1))+'\\n'+s);\
process.exit(Number(process.argv[1])||0)})";

fn node() -> Option<String> {
    match Command::new("node").arg("--version").output() {
        Ok(o) if o.status.success() => Some("node".into()),
        _ => None,
    }
}

/// A copy of the launcher named `echo[.exe]` in `dir`, with a sidecar unless `sidecar` is None.
fn launcher(dir: &Path, sidecar: Option<&str>) -> PathBuf {
    let exe = dir.join(format!("echo{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(env!("CARGO_BIN_EXE_conductor-e2e-launcher"), &exe).unwrap();
    if let Some(text) = sidecar {
        std::fs::write(dir.join("echo.launch"), text).unwrap();
    }
    exe
}

#[test]
fn forwards_argv_stdin_and_the_exit_code() {
    let Some(node) = node() else {
        eprintln!("SKIP forwards_argv_stdin_and_the_exit_code: node is not on PATH");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let exe = launcher(dir.path(), Some(&format!("{node}\r\n-e\r\n{SCRIPT}\r\n")));
    let args = ["3", "two\nlines", "with spaces \"and\" quotes", ""];
    let mut child = Command::new(&exe)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"hello stdin")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(3));
    let stdout = String::from_utf8(out.stdout).unwrap();
    let (first, rest) = stdout.split_once('\n').unwrap();
    let expected = format!(
        "[{}]",
        args.iter()
            .map(|a| format!("{a:?}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_eq!(first, expected);
    assert_eq!(rest, "hello stdin");
}

#[test]
fn a_missing_sidecar_exits_127() {
    let dir = tempfile::tempdir().unwrap();
    let exe = launcher(dir.path(), None);
    let out = Command::new(&exe).output().unwrap();
    assert_eq!(out.status.code(), Some(127));
    assert!(String::from_utf8_lossy(&out.stderr).contains("echo.launch"));
}

#[test]
fn a_program_that_does_not_exist_exits_127() {
    let dir = tempfile::tempdir().unwrap();
    let exe = launcher(dir.path(), Some("conductor-no-such-program-xyz\n"));
    let out = Command::new(&exe).output().unwrap();
    assert_eq!(out.status.code(), Some(127));
}
