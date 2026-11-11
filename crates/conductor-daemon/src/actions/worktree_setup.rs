//! R2 (07 §Worktree setup): the repo's setup, run in the agent's own worktree before Claude
//! starts, so the agent finds its dependencies installed.
//!
//! The command is the repo checks override's `setup` (`start_session.worktree_setup`), else the
//! check checkout's lockfile auto-detect (M2-T30). A bare `package.json` runs
//! `npm install --no-package-lock …`: a plain `npm install` would leave an untracked
//! `package-lock.json` in the worktree, which fails every later `require_clean` entry check.
//!
//! A successful run leaves a marker under the worktree's own git dir (never in the work tree, so
//! it is never committed or seen by `git status`) holding a key over the command and the
//! lockfiles; the next start skips the setup while the key is unchanged. A failed run clears it.

use crate::actions::checkout::{SetupOnBase, detect_package_manager, detect_setup};
use crate::commands::runner::CommandResult;
use crate::exec::{self, no_hooks, sv};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long the setup (and its base-branch probe) may run: a check's default timeout.
pub const WORKTREE_SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The worktree setup for a repo with only a `package.json` (no lockfile).
pub const BARE_NPM_INSTALL: &str = "npm install --no-package-lock --no-audit --no-fund";

/// The files whose content is part of the skip key: when one changes, the setup runs again.
pub const KEY_FILES: &[&str] = &[
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "package.json",
    "Cargo.lock",
];

/// FR-4: agents (and the setup) never wait on corepack's download prompt.
pub const COREPACK_ENV: (&str, &str) = ("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");

/// The marker's file name, in the worktree's git dir.
pub const MARKER: &str = "conductor-worktree-setup";

/// The setup for the worktree at `dir`: `configured` when set (`""` = none), else the check
/// checkout's auto-detect, with [`BARE_NPM_INSTALL`] for a bare `package.json`.
pub fn worktree_setup_cmd(dir: &Path, configured: Option<&str>) -> Option<String> {
    if configured.is_some() {
        return detect_setup(dir, configured);
    }
    let d = detect_package_manager(dir)?;
    Some(if d.lockfile.is_none() {
        BARE_NPM_INSTALL.to_string()
    } else {
        d.install.to_string()
    })
}

/// The skip key: sha256 over the command and the content of each of [`KEY_FILES`] (or its
/// absence) in `dir`.
pub fn setup_key(dir: &Path, cmd: &str) -> String {
    let mut h = Sha256::new();
    h.update(cmd.as_bytes());
    for f in KEY_FILES {
        h.update(b"\0");
        h.update(f.as_bytes());
        h.update(b":");
        match std::fs::read(dir.join(f)) {
            Ok(bytes) => h.update(hex::encode(Sha256::digest(&bytes)).as_bytes()),
            Err(_) => h.update(b"-"),
        }
    }
    hex::encode(h.finalize())
}

/// The worktree's own git dir (`<clone>/.git/worktrees/<name>` for a linked worktree). Read from
/// `<worktree>/.git` without a process when it can be (a linked worktree's `gitdir:` file, or a
/// plain `.git` directory): a start that skips its setup must not wait on a `git` spawn, which
/// widens the window before `started`. Else `git rev-parse --absolute-git-dir`.
pub async fn git_dir(worktree: &Path) -> Option<PathBuf> {
    if let Some(d) = git_dir_from_dotgit(worktree) {
        return Some(d);
    }
    let mut a = no_hooks();
    a.extend(sv(&["rev-parse", "--absolute-git-dir"]));
    let r = exec::run("git", &a, worktree, None).await;
    let out = r.stdout.trim();
    (r.code == Some(0) && !out.is_empty()).then(|| PathBuf::from(out))
}

/// `<worktree>/.git` read directly: a directory is the git dir, a `gitdir: <path>` file names it
/// (relative to the worktree when not absolute). None: neither, or the target isn't a directory.
pub fn git_dir_from_dotgit(worktree: &Path) -> Option<PathBuf> {
    let dotgit = worktree.join(".git");
    let meta = std::fs::symlink_metadata(&dotgit).ok()?;
    if meta.is_dir() {
        return Some(dotgit);
    }
    if !meta.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dotgit).ok()?;
    let target = text.lines().next()?.strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let p = Path::new(target);
    let p = if p.is_absolute() {
        p.to_path_buf()
    } else {
        worktree.join(p)
    };
    p.is_dir().then_some(p)
}

/// True when the last successful setup in this worktree had `key`.
pub fn is_current(git_dir: &Path, key: &str) -> bool {
    std::fs::read_to_string(git_dir.join(MARKER)).is_ok_and(|s| s.trim() == key)
}

/// Record a successful setup with `key` (temp file + rename). Errors are ignored: the next
/// start then runs the setup again.
pub fn mark_done(git_dir: &Path, key: &str) {
    let tmp = git_dir.join(format!("{MARKER}.tmp"));
    if std::fs::write(&tmp, format!("{key}\n")).is_ok()
        && std::fs::rename(&tmp, git_dir.join(MARKER)).is_err()
    {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Forget the last successful setup (after a failure), so the next start runs it again.
pub fn clear(git_dir: &Path) {
    let _ = std::fs::remove_file(git_dir.join(MARKER));
}

/// What a start needs to do in its worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Nothing to run: `"none"` (no setup for this repo) or `"up to date"` (the marker matches).
    Skip(&'static str),
    /// Run `cmd`; on success [`mark_done`] in `git_dir` (None: no marker can be kept).
    Run {
        cmd: String,
        key: String,
        git_dir: Option<PathBuf>,
    },
}

/// The setup plan for `worktree` (`configured`: `start_session.worktree_setup`).
pub async fn plan(worktree: &Path, configured: Option<&str>) -> Plan {
    let Some(cmd) = worktree_setup_cmd(worktree, configured) else {
        return Plan::Skip("none");
    };
    let key = setup_key(worktree, &cmd);
    let git_dir = git_dir(worktree).await;
    if git_dir.as_deref().is_some_and(|g| is_current(g, &key)) {
        return Plan::Skip("up to date");
    }
    Plan::Run { cmd, key, git_dir }
}

/// How a setup run failed, for the prompt.
pub fn failure_how(r: &CommandResult) -> String {
    if r.timed_out {
        return format!(
            "it timed out after {}",
            crate::actions::checkout::format_duration(WORKTREE_SETUP_TIMEOUT)
        );
    }
    match (r.exit_code, &r.signal) {
        (Some(c), _) => format!("exit code {c}"),
        (None, Some(s)) => format!("killed by {s}"),
        (None, None) => "it did not run".to_string(),
    }
}

/// The `## Setup failed` section of the agent's prompt (05 §Setup failures: whose problem it is).
pub fn failure_block(
    cmd: &str,
    from_override: bool,
    how: &str,
    tail: &str,
    verdict: SetupOnBase,
    base: Option<&str>,
) -> String {
    let source = if from_override {
        "from the repo checks override"
    } else {
        "auto-detected from the lockfile"
    };
    let base = base.map_or_else(|| "the base branch".to_string(), |b| format!("origin/{b}"));
    let tail = tail.trim_end();
    let output = if tail.is_empty() {
        "It printed nothing.".to_string()
    } else {
        format!("Last output:\n```\n{tail}\n```")
    };
    let whose = match verdict {
        SetupOnBase::Fail => format!(
            "It fails on {base} too, so this is the repo's environment or conductor's setup, not \
             your branch. Don't spend turns repairing it. If your step needs the dependencies, \
             call ask_user (with proposed_checks if you know a setup that works); otherwise carry \
             on and mention it in your summary."
        ),
        SetupOnBase::Pass => format!(
            "It passes on {base}, so a change on this branch broke it: fix that as part of your \
             work."
        ),
        SetupOnBase::Unknown => {
            "Conductor could not tell whether it fails on the base branch too. \
             If you can't fix it quickly, call ask_user."
                .to_string()
        }
    };
    format!(
        "## Setup failed\nBefore starting you, conductor ran `{cmd}` ({source}) in this worktree, \
         and it failed ({how}). {output}\n\n{whose}"
    )
}

#[cfg(test)]
mod tests;
