//! R2: the worktree setup's command, skip marker and prompt block. Real git only where the git
//! dir of a linked worktree is what's under test.

use super::*;
use crate::actions::open_pr::tests::{commit, git, private_tmp, ps};

fn dir_with(files: &[(&str, &str)]) -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    for (f, c) in files {
        std::fs::write(t.path().join(f), c).unwrap();
    }
    t
}

#[test]
fn the_command_follows_the_check_checkouts_auto_detect() {
    let pnpm = dir_with(&[("package.json", "{}"), ("pnpm-lock.yaml", "x")]);
    assert_eq!(
        worktree_setup_cmd(pnpm.path(), None).as_deref(),
        Some("pnpm install --frozen-lockfile")
    );
    let yarn = dir_with(&[("package.json", "{}"), ("yarn.lock", "x")]);
    assert_eq!(
        worktree_setup_cmd(yarn.path(), None).as_deref(),
        Some("yarn install --immutable")
    );
    let npm = dir_with(&[("package.json", "{}"), ("package-lock.json", "{}")]);
    assert_eq!(
        worktree_setup_cmd(npm.path(), None).as_deref(),
        Some("npm ci")
    );
}

#[test]
fn a_bare_package_json_installs_without_writing_a_lockfile() {
    let bare = dir_with(&[("package.json", "{}")]);
    assert_eq!(
        worktree_setup_cmd(bare.path(), None).as_deref(),
        Some(BARE_NPM_INSTALL)
    );
}

#[test]
fn an_override_wins_and_empty_means_none() {
    let pnpm = dir_with(&[("pnpm-lock.yaml", "x")]);
    assert_eq!(worktree_setup_cmd(pnpm.path(), Some("")), None);
    assert_eq!(worktree_setup_cmd(pnpm.path(), Some("  ")), None);
    assert_eq!(
        worktree_setup_cmd(pnpm.path(), Some("make deps")).as_deref(),
        Some("make deps")
    );
    let empty = dir_with(&[("README.md", "x")]);
    assert_eq!(worktree_setup_cmd(empty.path(), None), None);
    assert_eq!(
        worktree_setup_cmd(empty.path(), Some("cargo fetch")).as_deref(),
        Some("cargo fetch")
    );
}

#[test]
fn the_key_changes_with_the_command_and_the_lockfiles() {
    let d = dir_with(&[("pnpm-lock.yaml", "a")]);
    let k = setup_key(d.path(), "pnpm i");
    assert_eq!(k, setup_key(d.path(), "pnpm i"));
    assert_ne!(k, setup_key(d.path(), "pnpm install"));
    std::fs::write(d.path().join("pnpm-lock.yaml"), "b").unwrap();
    let k2 = setup_key(d.path(), "pnpm i");
    assert_ne!(k, k2);
    std::fs::write(d.path().join("Cargo.lock"), "c").unwrap();
    assert_ne!(k2, setup_key(d.path(), "pnpm i"));
    // A file outside the key does not matter.
    let k3 = setup_key(d.path(), "pnpm i");
    std::fs::write(d.path().join("src.rs"), "x").unwrap();
    assert_eq!(k3, setup_key(d.path(), "pnpm i"));
}

/// A clone and a linked worktree: the marker must live in the worktree's own git dir.
fn worktree() -> (tempfile::TempDir, PathBuf) {
    let (t, tmp) = private_tmp();
    let clone = tmp.join("clone");
    std::fs::create_dir(&clone).unwrap();
    git(&clone, &["init", "--quiet", "-b", "main"]);
    std::fs::write(clone.join("package.json"), "{}\n").unwrap();
    std::fs::write(clone.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();
    git(&clone, &["add", "."]);
    commit(&clone, "init");
    let wt = tmp.join("wt");
    git(
        &clone,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "conductor/t/1",
            &ps(&wt),
        ],
    );
    (t, wt)
}

#[tokio::test]
async fn a_successful_setup_is_skipped_until_the_lockfile_or_the_command_changes() {
    let (_t, wt) = worktree();
    let Plan::Run { cmd, key, git_dir } = plan(&wt, None).await else {
        panic!("a new worktree runs its setup");
    };
    assert_eq!(cmd, "pnpm install --frozen-lockfile");
    let git_dir = git_dir.expect("a worktree has a git dir");
    // The worktree's own git dir, outside the work tree: never committed, never dirty.
    assert!(!git_dir.starts_with(&wt));
    assert!(git_dir.to_string_lossy().contains("worktrees"));
    mark_done(&git_dir, &key);
    assert_eq!(plan(&wt, None).await, Plan::Skip("up to date"));
    assert_eq!(git(&wt, &["status", "--porcelain"]).trim(), "");

    // A changed command runs again.
    assert!(matches!(
        plan(&wt, Some("make deps")).await,
        Plan::Run { .. }
    ));
    // A changed lockfile runs again.
    std::fs::write(wt.join("pnpm-lock.yaml"), "lockfileVersion: '9.1'\n").unwrap();
    let Plan::Run { key, .. } = plan(&wt, None).await else {
        panic!("a changed lockfile runs the setup again");
    };
    mark_done(&git_dir, &key);
    assert_eq!(plan(&wt, None).await, Plan::Skip("up to date"));
    // A failure clears the marker.
    clear(&git_dir);
    assert!(matches!(plan(&wt, None).await, Plan::Run { .. }));
}

#[tokio::test]
async fn the_git_dir_read_from_dot_git_is_the_one_git_reports() {
    let (_t, wt) = worktree();
    let fast = git_dir_from_dotgit(&wt).expect("a linked worktree's .git file");
    let reported = git(&wt, &["rev-parse", "--absolute-git-dir"]);
    assert_eq!(
        std::fs::canonicalize(&fast).unwrap(),
        std::fs::canonicalize(reported.trim()).unwrap()
    );
    // A plain repo: its .git directory.
    let plain = tempfile::tempdir().unwrap();
    git(plain.path(), &["init", "--quiet"]);
    assert_eq!(
        git_dir_from_dotgit(plain.path()),
        Some(plain.path().join(".git"))
    );
    // Neither: no answer (the caller asks git).
    let none = tempfile::tempdir().unwrap();
    assert_eq!(git_dir_from_dotgit(none.path()), None);
}

#[tokio::test]
async fn no_setup_is_a_skip() {
    let (_t, wt) = worktree();
    assert_eq!(plan(&wt, Some("")).await, Plan::Skip("none"));
}

#[test]
fn the_failure_block_says_whose_problem_it_is() {
    let fail = failure_block(
        "pnpm install --frozen-lockfile",
        false,
        "exit code 1",
        "ERR_PNPM_OUTDATED_LOCKFILE\n",
        SetupOnBase::Fail,
        Some("main"),
    );
    assert!(fail.starts_with("## Setup failed\n"));
    assert!(fail.contains("`pnpm install --frozen-lockfile` (auto-detected from the lockfile)"));
    assert!(fail.contains("(exit code 1)"));
    assert!(fail.contains("```\nERR_PNPM_OUTDATED_LOCKFILE\n```"));
    assert!(fail.contains("fails on origin/main too"));
    assert!(fail.contains("not your branch"));
    assert!(fail.contains("ask_user"));

    let pass = failure_block(
        "make deps",
        true,
        "exit code 2",
        "",
        SetupOnBase::Pass,
        Some("main"),
    );
    assert!(pass.contains("(from the repo checks override)"));
    assert!(pass.contains("It printed nothing."));
    assert!(pass.contains("passes on origin/main, so a change on this branch broke it"));

    let unknown = failure_block("x", true, "exit code 1", "out", SetupOnBase::Unknown, None);
    assert!(unknown.contains("could not tell"));
}

#[test]
fn failure_how_names_exit_timeout_and_signal() {
    let r = |exit_code, signal: Option<&str>, timed_out| CommandResult {
        exit_code,
        signal: signal.map(String::from),
        timed_out,
        duration_ms: 0,
        output_tail: String::new(),
    };
    assert_eq!(failure_how(&r(Some(1), None, false)), "exit code 1");
    assert_eq!(
        failure_how(&r(None, Some("SIGKILL"), true)),
        "it timed out after 15m"
    );
    assert_eq!(
        failure_how(&r(None, Some("SIGTERM"), false)),
        "killed by SIGTERM"
    );
}
