//! The hardened exec/git helpers every daemon git or gh call goes through (MR-T10). In the TS
//! daemon they live in `packages/daemon/src/actions/open-pr.ts` (`cleanEnv`, `run`, `tail`,
//! `NO_HOOKS`, `privateDir`) and `inventory` imports them from there; Rust gives them a module.
//!
//! No OS `cfg` here (tests/seam.rs): the OS facts come from `platform`.

use crate::platform::{self, CliOptions, Platform, SpawnError, acl};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// An environment, in order (`platform::spawn::Env`).
pub type Env = Vec<(String, String)>;

/// `&[&str]` → owned argv.
pub fn sv(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// `env` minus every variable that would point git at other config, dirs or commands (`GIT_*`,
/// `GH_REPO`, `GH_HOST`), plus no system gitconfig (POSIX; Windows keeps it, ADR-0024 §5), no
/// terminal prompts. Windows env names are case-insensitive, so the match is too there.
pub fn clean_env(env: &[(String, String)]) -> Env {
    clean_env_for(env, Platform::current())
}

pub fn clean_env_for(env: &[(String, String)], platform: Platform) -> Env {
    let win = platform.is_windows();
    let dropped = |k: &str| {
        if win {
            let up = k.to_ascii_uppercase();
            up.starts_with("GIT_") || up == "GH_REPO" || up == "GH_HOST"
        } else {
            k.starts_with("GIT_") || k == "GH_REPO" || k == "GH_HOST"
        }
    };
    let mut out: Env = env.iter().filter(|(k, _)| !dropped(k)).cloned().collect();
    let mut add = platform::git::git_system_config_env_for(platform);
    add.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    add.push(("GH_PROMPT_DISABLED".into(), "1".into()));
    for (k, v) in add {
        set_env(&mut out, &k, &v, win);
    }
    out
}

/// Set `k` in `env` (replacing it in place, matched case-insensitively on Windows).
pub fn set_env(env: &mut Env, k: &str, v: &str, case_insensitive: bool) {
    let same = |a: &str| {
        if case_insensitive {
            a.eq_ignore_ascii_case(k)
        } else {
            a == k
        }
    };
    if let Some(slot) = env.iter_mut().find(|(a, _)| same(a)) {
        slot.1 = v.to_string();
        env.retain({
            let mut seen = false;
            move |(a, _)| {
                if !same(a) {
                    return true;
                }
                let keep = !seen;
                seen = true;
                keep
            }
        });
    } else {
        env.push((k.to_string(), v.to_string()));
    }
}

/// Why a run never produced an exit code: the spawn failed (`ENOENT`: not on PATH), or the
/// output went over the buffer (Node's `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnFailure {
    /// The Node error code callers match on (`ENOENT`, …).
    pub code: &'static str,
    pub message: String,
}

/// What [`run`] returns: never an error, like the TS `run`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    /// None: killed (timeout), or no exit at all (`spawn_error`).
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub spawn_error: Option<SpawnFailure>,
}

impl Run {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// The TS `run`'s limits.
pub const RUN_MAX_BUFFER: usize = 4 * 1024 * 1024;
pub const RUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Run `cmd args` in `cwd` with [`clean_env`] of `env` (default: this process's), a 5-minute
/// timeout (the tree is killed) and a 4 MiB output cap. Never fails: see [`Run`].
///
/// TD-205: no `AbortSignal` twin. A caller that must stop early drops the future; the child is
/// not killed then (`platform::spawn` doesn't set `kill_on_drop`), only by the timeout.
pub async fn run(cmd: &str, args: &[String], cwd: &Path, env: Option<&[(String, String)]>) -> Run {
    let base = match env {
        Some(e) => e.to_vec(),
        None => platform::spawn::process_env(),
    };
    run_raw(
        cmd,
        args,
        cwd,
        clean_env(&base),
        RUN_MAX_BUFFER,
        RUN_TIMEOUT,
    )
    .await
}

/// [`run`] with exactly `env` (not cleaned) and the given limits.
pub async fn run_raw(
    cmd: &str,
    args: &[String],
    cwd: &Path,
    env: Env,
    max_buffer: usize,
    timeout: Duration,
) -> Run {
    let opts = CliOptions {
        cwd: Some(cwd.to_path_buf()),
        env: Some(env),
        timeout: Some(timeout),
        ..Default::default()
    };
    match platform::exec_file_cli(cmd, args, opts).await {
        Err(e) => Run {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            spawn_error: Some(spawn_failure(&e)),
        },
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&out.output.stderr).into_owned();
            if out.output.stdout.len() > max_buffer || out.output.stderr.len() > max_buffer {
                return Run {
                    code: None,
                    stdout,
                    stderr,
                    spawn_error: Some(SpawnFailure {
                        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                        message: "stdout maxBuffer length exceeded".into(),
                    }),
                };
            }
            let code = if out.timed_out {
                None
            } else {
                out.output.status.code()
            };
            Run {
                code,
                stdout,
                stderr,
                spawn_error: None,
            }
        }
    }
}

pub fn spawn_failure(e: &SpawnError) -> SpawnFailure {
    SpawnFailure {
        code: e.code(),
        message: e.to_string(),
    }
}

/// The last `n` characters of `s` trimmed, with a leading `…` when cut. (JS counts UTF-16 units;
/// this counts chars, which differs only outside the BMP, as TD-198.)
pub fn tail(s: &str, n: usize) -> String {
    let t = s.trim();
    let count = t.chars().count();
    if count > n {
        let cut: String = t.chars().skip(count - n).collect();
        format!("…{cut}")
    } else {
        t.to_string()
    }
}

/// The TS default `tail(s)` (600).
pub fn tail600(s: &str) -> String {
    tail(s, 600)
}

/// Hooks off for every daemon git call (`NUL` on Windows, see `platform::git`).
pub fn no_hooks() -> Vec<String> {
    platform::git::git_hooks_off_args()
}

/// `^[0-9a-f]{40,64}$`: a full commit id.
pub fn is_sha(s: &str) -> bool {
    (40..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Why [`private_dir`] failed.
pub type PrivateDirError = acl::PrivateError;

/// A fresh private dir for one push or checkout: `mkdtemp`-style `<root>/private/<prefix>XXXXXX`
/// (0700 and owned by this uid, or an owner-only DACL on Windows; never a symlink: see
/// `platform::acl`). No agent cwd is ever inside it, and it lives only for one action, so nothing
/// can be planted in it ahead of time.
pub fn private_dir(root: &Path, prefix: &str) -> Result<PathBuf, PrivateDirError> {
    let base = root.join("private");
    acl::mkdir_private(&base)?;
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut last = None;
    for _ in 0..100 {
        let suffix: String = (0..6)
            .map(|_| ALPHABET[rand::random_range(0..ALPHABET.len())] as char)
            .collect();
        let dir = base.join(format!("{prefix}{suffix}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                acl::mkdir_private(&dir)?;
                return Ok(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e.into()),
        }
    }
    Err(last
        .unwrap_or_else(|| std::io::Error::other("no free name"))
        .into())
}

/// The message of a [`PrivateDirError`] (Node's error `.message`).
pub fn private_error_text(e: &PrivateDirError) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn clean_env_drops_git_and_gh_overrides_and_adds_the_hardening() {
        let e = env(&[
            ("PATH", "/bin"),
            ("GIT_DIR", "/evil"),
            ("GIT_CONFIG_GLOBAL", "/evil"),
            ("GH_REPO", "evil/repo"),
            ("GH_HOST", "evil.example"),
            ("GH_TOKEN", "kept"),
            ("git_dir", "lower"),
        ]);
        let posix = clean_env_for(&e, Platform::Posix);
        assert_eq!(
            posix,
            env(&[
                ("PATH", "/bin"),
                ("GH_TOKEN", "kept"),
                ("git_dir", "lower"),
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GH_PROMPT_DISABLED", "1"),
            ])
        );
        let win = clean_env_for(&e, Platform::Windows);
        assert_eq!(
            win,
            env(&[
                ("PATH", "/bin"),
                ("GH_TOKEN", "kept"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GH_PROMPT_DISABLED", "1"),
            ])
        );
    }

    #[test]
    fn clean_env_overrides_rather_than_duplicates() {
        let e = env(&[("GH_PROMPT_DISABLED", "0"), ("gh_prompt_disabled", "x")]);
        let win = clean_env_for(&e, Platform::Windows);
        assert_eq!(
            win,
            env(&[("GH_PROMPT_DISABLED", "1"), ("GIT_TERMINAL_PROMPT", "0")])
        );
    }

    #[test]
    fn tail_trims_and_keeps_the_end() {
        assert_eq!(tail("  abc  ", 600), "abc");
        assert_eq!(tail("abcdef", 3), "…def");
        assert_eq!(tail("ééééé", 2), "…éé");
    }

    #[test]
    fn is_sha_is_full_lowercase_hex() {
        assert!(is_sha(&"a".repeat(40)));
        assert!(is_sha(&"0".repeat(64)));
        assert!(!is_sha(&"a".repeat(39)));
        assert!(!is_sha(&"a".repeat(65)));
        assert!(!is_sha(&"A".repeat(40)));
        assert!(!is_sha(&"g".repeat(40)));
    }

    #[tokio::test]
    async fn run_reports_exit_codes_and_a_missing_program() {
        let dir = tempfile::tempdir().unwrap();
        let ok = run("git", &sv(&["--version"]), dir.path(), None).await;
        assert_eq!(ok.code, Some(0), "{ok:?}");
        assert!(ok.stdout.starts_with("git version"));
        let missing = run("conductor-no-such-program", &[], dir.path(), None).await;
        assert_eq!(missing.code, None);
        assert_eq!(missing.spawn_error.as_ref().map(|e| e.code), Some("ENOENT"));
    }

    #[test]
    fn private_dir_is_a_fresh_private_dir_under_root_private() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        acl::mkdir_private(&root).unwrap();
        let a = private_dir(&root, "push-").unwrap();
        let b = private_dir(&root, "push-").unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("push-") && name.len() == "push-".len() + 6,
            "{name}"
        );
        assert_eq!(a.parent().unwrap(), root.join("private"));
        acl::assert_owner_only(&a, acl::AssertOwnerOnlyOptions::new(acl::AclKind::Dir)).unwrap();
    }
}
