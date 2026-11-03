//! Port of `packages/daemon/src/inventory/git.ts` (MR-T11): read-only git for the inventory
//! scanner (M2-T10, ADR-0013 §Inventory: it runs no repo code). Hooks and fsmonitor off, no system
//! config and no inherited `GIT_*` overrides (`exec::clean_env`).

use crate::exec::{self, Env};
use crate::platform;
use std::path::Path;
use std::time::Duration;

/// What [`git_read`] returns: never an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRead {
    /// None: killed (timeout), not spawned, or over the output cap.
    pub code: Option<i32>,
    pub stdout: String,
}

pub const GIT_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// `maxBuffer` of the TS `execFile`.
pub const GIT_READ_MAX_BUFFER: usize = 1024 * 1024;

/// The argv of one read: hooks off, fsmonitor off, then `args`.
pub fn git_read_args(args: &[String]) -> Vec<String> {
    let mut argv = exec::no_hooks();
    argv.push("-c".into());
    argv.push("core.fsmonitor=false".into());
    argv.extend(args.iter().cloned());
    argv
}

/// `git <hardening> <args>` in `cwd`, with `exec::clean_env` of `env` (default: this process's).
pub async fn git_read(cwd: &Path, args: &[String], env: Option<&[(String, String)]>) -> GitRead {
    let base: Env = match env {
        Some(e) => e.to_vec(),
        None => platform::spawn::process_env(),
    };
    let r = exec::run_raw(
        "git",
        &git_read_args(args),
        cwd,
        exec::clean_env(&base),
        GIT_READ_MAX_BUFFER,
        GIT_READ_TIMEOUT,
    )
    .await;
    GitRead {
        code: if r.spawn_error.is_some() {
            None
        } else {
            r.code
        },
        stdout: r.stdout,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::sv;

    #[test]
    fn args_put_the_hardening_first() {
        let a = git_read_args(&sv(&["rev-parse", "HEAD"]));
        let n = a.len();
        assert_eq!(
            &a[n - 4..],
            &sv(&["-c", "core.fsmonitor=false", "rev-parse", "HEAD"])
        );
        assert_eq!(&a[..n - 4], &exec::no_hooks()[..]);
    }

    #[tokio::test]
    async fn reports_the_exit_code_and_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let ok = git_read(dir.path(), &sv(&["--version"]), None).await;
        assert_eq!(ok.code, Some(0));
        assert!(ok.stdout.starts_with("git version"), "{ok:?}");
        // Not a repo: git fails with 128, never an error here.
        let bad = git_read(
            dir.path(),
            &sv(&["rev-parse", "--verify", "--quiet", "HEAD"]),
            None,
        )
        .await;
        assert_ne!(bad.code, Some(0));
    }
}
