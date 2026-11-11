//! Ports of `workspace.test.ts` (M1-T14: repo policy, the untrusted CLAUDE.md read) and
//! `workspace.fresh-base.test.ts` (M2-T13a). The fresh-base cases run real git on temp repos:
//! the clone / fetch / worktree behaviour is what's under test.

use super::*;
use crate::platform::Platform;
use std::process::Command;
use std::sync::{Arc, Mutex};

fn policy(local: bool, hosts: &[&str]) -> RepoPolicy {
    RepoPolicy {
        allow_local_repos: local,
        allowed_repo_hosts: hosts.iter().map(|h| h.to_string()).collect(),
    }
}

fn src(repo: &str) -> Result<String, RepoNotAllowedError> {
    clone_source(repo, &RepoPolicy::default())
}

// ---------------------------------------------------------------- cloneSource policy

#[test]
fn accepts_canonical_https_and_scp() {
    assert_eq!(
        src("github.com/org/app").unwrap(),
        "https://github.com/org/app.git"
    );
    assert_eq!(
        src("github.com/org/app.git").unwrap(),
        "https://github.com/org/app.git"
    );
    assert_eq!(
        src("gitlab.example.org/group/sub/app").unwrap(),
        "https://gitlab.example.org/group/sub/app.git"
    );
    assert_eq!(
        src("https://github.com/org/app.git").unwrap(),
        "https://github.com/org/app.git"
    );
    assert_eq!(
        src("https://git.example.org:8443/org/app").unwrap(),
        "https://git.example.org:8443/org/app"
    );
    assert_eq!(
        src("git@github.com:org/app.git").unwrap(),
        "git@github.com:org/app.git"
    );
}

#[test]
fn rejects_local_unless_allowed() {
    let abs = if Platform::current().is_windows() {
        "C:\\srv\\repos\\app"
    } else {
        "/srv/repos/app"
    };
    for repo in [abs, "file:///tmp/x", "FILE:///tmp/x"] {
        let e = src(repo).unwrap_err();
        assert!(e.to_string().contains("allowLocalRepos"), "{e}");
        assert_eq!(clone_source(repo, &policy(true, &[])).unwrap(), repo);
    }
}

#[test]
fn rejects_other_schemes_and_traversal() {
    for repo in [
        "http://github.com/org/app",
        "ssh://git@github.com/org/app",
        "git://github.com/org/app",
        "ext::sh -c touch% /tmp/pwned",
        "ext::sh",
        "fd::17",
        "../other/repo",
        "./repo",
        "repo",
        "github.com/app",
        "github.com/../../etc",
        "github.com/org/..",
        "https://github.com/org/../x",
        "https://github.com/org/app?x=1",
        "https://github.com/",
        "git@github.com:/abs/path",
        "git@github.com:-oProxyCommand=x/y",
        "-uhost/org/app",
        "github.com/org/app ",
        "",
    ] {
        assert!(clone_source(repo, &policy(true, &[])).is_err(), "{repo}");
    }
}

#[test]
fn checks_allowed_repo_hosts() {
    let p = policy(false, &["github.com"]);
    assert_eq!(
        clone_source("github.com/org/app", &p).unwrap(),
        "https://github.com/org/app.git"
    );
    assert_eq!(
        clone_source("https://GitHub.com/org/app", &p).unwrap(),
        "https://GitHub.com/org/app"
    );
    assert_eq!(
        clone_source("git@github.com:org/app", &p).unwrap(),
        "git@github.com:org/app"
    );
    for repo in [
        "evil.example/org/app",
        "https://evil.example/org/app",
        "git@evil.example:org/app",
        "https://github.com.evil.example/org/app",
    ] {
        let e = clone_source(repo, &p).unwrap_err();
        assert!(e.to_string().contains("allowedRepoHosts"), "{repo}: {e}");
    }
    assert_eq!(
        clone_source("evil.example/org/app", &policy(false, &[])).unwrap(),
        "https://evil.example/org/app.git"
    );
}

#[test]
fn repo_not_allowed_message_quotes_the_repo_as_json() {
    assert_eq!(
        src("ext::sh").unwrap_err().to_string(),
        "repo not allowed: \"ext::sh\": expected host/org/repo, https://host/org/repo or user@host:org/repo"
    );
}

/// Computed by the TS `repoSlug` (node, `packages/daemon/src/workspace.ts` at daemon-ts-freeze):
/// the clone dirs under `<root>/repos` must keep their names across the upgrade.
#[test]
fn repo_slug_matches_ts() {
    for (repo, slug) in [
        ("github.com/org/app", "github.com_org_app-189a31e2"),
        (
            "https://github.com/Org/App.git",
            "github.com_Org_App.git-8d0fc7c3",
        ),
        (
            "git@github.com:org/app.git",
            "git_github.com_org_app.git-ac7c0c72",
        ),
        ("/tmp/x/origin.git", "tmp_x_origin.git-05080312"),
        ("file:///tmp/x", "tmp_x-cfeb0da7"),
        (
            "...__weird//name with spaces",
            "weird_name_with_spaces-a5bda516",
        ),
        ("", "repo-e3b0c442"),
        ("é/ü", "repo-172f7ec3"),
        (
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x/y",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_x_y-49c57e49",
        ),
        ("C:\\Users\\me\\repo", "C_Users_me_repo-0276a9fd"),
    ] {
        assert_eq!(repo_slug(repo), slug, "{repo}");
    }
}

/// The TS `inventoryDigest` of the same entry (key order repo, path, head_commit, tree_clean).
#[test]
fn inventory_digest_matches_ts() {
    let e: RepoInventoryEntry = serde_json::from_value(serde_json::json!({
        "repo": "github.com/o/r", "path": "/p", "head_commit": "abc", "tree_clean": true
    }))
    .unwrap();
    assert_eq!(
        inventory_digest(&[e]),
        "13963f9c169228c929b247441d98e8284604ffc5d3bafb4191a9c7cbc1017fa3"
    );
}

#[test]
fn locale_compare_is_case_insensitive_first() {
    let mut v = vec!["b", "A", "a", "C"];
    v.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(v, vec!["a", "A", "b", "C"]);
}

#[test]
fn parses_worktree_list_porcelain() {
    let out = "worktree /r/repos/x\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/wt/s1\nHEAD def\nbranch refs/heads/conductor/t/s1\n\n";
    assert_eq!(
        parse_worktree_holding(out, "conductor/t/s1").as_deref(),
        Some("/r/wt/s1")
    );
    assert_eq!(parse_worktree_holding(out, "conductor/t"), None);
}

// ---------------------------------------------------------------- Workspace

struct Fixture {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    wt: PathBuf,
    logs: Arc<Mutex<Vec<String>>>,
    ws: Workspace,
}

fn store_for(root: &Path) -> Arc<Mutex<DaemonStore>> {
    Arc::new(Mutex::new(DaemonStore::for_root(root).unwrap()))
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let wt = dir.join("wt").join("s1");
    std::fs::create_dir_all(&wt).unwrap();
    let logs = Arc::new(Mutex::new(Vec::new()));
    let sink = logs.clone();
    let root = dir.join("root");
    let ws = Workspace::new(
        &root,
        store_for(&root),
        WorkspaceOptions {
            log: Some(Box::new(move |m| sink.lock().unwrap().push(m.to_string()))),
            ..Default::default()
        },
    );
    Fixture {
        _tmp: tmp,
        dir,
        wt,
        logs,
        ws,
    }
}

impl Fixture {
    fn logs(&self) -> String {
        self.logs.lock().unwrap().join("\n")
    }
}

/// A symlink, or None where the OS refuses one (Windows without Developer Mode).
fn try_symlink(target: &Path, link: &Path) -> Option<()> {
    match platform::fs::symlink(target, link) {
        Ok(()) => Some(()),
        Err(e) if Platform::current().is_windows() => {
            eprintln!("skipped: no symlinks here ({e})");
            None
        }
        Err(e) => panic!("symlink: {e}"),
    }
}

#[tokio::test]
async fn ensure_worktree_refuses_a_local_repo_before_cloning() {
    let f = fixture();
    let origin = p2s(&f.dir.join("origin"));
    for repo in [origin.as_str(), "ext::sh"] {
        let e =
            f.ws.ensure_worktree(&EnsureWorktree {
                repo: repo.to_string(),
                session_id: "s1".into(),
                branch: "b".into(),
                base_ref: "HEAD".into(),
                default_branch: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(e, WorkspaceError::RepoNotAllowed(_)), "{e}");
    }
    assert!(!f.dir.join("root").join("repos").exists());
}

#[test]
fn reads_a_regular_claude_md() {
    let f = fixture();
    std::fs::write(f.wt.join("CLAUDE.md"), "# hi\n").unwrap();
    assert_eq!(f.ws.read_claude_md(&f.wt).as_deref(), Some("# hi\n"));
    assert_eq!(f.logs(), "");
}

#[test]
fn absent_claude_md_is_none_without_a_log_line() {
    let f = fixture();
    assert_eq!(f.ws.read_claude_md(&f.wt), None);
    assert_eq!(f.logs(), "");
}

#[test]
fn skips_a_claude_md_symlink_and_logs_it() {
    let f = fixture();
    let secret = f.dir.join("secret.txt");
    std::fs::write(&secret, "TOKEN=hunter2\n").unwrap();
    if try_symlink(&secret, &f.wt.join("CLAUDE.md")).is_none() {
        return;
    }
    assert_eq!(f.ws.read_claude_md(&f.wt), None);
    assert!(f.logs().contains("symlink"), "{}", f.logs());

    std::fs::remove_file(f.wt.join("CLAUDE.md")).unwrap();
    std::fs::write(f.wt.join("real.md"), "inside\n").unwrap();
    try_symlink(&f.wt.join("real.md"), &f.wt.join("CLAUDE.md")).unwrap();
    assert_eq!(f.ws.read_claude_md(&f.wt), None);
}

#[test]
fn resolves_the_worktree_path_through_symlinks() {
    let f = fixture();
    let real = f.dir.join("real-wt");
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("CLAUDE.md"), "ok\n").unwrap();
    let linked = f.dir.join("wt").join("linked");
    if try_symlink(&real, &linked).is_none() {
        return;
    }
    assert_eq!(f.ws.read_claude_md(&linked).as_deref(), Some("ok\n"));
}

#[test]
fn skips_a_dir_named_claude_md_and_a_file_over_64_kb() {
    let f = fixture();
    std::fs::create_dir(f.wt.join("CLAUDE.md")).unwrap();
    assert_eq!(f.ws.read_claude_md(&f.wt), None);
    assert!(f.logs().contains("not a regular file"));
    std::fs::remove_dir(f.wt.join("CLAUDE.md")).unwrap();

    let max = MAX_CLAUDE_MD_BYTES as usize;
    std::fs::write(f.wt.join("CLAUDE.md"), "x".repeat(max + 1)).unwrap();
    assert_eq!(f.ws.read_claude_md(&f.wt), None);
    assert!(f.logs().contains("larger than 65536 bytes"));

    std::fs::write(f.wt.join("CLAUDE.md"), "x".repeat(max)).unwrap();
    assert_eq!(f.ws.read_claude_md(&f.wt).map(|s| s.len()), Some(max));
}

// ---------------------------------------------------------------- fresh base (M2-T13a)

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn g(cwd: &Path, args: &[&str]) -> String {
    run_git(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

struct FreshBase {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    origin: PathBuf,
    author: PathBuf,
    root: PathBuf,
    ws: Workspace,
}

impl FreshBase {
    fn new(env: Option<Env>) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let origin = dir.join("origin.git");
        let author = dir.join("author");
        // A non-"main" default branch, so the test proves origin/HEAD is followed.
        g(
            &dir,
            &[
                "init",
                "-q",
                "--bare",
                "--initial-branch=trunk",
                &p2s(&origin),
            ],
        );
        g(&dir, &["clone", "-q", &p2s(&origin), &p2s(&author)]);
        g(&author, &["checkout", "-q", "-b", "trunk"]);
        let root = dir.join("root");
        let ws = Workspace::new(
            &root,
            store_for(&root),
            WorkspaceOptions {
                policy: policy(true, &[]),
                env,
                ..Default::default()
            },
        );
        let f = FreshBase {
            _tmp: tmp,
            dir,
            origin,
            author,
            root,
            ws,
        };
        f.push("first.txt");
        f
    }

    /// Commit `file` in the author checkout and push it to origin; the commit sha.
    fn push(&self, file: &str) -> String {
        std::fs::write(self.author.join(file), format!("{file}\n")).unwrap();
        g(&self.author, &["add", file]);
        g(&self.author, &["commit", "-q", "-m", file]);
        g(&self.author, &["push", "-q", "origin", "HEAD:trunk"]);
        g(&self.author, &["rev-parse", "HEAD"])
    }

    fn repo(&self) -> String {
        p2s(&self.origin)
    }

    async fn start(&self, sid: &str) -> Result<PathBuf, WorkspaceError> {
        self.start_with(sid, None).await
    }

    async fn start_with(
        &self,
        sid: &str,
        default_branch: Option<&str>,
    ) -> Result<PathBuf, WorkspaceError> {
        self.ws
            .ensure_worktree(&EnsureWorktree {
                repo: self.repo(),
                session_id: sid.into(),
                branch: format!("conductor/t/{sid}"),
                base_ref: "HEAD".into(),
                default_branch: default_branch.map(str::to_string),
            })
            .await
    }
}

#[tokio::test]
async fn bases_each_new_session_on_the_fetched_default_branch() {
    let f = FreshBase::new(None);
    let clone = f.ws.ensure_clone(&f.repo()).await.unwrap();
    let stale = g(&clone, &["rev-parse", "HEAD"]);
    let x = f.push("x.txt");

    let wt1 = f.start("s1").await.unwrap();
    assert_eq!(g(&wt1, &["rev-parse", "HEAD"]), x);
    assert_eq!(g(&clone, &["rev-parse", "HEAD"]), stale);
    assert!(run_git(&wt1, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_err());

    let y = f.push("y.txt");
    let wt2 = f.start("s2").await.unwrap();
    assert_eq!(g(&wt2, &["rev-parse", "HEAD"]), y);

    f.push("z.txt");
    assert_eq!(f.start("s1").await.unwrap(), wt1);
    assert_eq!(g(&wt1, &["rev-parse", "HEAD"]), x);

    g(&clone, &["worktree", "remove", "--force", &p2s(&wt2)]);
    assert_eq!(f.start("s2").await.unwrap(), wt2);
    assert_eq!(g(&wt2, &["rev-parse", "HEAD"]), y);
}

#[tokio::test]
async fn r3_records_the_base_of_a_new_branch_only() {
    // TD-221: the commit a new session branch starts at, read before any agent runs in it.
    let f = FreshBase::new(None);
    f.ws.ensure_clone(&f.repo()).await.unwrap();
    let x = f.push("x.txt");
    let o = |sid: &str| EnsureWorktree {
        repo: f.repo(),
        session_id: sid.into(),
        branch: "conductor/t/based".into(),
        base_ref: "HEAD".into(),
        default_branch: None,
    };
    let (wt, base) = f.ws.ensure_worktree_based(&o("s1")).await.unwrap();
    let base = base.expect("a new branch has a base");
    assert_eq!(base.sha, x);
    assert_eq!(base.branch, "origin/trunk");
    // Reused worktree, or the existing branch checked out again: no base (the daemon keeps the
    // one it recorded with the session).
    assert_eq!(
        f.ws.ensure_worktree_based(&o("s1")).await.unwrap(),
        (wt, None)
    );
}

#[tokio::test]
async fn uses_an_explicit_default_branch() {
    let f = FreshBase::new(None);
    f.ws.ensure_clone(&f.repo()).await.unwrap();
    g(&f.author, &["checkout", "-q", "-b", "release"]);
    std::fs::write(f.author.join("r.txt"), "r\n").unwrap();
    g(&f.author, &["add", "r.txt"]);
    g(&f.author, &["commit", "-q", "-m", "r"]);
    g(&f.author, &["push", "-q", "origin", "release"]);
    let r = g(&f.author, &["rev-parse", "HEAD"]);
    let wt = f.start_with("s1", Some("release")).await.unwrap();
    assert_eq!(g(&wt, &["rev-parse", "HEAD"]), r);

    let e = f.start_with("s2", Some("-oops")).await.unwrap_err();
    assert!(e.to_string().contains("invalid git ref"), "{e}");
    let e = f
        .start_with("s3", Some("a..b"))
        .await
        .unwrap_err()
        .to_string();
    assert!(e.starts_with("invalid default branch for "), "{e}");
    assert!(e.contains("origin.git"), "{e}");
}

#[test]
fn is_safe_branch_name_refuses_refspec_tricks() {
    for ok in ["main", "trunk", "release/1.2", "feature_x-y"] {
        assert!(is_safe_branch_name(ok), "{ok}");
    }
    for bad in [
        "", "-x", "/x", "x/", "a..b", "a//b", "a/.b", "x.lock", "a.lock/b", "x.", "a:b", "a b",
        "a*", "+x", "a~1", "a^", "a@{1}", ".x",
    ] {
        assert!(!is_safe_branch_name(bad), "{bad}");
    }
}

#[tokio::test]
async fn sets_origin_head_once_when_the_clone_lacks_it() {
    let f = FreshBase::new(None);
    let clone = f.ws.ensure_clone(&f.repo()).await.unwrap();
    g(
        &clone,
        &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
    );
    let x = f.push("x.txt");
    let wt = f.start("s1").await.unwrap();
    assert_eq!(g(&wt, &["rev-parse", "HEAD"]), x);
    assert_eq!(
        g(&clone, &["symbolic-ref", "refs/remotes/origin/HEAD"]),
        "refs/remotes/origin/trunk"
    );
}

#[tokio::test]
async fn fails_the_start_naming_the_repo_when_origin_is_unreachable() {
    let f = FreshBase::new(None);
    f.ws.ensure_clone(&f.repo()).await.unwrap();
    std::fs::remove_dir_all(&f.origin).unwrap();
    let e = f.start("s1").await.unwrap_err().to_string();
    assert!(e.contains(&f.repo()), "{e}");
    assert!(e.contains("fetch origin trunk failed"), "{e}");
    assert!(!f.ws.worktree_path("s1").exists());
    assert!(f.root.join("repos").exists());
}

/// A `git` wrapper first on PATH records fetch start/end and holds each fetch for 300 ms, so
/// overlapping fetches would show up as two starts in a row. POSIX only, as in TS (MW-T12: the
/// wrapper is a /bin/sh script).
#[tokio::test]
async fn runs_one_fetch_at_a_time_per_repo() {
    if Platform::current().is_windows() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let log = tmp.path().join("fetch.log");
    std::fs::write(&log, "").unwrap();
    let real = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let log_s = p2s(&log);
    std::fs::write(
        bin.join("git"),
        format!(
            "#!/bin/sh\ncase \" $* \" in\n  *\" fetch \"*) echo start >> '{log_s}'; sleep 0.3; '{real}' \"$@\"; rc=$?; echo end >> '{log_s}'; exit $rc ;;\nesac\nexec '{real}' \"$@\"\n"
        ),
    )
    .unwrap();
    platform::fs::set_executable(&bin.join("git")).unwrap();
    let path = format!(
        "{}:{}",
        p2s(&bin),
        std::env::var("PATH").unwrap_or_default()
    );
    let env = crate::test_support::fake_bin::env_with_path(&platform::spawn::process_env(), &path);
    let f = FreshBase::new(Some(env));
    f.ws.ensure_clone(&f.repo()).await.unwrap();
    let x = f.push("x.txt");
    let (a, b, c) = tokio::join!(f.start("s1"), f.start("s2"), f.start("s3"));
    for wt in [a.unwrap(), b.unwrap(), c.unwrap()] {
        assert_eq!(g(&wt, &["rev-parse", "HEAD"]), x);
    }
    let events = std::fs::read_to_string(&log).unwrap();
    let events: Vec<&str> = events.trim().split('\n').collect();
    assert_eq!(events, ["start", "end", "start", "end", "start", "end"]);
    let _ = &f.dir;
}
