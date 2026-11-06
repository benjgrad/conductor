//! Port of `checkout.test.ts`. A shared clone + session worktree like the daemon's, with real git:
//! the fetch / checkout hardening (planted filter drivers and hooks) is git behaviour.

use super::*;
use crate::actions::open_pr::tests::{commit, git, is_private_dir, private_tmp, ps, try_symlink};
use crate::platform::Platform;
use crate::test_support::fake_bin::write_fake_bin;

const BRANCH: &str = "conductor/ticket/abcd1234";

struct Fx {
    _t: tempfile::TempDir,
    tmp: PathBuf,
    clone: PathBuf,
    worktree: PathBuf,
    root: PathBuf,
    head: String,
}

impl Fx {
    fn new() -> Fx {
        let (t, tmp) = private_tmp();
        let origin = tmp.join("origin");
        std::fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "--quiet", "-b", "main"]);
        std::fs::write(
            origin.join("package.json"),
            "{\"name\":\"x\",\"version\":\"0.0.0\"}\n",
        )
        .unwrap();
        std::fs::write(origin.join(".gitignore"), "ignored/\n").unwrap();
        git(&origin, &["add", "."]);
        commit(&origin, "init");
        let clone = tmp.join("clone");
        git(&tmp, &["clone", "--quiet", &ps(&origin), &ps(&clone)]);
        let worktree = tmp.join("wt");
        git(
            &clone,
            &["worktree", "add", "--quiet", "-b", BRANCH, &ps(&worktree)],
        );
        std::fs::write(worktree.join("health.txt"), "committed\n").unwrap();
        git(&worktree, &["add", "."]);
        commit(&worktree, "health");
        let head = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        let root = tmp.join("daemon-root");
        acl::mkdir_private(&root).unwrap(); // <root>/private needs a private parent
        Fx {
            _t: t,
            tmp,
            clone,
            worktree,
            root,
            head,
        }
    }

    async fn fresh(&self, sha: &str) -> FreshCheckout {
        fresh_checkout(&FreshCheckoutInput {
            root: self.root.clone(),
            worktree: self.worktree.clone(),
            branch: BRANCH.into(),
            sha: sha.into(),
            env: None,
            timeout: None,
        })
        .await
    }

    async fn fresh_dir(&self, sha: &str) -> PathBuf {
        match self.fresh(sha).await {
            FreshCheckout::Ok { dir, .. } => dir,
            FreshCheckout::Err { error, .. } => panic!("{error}"),
        }
    }
}

fn read_lf(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap().replace("\r\n", "\n")
}

#[tokio::test]
async fn checks_out_exactly_the_commit_in_a_private_dir() {
    let f = Fx::new();
    std::fs::create_dir(f.worktree.join("ignored")).unwrap();
    std::fs::write(f.worktree.join("ignored/make-tests-pass"), "x").unwrap();
    std::fs::write(f.worktree.join("health.txt"), "uncommitted\n").unwrap();
    let dir = f.fresh_dir(&f.head).await;
    assert!(ps(&dir).starts_with(&ps(&f.root.join("private").join("check-"))));
    assert!(is_private_dir(&dir));
    assert_eq!(read_lf(&dir.join("health.txt")), "committed\n");
    assert!(!dir.join("ignored/make-tests-pass").exists());
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]).trim(), f.head);
    for l in git(&dir, &["config", "--local", "--list"]).trim().lines() {
        let k = l.split('=').next().unwrap();
        assert!(
            k.starts_with("core.") || k.starts_with("remote.") || k.starts_with("branch."),
            "{k}"
        );
    }
    remove_checkout(&dir);
    assert!(!dir.exists());
}

#[tokio::test]
async fn a_planted_filter_driver_or_hooks_do_not_execute() {
    let f = Fx::new();
    let marker = f.tmp.join("pwned");
    std::fs::write(f.worktree.join(".gitattributes"), "* filter=evil\n").unwrap();
    git(&f.worktree, &["add", ".gitattributes"]);
    commit(&f.worktree, "attributes");
    let sha = git(&f.worktree, &["rev-parse", "HEAD"]).trim().to_string();
    let m = ps(&marker);
    git(
        &f.clone,
        &[
            "config",
            "filter.evil.smudge",
            &format!("sh -c 'touch {m}; cat'"),
        ],
    );
    git(
        &f.clone,
        &[
            "config",
            "filter.evil.clean",
            &format!("sh -c 'touch {m}; cat'"),
        ],
    );
    git(&f.clone, &["config", "core.hooksPath", &ps(&f.tmp)]);
    std::fs::write(
        f.tmp.join("post-checkout"),
        format!("#!/bin/sh\ntouch '{m}'\n"),
    )
    .unwrap();
    let dir = f.fresh_dir(&sha).await;
    assert!(!marker.exists());
    assert_eq!(read_lf(&dir.join("health.txt")), "committed\n");
}

#[tokio::test]
async fn refuses_when_the_tip_is_not_the_commit_reporting_the_tip() {
    let f = Fx::new();
    std::fs::write(f.worktree.join("later.txt"), "x").unwrap();
    git(&f.worktree, &["add", "."]);
    commit(&f.worktree, "later");
    let tip = git(&f.worktree, &["rev-parse", "HEAD"]).trim().to_string();
    match f.fresh(&f.head).await {
        FreshCheckout::Err { error, head } => {
            assert!(error.contains("the branch moved"), "{error}");
            assert_eq!(head, Some(tip));
        }
        ok => panic!("{ok:?}"),
    }
    assert_eq!(
        std::fs::read_dir(f.root.join("private")).unwrap().count(),
        0
    );
}

// ---------------------------------------------------------------- 2026-11-06: the fetch

fn run(code: Option<i32>, stderr: &str) -> Run {
    Run {
        code,
        stdout: String::new(),
        stderr: stderr.into(),
        spawn_error: None,
    }
}

#[test]
fn fetch_failure_names_a_timeout_and_never_shows_an_empty_tail() {
    let hour = Duration::from_secs(3600);
    // The incident: a `--quiet` fetch killed at its limit wrote nothing.
    let t = fetch_failure(BRANCH, &run(None, ""), hour, hour);
    assert!(t.contains("timed out after 1h"), "{t}");
    assert!(t.contains(&format!("`{BRANCH}`")), "{t}");
    assert!(!t.ends_with(": "), "{t}");
    let e = fetch_failure(BRANCH, &run(Some(128), "  "), Duration::ZERO, hour);
    assert_eq!(
        e,
        format!("could not read the session branch `{BRANCH}` (git fetch exit 128): no output")
    );
    let k = fetch_failure(BRANCH, &run(None, ""), Duration::from_secs(1), hour);
    assert!(k.contains("git fetch killed): no output"), "{k}");
    let g = fetch_failure(BRANCH, &run(Some(1), "fatal: nope\n"), Duration::ZERO, hour);
    assert!(g.ends_with("(git fetch exit 1): fatal: nope"), "{g}");
}

#[test]
fn durations_read_in_the_largest_whole_unit() {
    assert_eq!(format_duration(Duration::from_secs(3600)), "1h");
    assert_eq!(format_duration(Duration::from_secs(1800)), "30m");
    assert_eq!(format_duration(Duration::from_secs(90)), "90s");
    assert_eq!(format_duration(Duration::from_millis(5)), "5ms");
    // The fetch never gets less than 30 minutes, even for a short check.
    let m = |n: u64| Duration::from_secs(60 * n);
    assert_eq!(fetch_budget(None), m(30));
    assert_eq!(fetch_budget(Some(m(1))), m(30));
    assert_eq!(fetch_budget(Some(m(60))), m(60));
}

#[tokio::test]
async fn a_fetch_over_its_budget_reports_the_timeout() {
    // Real git: the fetch's timeout is what is under test. 1 ms is always too short.
    let f = Fx::new();
    let r = fresh_checkout(&FreshCheckoutInput {
        root: f.root.clone(),
        worktree: f.worktree.clone(),
        branch: BRANCH.into(),
        sha: f.head.clone(),
        env: None,
        timeout: Some(Duration::from_millis(1)),
    })
    .await;
    match r {
        FreshCheckout::Err { error, head } => {
            assert!(error.contains("timed out after 1ms"), "{error}");
            assert_eq!(head, None);
        }
        ok => panic!("{ok:?}"),
    }
    assert_eq!(
        std::fs::read_dir(f.root.join("private")).unwrap().count(),
        0
    );
}

#[tokio::test]
async fn no_commits_ahead_only_when_the_commit_is_on_origins_default_branch() {
    // Real git: ancestry against `origin/HEAD` is git behaviour.
    let f = Fx::new();
    assert_eq!(no_commits_ahead(&f.worktree, &f.head, None).await, None);
    let spike = f.tmp.join("spike");
    git(
        &f.clone,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "conductor/spike",
            &ps(&spike),
            "origin/main",
        ],
    );
    let base = git(&spike, &["rev-parse", "HEAD"]).trim().to_string();
    assert_eq!(
        no_commits_ahead(&spike, &base, None).await.as_deref(),
        Some("origin/main")
    );
    assert_eq!(no_commits_ahead(&spike, "not-a-sha", None).await, None);
    // Unknown default branch: never block, the checks run.
    git(&f.clone, &["remote", "set-head", "origin", "--delete"]);
    assert_eq!(no_commits_ahead(&spike, &base, None).await, None);
}

#[tokio::test]
async fn setup_configured_none_or_auto_detected() {
    let f = Fx::new();
    let dir = f.fresh_dir(&f.head).await;
    assert_eq!(detect_setup(&dir, None).as_deref(), Some("npm install"));
    std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
    assert_eq!(detect_setup(&dir, None).as_deref(), Some("npm ci"));
    assert_eq!(detect_setup(&dir, Some("")), None);
    assert_eq!(
        detect_setup(&dir, Some("make deps")).as_deref(),
        Some("make deps")
    );
    assert_eq!(detect_setup(&f.tmp, None), None);
}

#[test]
fn sweep_private_does_not_follow_a_symlinked_private() {
    let f = Fx::new();
    let elsewhere = f.tmp.join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("check-victim")).unwrap();
    if try_symlink(&elsewhere, &f.root.join("private")).is_none() {
        return;
    }
    sweep_private(&f.root);
    assert!(elsewhere.join("check-victim").exists());
}

#[tokio::test]
async fn sweep_private_removes_leftovers() {
    let f = Fx::new();
    f.fresh_dir(&f.head).await;
    std::fs::create_dir(f.root.join("private").join("push-old")).unwrap();
    sweep_private(&f.root);
    assert_eq!(
        std::fs::read_dir(f.root.join("private")).unwrap().count(),
        0
    );
}

// ---------------------------------------------------------------- M2-T30 package managers

fn repo_with(parent: &Path, files: &[&str]) -> PathBuf {
    let d = tempfile::Builder::new()
        .prefix("repo-")
        .tempdir_in(parent)
        .unwrap()
        .keep();
    for f in files {
        std::fs::write(d.join(f), if *f == "package.json" { "{}" } else { "" }).unwrap();
    }
    d
}

#[test]
fn each_lockfile_names_its_manager_and_setup() {
    let t = tempfile::tempdir().unwrap();
    for (lockfile, manager, install) in [
        (
            "pnpm-lock.yaml",
            PackageManager::Pnpm,
            "pnpm install --frozen-lockfile",
        ),
        (
            "yarn.lock",
            PackageManager::Yarn,
            "yarn install --immutable",
        ),
        ("package-lock.json", PackageManager::Npm, "npm ci"),
    ] {
        let d = repo_with(t.path(), &["package.json", lockfile]);
        assert_eq!(
            detect_package_manager(&d),
            Some(DetectedManager {
                manager,
                lockfile: Some(lockfile),
                install
            })
        );
        assert_eq!(detect_setup(&d, None).as_deref(), Some(install));
        assert_eq!(
            detect_setup(&d, Some("make deps")).as_deref(),
            Some("make deps")
        );
        assert_eq!(detect_setup(&d, Some("")), None);
    }
}

#[test]
fn no_lockfile_package_json_is_npm_install_neither_is_none() {
    let t = tempfile::tempdir().unwrap();
    assert_eq!(
        detect_package_manager(&repo_with(t.path(), &["package.json"])),
        Some(DetectedManager {
            manager: PackageManager::Npm,
            lockfile: None,
            install: "npm install"
        })
    );
    assert_eq!(
        detect_setup(&repo_with(t.path(), &["package.json"]), None).as_deref(),
        Some("npm install")
    );
    assert_eq!(
        detect_package_manager(&repo_with(t.path(), &["Makefile"])),
        None
    );
    assert_eq!(
        detect_setup(&repo_with(t.path(), &["Makefile"]), None),
        None
    );
}

#[test]
fn pnpm_wins_then_yarn() {
    let t = tempfile::tempdir().unwrap();
    let all = repo_with(
        t.path(),
        &[
            "package.json",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
        ],
    );
    assert_eq!(
        detect_package_manager(&all).map(|d| d.manager),
        Some(PackageManager::Pnpm)
    );
    let two = repo_with(
        t.path(),
        &["package.json", "package-lock.json", "yarn.lock"],
    );
    assert_eq!(
        detect_package_manager(&two).map(|d| d.manager),
        Some(PackageManager::Yarn)
    );
}

#[test]
fn npm_style_checks_run_with_the_repos_manager() {
    let t = tempfile::tempdir().unwrap();
    let pnpm = repo_with(t.path(), &["package.json", "pnpm-lock.yaml"]);
    assert_eq!(managed_command(&pnpm, "npm run build"), "pnpm run build");
    assert_eq!(managed_command(&pnpm, "npm test"), "pnpm test");
    assert_eq!(
        managed_command(&pnpm, "npm run-script lint"),
        "pnpm run lint"
    );
    assert_eq!(
        managed_command(&pnpm, "npm run build && npm test -- --run"),
        "pnpm run build && pnpm test -- --run"
    );
    assert_eq!(
        managed_command(&pnpm, "npm ci; npm run x"),
        "npm ci; pnpm run x"
    );
    assert_eq!(
        managed_command(&pnpm, "echo npm run build"),
        "echo npm run build"
    );
    assert_eq!(managed_command(&pnpm, "npm testing"), "npm testing");
    let yarn = repo_with(t.path(), &["package.json", "yarn.lock"]);
    assert_eq!(managed_command(&yarn, "npm run build"), "yarn run build");
    assert_eq!(managed_command(&yarn, "npm test"), "yarn test");
    assert_eq!(
        managed_command(
            &repo_with(t.path(), &["package.json", "package-lock.json"]),
            "npm test"
        ),
        "npm test"
    );
    assert_eq!(
        managed_command(&repo_with(t.path(), &["package.json"]), "npm run build"),
        "npm run build"
    );
    assert_eq!(
        managed_command(&repo_with(t.path(), &["Makefile"]), "npm run build"),
        "npm run build"
    );
}

#[test]
fn names_a_package_manager_missing_from_path() {
    let t = tempfile::tempdir().unwrap();
    let bin = t.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    write_fake_bin(&bin, "npm", "", Platform::current()).unwrap(); // Windows: npm.cmd via PATHEXT
    std::fs::write(bin.join("yarn"), "not executable\n").unwrap();
    let b = ps(&bin);
    assert_eq!(missing_manager("npm test", Some(&b)), None);
    assert_eq!(missing_manager("make test", Some(&b)), None);
    let msg = missing_manager("pnpm install --frozen-lockfile", Some(&b)).unwrap();
    assert!(msg.contains("`pnpm` is not on this machine"), "{msg}");
    assert!(msg.contains("install pnpm"), "{msg}");
    let both = missing_manager("yarn run build && pnpm test", Some(&b)).unwrap();
    assert!(both.contains("`yarn` and `pnpm` are"), "{both}");
    assert!(
        missing_manager("npm test", Some(""))
            .unwrap()
            .contains("`npm`")
    );
}
