//! Port of `inventory/repos.test.ts` (M2-T10 acceptance): the repo scanner on a temp tree with real
//! git. Real git, because what is under test is how the scanner drives git (refs, remotes, and the
//! hardening that keeps a planted hook or fsmonitor from running).

use super::*;
use crate::actions::open_pr::tests::{git, ps, try_symlink};
use std::sync::Mutex;

struct Tree {
    _t: tempfile::TempDir,
    tmp: PathBuf,
    root: PathBuf,
}

fn tree() -> Tree {
    let t = tempfile::tempdir().unwrap();
    let tmp = realpath(t.path()).unwrap();
    let root = tmp.join("code");
    std::fs::create_dir(&root).unwrap();
    Tree { _t: t, tmp, root }
}

/// A repo with one commit at `dir` (created), optional origin URL.
fn repo(dir: &Path, origin: Option<&str>, branch: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "--quiet", "-b", branch]);
    std::fs::write(dir.join("README.md"), "x\n").unwrap();
    git(dir, &["add", "."]);
    git(
        dir,
        &[
            "-c",
            "user.email=t@localhost",
            "-c",
            "user.name=t",
            "commit",
            "--quiet",
            "-m",
            "init",
        ],
    );
    if let Some(o) = origin {
        git(dir, &["remote", "add", "origin", o]);
    }
    dir.to_path_buf()
}

fn main_repo(dir: &Path) -> PathBuf {
    repo(dir, None, "main")
}

fn opts(roots: &[&Path]) -> ScanReposOptions {
    ScanReposOptions::new(roots.iter().map(|p| p.to_path_buf()).collect())
}

fn paths(repos: &[InventoryRepo]) -> Vec<String> {
    repos.iter().map(|r| r.path.to_string()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| js_str_cmp(a, b));
    v
}

fn remote_of(repos: &[InventoryRepo], p: &Path) -> Option<Option<String>> {
    repos
        .iter()
        .find(|r| r.path.as_str() == ps(p))
        .map(|r| r.remote.clone())
}

#[tokio::test]
async fn finds_repos_at_depth_1_to_6_not_7() {
    let t = tree();
    let r = &t.root;
    let deep = |top: &str, n: usize| {
        let mut p = r.join(top);
        for _ in 1..n {
            p = p.join("x");
        }
        p
    };
    let want = sorted(
        [
            main_repo(&deep("a", 1)),
            main_repo(&deep("b", 2)),
            main_repo(&deep("d", 4)),
            // e.g. ~/Documents/code/github.com/org/repo under a home-dir root
            main_repo(&deep("e", 5)),
            main_repo(&deep("f", 6)),
        ]
        .iter()
        .map(|p| ps(p))
        .collect(),
    );
    main_repo(&deep("g", 7));
    let found: Vec<String> = find_work_trees(std::slice::from_ref(r), &no_log())
        .iter()
        .map(|p| ps(p))
        .collect();
    assert_eq!(sorted(found), want);
    assert_eq!(paths(&scan_repos(&opts(&[r])).await), want);
}

#[tokio::test]
async fn skips_node_modules_dot_directories_and_symlinks() {
    let t = tree();
    let r = &t.root;
    let real = main_repo(&r.join("real"));
    main_repo(&r.join("node_modules").join("pkg"));
    main_repo(&r.join(".cache").join("hidden"));
    let outside = main_repo(&t.tmp.join("outside").join("linked"));
    let linked = try_symlink(&t.tmp.join("outside"), &r.join("via-dir-link")).is_some()
        && try_symlink(&outside, &r.join("repo-link")).is_some();
    if !linked {
        eprintln!("symlink half skipped");
    }
    assert_eq!(
        find_work_trees(std::slice::from_ref(r), &no_log()),
        vec![real.clone()]
    );
    assert_eq!(paths(&scan_repos(&opts(&[r])).await), vec![ps(&real)]);
}

#[tokio::test]
async fn canonicalises_origin_and_no_origin_is_null() {
    let t = tree();
    let r = &t.root;
    let scp = repo(&r.join("scp"), Some("git@github.com:org/app.git"), "main");
    let https = repo(&r.join("https"), Some("https://github.com/org/app"), "main");
    let upper = repo(
        &r.join("upper"),
        Some("https://GitHub.com/Org/App.git"),
        "main",
    );
    let none = main_repo(&r.join("none"));
    let repos = scan_repos(&opts(&[r])).await;
    assert_eq!(
        remote_of(&repos, &scp),
        Some(Some("github.com/org/app".into()))
    );
    assert_eq!(
        remote_of(&repos, &https),
        Some(Some("github.com/org/app".into()))
    );
    assert_eq!(
        remote_of(&repos, &upper),
        Some(Some("github.com/Org/App".into()))
    );
    assert_eq!(remote_of(&repos, &none), Some(None));
    for x in &repos {
        assert_eq!(
            inventory_repo_problem(
                &x.path,
                x.remote.as_deref(),
                &x.default_branch,
                &x.head_commit
            ),
            None
        );
    }
}

#[tokio::test]
async fn a_remote_that_is_not_canonical_is_null_for_that_repo_only() {
    let t = tree();
    let r = &t.root;
    let file = repo(&r.join("file"), Some("file:///srv/git/app.git"), "main");
    let http = repo(&r.join("http"), Some("http://github.com/org/app"), "main");
    let port = repo(
        &r.join("port"),
        Some("ssh://git@github.com:22/org/app.git"),
        "main",
    );
    let good = repo(&r.join("good"), Some("git@github.com:org/good.git"), "main");
    let repos = scan_repos(&opts(&[r])).await;
    assert_eq!(repos.len(), 4);
    assert_eq!(remote_of(&repos, &file), Some(None));
    assert_eq!(remote_of(&repos, &http), Some(None));
    assert_eq!(remote_of(&repos, &port), Some(None));
    assert_eq!(
        remote_of(&repos, &good),
        Some(Some("github.com/org/good".into()))
    );
}

#[tokio::test]
async fn allowed_repo_hosts_another_host_is_reported_with_remote_null() {
    let t = tree();
    let r = &t.root;
    let gl = repo(&r.join("gl"), Some("git@gitlab.com:org/app.git"), "main");
    let gh = repo(&r.join("gh"), Some("git@github.com:org/app.git"), "main");
    let mut o = opts(&[r]);
    o.allowed_repo_hosts = vec!["github.com".into()];
    let repos = scan_repos(&o).await;
    assert_eq!(remote_of(&repos, &gl), Some(None));
    assert_eq!(
        remote_of(&repos, &gh),
        Some(Some("github.com/org/app".into()))
    );
    assert_eq!(
        canonical_remote("git@gitlab.com:org/app.git", &[]).as_deref(),
        Some("gitlab.com/org/app")
    );
    // Hosts compare case-insensitively.
    assert_eq!(
        canonical_remote("git@github.com:org/app.git", &["GitHub.com".into()]).as_deref(),
        Some("github.com/org/app")
    );
}

#[tokio::test]
async fn a_repo_without_commits_is_not_reported() {
    let t = tree();
    let empty = t.root.join("empty");
    std::fs::create_dir(&empty).unwrap();
    git(&empty, &["init", "--quiet"]);
    assert_eq!(scan_repos(&opts(&[&t.root])).await, vec![]);
}

#[tokio::test]
async fn default_branch_head_commit_and_mode() {
    let t = tree();
    let r = &t.root;
    let upstream = repo(&t.tmp.join("upstream"), None, "trunk");
    let cloned = r.join("cloned");
    git(&t.tmp, &["clone", "--quiet", &ps(&upstream), &ps(&cloned)]);
    let master = repo(&r.join("m"), None, "master");
    let main = main_repo(&r.join("n"));
    let mut o = opts(&[r]);
    o.modes.insert(ps(&main), WorkingCopyMode::Checkout);
    let repos = scan_repos(&o).await;
    let by = |p: &Path| repos.iter().find(|x| x.path.as_str() == ps(p)).unwrap();
    assert_eq!(by(&cloned).default_branch.as_str(), "trunk");
    assert_eq!(by(&master).default_branch.as_str(), "master");
    assert_eq!(by(&main).default_branch.as_str(), "main");
    assert_eq!(
        by(&main).head_commit.as_str(),
        git(&main, &["rev-parse", "HEAD"]).trim()
    );
    assert_eq!(by(&main).mode, WorkingCopyMode::Checkout);
    assert_eq!(by(&master).mode, WorkingCopyMode::Reference);
}

#[tokio::test]
async fn a_planted_hook_hooks_path_or_fsmonitor_never_runs() {
    let t = tree();
    let r = repo(
        &t.root.join("evil"),
        Some("git@github.com:org/evil.git"),
        "main",
    );
    let marker = t.tmp.join("pwned");
    let script = format!("#!/bin/sh\ntouch '{}'\n", ps(&marker).replace('\\', "/"));
    let exec_file = |p: &Path| {
        std::fs::write(p, &script).unwrap();
        platform::fs::set_executable(p).unwrap();
    };
    for h in [
        "post-checkout",
        "post-index-change",
        "reference-transaction",
    ] {
        exec_file(&r.join(".git").join("hooks").join(h));
    }
    let evil_hooks = t.tmp.join("evil-hooks");
    std::fs::create_dir(&evil_hooks).unwrap();
    exec_file(&evil_hooks.join("post-checkout"));
    exec_file(&t.tmp.join("fsmon.sh"));
    git(&r, &["config", "core.hooksPath", &ps(&evil_hooks)]);
    git(
        &r,
        &["config", "core.fsmonitor", &ps(&t.tmp.join("fsmon.sh"))],
    );
    let repos = scan_repos(&opts(&[&t.root])).await;
    assert_eq!(paths(&repos), vec![ps(&r)]);
    assert!(!marker.exists(), "a planted hook ran");
}

#[tokio::test]
async fn test_remote_aliases_give_a_local_repo_a_canonical_remote() {
    let t = tree();
    let r = main_repo(&t.root.join("fixture"));
    let mut o = opts(&[&t.root]);
    o.test_remote_aliases
        .insert(r.clone(), "github.com/benjgrad/fixture-app".into());
    let repos = scan_repos(&o).await;
    assert_eq!(
        repos[0].remote.as_deref(),
        Some("github.com/benjgrad/fixture-app")
    );
}

#[tokio::test]
async fn a_missing_root_is_skipped_the_others_still_scanned() {
    let t = tree();
    let r = main_repo(&t.root.join("ok"));
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut o = opts(&[&t.tmp.join("nope"), &t.root]);
    let sink = logs.clone();
    o.log = Arc::new(move |m| sink.lock().unwrap().push(m.to_string()));
    let repos = scan_repos(&o).await;
    assert_eq!(paths(&repos), vec![ps(&r)]);
    assert!(logs.lock().unwrap().join("\n").contains("nope"));
}

#[test]
fn inventory_absolute_path_is_the_shared_rule() {
    for ok in ["/a", "/Users/x/code", "C:\\code\\app", "c:/code/app"] {
        assert!(is_inventory_absolute_path(ok), "{ok}");
    }
    for bad in [
        "/",
        "",
        "a/b",
        "//srv/share",
        "/a/../b",
        "/a/./b",
        "C:foo",
        "C:\\a\\..\\b",
        "C:\\a:b",
        "\\\\srv\\share",
        "/a\0b",
    ] {
        assert!(!is_inventory_absolute_path(bad), "{bad:?}");
    }
}

#[test]
fn repo_problems_name_the_field() {
    let sha = "a".repeat(40);
    assert_eq!(inventory_repo_problem("/a", None, "main", &sha), None);
    assert!(
        inventory_repo_problem("/a", Some("nope"), "main", &sha)
            .unwrap()
            .starts_with("remote")
    );
    for b in ["", "-x", "a..b", "a b", &"x".repeat(256)] {
        assert!(
            inventory_repo_problem("/a", None, b, &sha)
                .unwrap()
                .starts_with("default_branch"),
            "{b:?}"
        );
    }
    assert!(
        inventory_repo_problem("/a", None, "main", "abc")
            .unwrap()
            .starts_with("head_commit")
    );
    assert!(inventory_repo_problem("/a", None, "main", &"0".repeat(64)).is_none());
}

#[test]
fn js_str_cmp_is_utf16_order() {
    use std::cmp::Ordering;
    // U+FF01 sorts after U+1F600 in UTF-16 (0xFF01 > 0xD83D), before it in UTF-8 bytes.
    assert_eq!(js_str_cmp("\u{ff01}", "\u{1f600}"), Ordering::Greater);
    assert!("\u{ff01}".as_bytes() < "\u{1f600}".as_bytes());
    assert_eq!(js_str_cmp("a", "b"), Ordering::Less);
}
