//! The e2e fakes' native launcher (MR-T16b). **Test-only; never shipped** (the release packaging
//! builds `-p conductor-daemon` only).
//!
//! On Windows the daemon runs only a native `claude.exe` (U-110, `platform::native_exe_problem`),
//! and a `.cmd` can't carry a multi-line argument (`gh pr create --body`, `ERR_CMD_UNSAFE_ARG`).
//! So the e2e harness copies this binary into its temp dir as `claude.exe` and `gh.exe`, each with
//! a sidecar `<name>.launch` that names the real program (node) and its leading arguments (the
//! fake's script). The launcher runs `<program> <prefix args…> <its own args…>` with stdio and env
//! inherited, and exits with the child's code.
//!
//! The daemon puts every child in a Job Object with KILL_ON_JOB_CLOSE, and the launcher never asks
//! for breakaway, so the node grandchild dies with the launcher (on a kill or a daemon exit).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The sidecar next to the launcher: `claude.exe` → `claude.launch` (`claude` → `claude.launch`).
pub fn sidecar_path(exe: &Path) -> PathBuf {
    exe.with_extension("launch")
}

/// A sidecar's lines: the program, then its leading arguments. Blank lines are ignored and CRLF is
/// tolerated. An empty sidecar is an error.
pub fn parse_sidecar(text: &str) -> Result<(OsString, Vec<OsString>), String> {
    let mut items = text
        .lines()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty())
        .map(OsString::from);
    let program = items
        .next()
        .ok_or_else(|| "the sidecar names no program".to_string())?;
    Ok((program, items.collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_path_swaps_the_extension() {
        assert_eq!(
            sidecar_path(Path::new("bin/claude.exe")),
            PathBuf::from("bin/claude.launch")
        );
        assert_eq!(
            sidecar_path(Path::new("bin/claude")),
            PathBuf::from("bin/claude.launch")
        );
    }

    #[test]
    fn parse_sidecar_reads_the_program_then_the_prefix_args() {
        let (p, a) = parse_sidecar("C:\\node.exe\r\nC:\\fake claude.mjs\r\n\r\n--x\n").unwrap();
        assert_eq!(p, OsString::from("C:\\node.exe"));
        assert_eq!(
            a,
            vec![OsString::from("C:\\fake claude.mjs"), OsString::from("--x")]
        );
    }

    #[test]
    fn parse_sidecar_with_only_a_program_has_no_prefix() {
        let (p, a) = parse_sidecar("node").unwrap();
        assert_eq!(p, OsString::from("node"));
        assert!(a.is_empty());
    }

    #[test]
    fn an_empty_sidecar_is_an_error() {
        assert!(parse_sidecar("").is_err());
        assert!(parse_sidecar("\r\n  \n").is_err());
    }
}
