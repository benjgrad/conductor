//! Ports of `open-pr.test.ts` and `open-pr.gh-version.test.ts`. ADR-0010 open_pr against a local
//! bare repo as the ticket's repo and a fake `gh`: no network, no GitHub. Real git on temp repos,
//! because the hardening (planted hooks and config in the shared clone) is git behaviour.

use super::*;
use crate::platform::{self, Platform, acl};
use crate::test_support::fake_bin::{env_with_path, path_with, write_fake_bin};
use std::process::Command;

// ---------------------------------------------------------------- shared helpers (also checkout)

pub(crate) fn try_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
    try_git(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

pub(crate) fn commit(cwd: &Path, msg: &str) {
    git(
        cwd,
        &[
            "-c",
            "user.email=t@localhost",
            "-c",
            "user.name=t",
            "commit",
            "--quiet",
            "-m",
            msg,
        ],
    );
}

pub(crate) fn ps(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A canonical temp dir, made private as the daemon makes its root.
pub(crate) fn private_tmp() -> (tempfile::TempDir, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    // fs.realpathSync: without Windows' `\\?\` verbatim prefix, which git can't use.
    let p = crate::claude::transcript::realpath(t.path()).unwrap();
    acl::mkdir_private(&p).unwrap();
    (t, p)
}

/// 0700 on POSIX; an owner-only DACL on Windows (ADR-0024 §3).
pub(crate) fn is_private_dir(p: &Path) -> bool {
    match platform::fs::posix_mode(p) {
        Some(mode) => mode & 0o777 == 0o700,
        None => {
            acl::assert_owner_only(p, acl::AssertOwnerOnlyOptions::new(acl::AclKind::Dir)).is_ok()
        }
    }
}

/// A symlink, or None where the OS refuses one (Windows without Developer Mode).
pub(crate) fn try_symlink(target: &Path, link: &Path) -> Option<()> {
    match platform::fs::symlink(target, link) {
        Ok(()) => Some(()),
        Err(e) if Platform::current().is_windows() => {
            eprintln!("skipped: no symlinks here ({e})");
            None
        }
        Err(e) => panic!("symlink: {e}"),
    }
}

/// `/bin/sh` (Git Bash on Windows).
pub(crate) fn sh() -> String {
    ps(&platform::workflow_shell(Platform::current())
        .expect("a workflow shell")
        .file)
}

pub(crate) fn env_plus(pairs: &[(&str, &str)]) -> Env {
    let mut e = platform::spawn::process_env();
    for (k, v) in pairs {
        exec::set_env(&mut e, k, v, Platform::current().is_windows());
    }
    e
}

fn set_exec(p: &Path) {
    platform::fs::set_executable(p).unwrap();
}

fn b64_decode(s: &str) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = Vec::new();
    for c in s.bytes() {
        let Some(v) = A.iter().position(|a| *a == c) else {
            continue;
        };
        bits = (bits << 6) | v as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    String::from_utf8(out).unwrap()
}

// ---------------------------------------------------------------- open-pr.test.ts fixture

// The fake gh is a /bin/sh script run as `<sh> <script> <args>`. Each call appends one line: the
// cwd and every argument base64-encoded (bodies have newlines), space-separated.
const FAKE_GH: &str = r#"
if [ "$1" = --version ]; then echo "gh version ${FAKE_GH_VERSION:-2.103.3} (2025-01-01)"; exit 0; fi
dir="$FAKE_GH_DIR"
line=$(printf '%s' "$(pwd -W 2>/dev/null || pwd)" | base64 | tr -d '\n')
for a in "$@"; do line="$line $(printf '%s' "$a" | base64 | tr -d '\n')"; done
echo "$line" >> "$dir/gh-calls"
state="$dir/pr-url"
if [ "$1" = repo ] && [ "$2" = view ]; then echo main; exit 0; fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  if [ -f "$state" ]; then cat "$state"; echo; exit 0; fi
  echo 'no pull requests found for branch' >&2; exit 1
fi
if [ "$1" = pr ] && [ "$2" = create ]; then
  if [ -n "$FAKE_GH_FAIL" ]; then echo 'HTTP 401: Bad credentials' >&2; exit 1; fi
  url="${FAKE_GH_URL:-https://github.com/benjgrad/fixture-app/pull/7}"
  printf '%s' "$url" > "$state"
  echo 'Creating pull request...'; echo "$url"; exit 0
fi
exit 2
"#;

const BRANCH: &str = "conductor/ticket/abcd1234";

pub(crate) struct Fx {
    _t: tempfile::TempDir,
    pub tmp: PathBuf,
    pub origin: PathBuf,
    attacker: PathBuf,
    pub clone: PathBuf,
    pub worktree: PathBuf,
    fake_gh: PathBuf,
    pub root: PathBuf,
    pub checked: String,
}

impl Fx {
    pub(crate) fn new() -> Fx {
        let (t, tmp) = private_tmp();
        let origin = tmp.join("origin.git");
        let attacker = tmp.join("attacker.git");
        git(
            &tmp,
            &["init", "--quiet", "--bare", "-b", "main", &ps(&origin)],
        );
        git(
            &tmp,
            &["init", "--quiet", "--bare", "-b", "main", &ps(&attacker)],
        );
        let seed = tmp.join("seed");
        git(&tmp, &["clone", "--quiet", &ps(&origin), &ps(&seed)]);
        std::fs::write(seed.join("README.md"), "# x\n").unwrap();
        git(&seed, &["add", "."]);
        commit(&seed, "init");
        git(&seed, &["push", "--quiet", "origin", "HEAD:main"]);
        let clone = tmp.join("clone");
        git(&tmp, &["clone", "--quiet", &ps(&origin), &ps(&clone)]);
        let worktree = tmp.join("wt");
        git(
            &clone,
            &["worktree", "add", "--quiet", "-b", BRANCH, &ps(&worktree)],
        );
        std::fs::write(worktree.join("health.txt"), "ok\n").unwrap();
        git(&worktree, &["add", "."]);
        commit(&worktree, "add health");
        let fake_gh = tmp.join("fake-gh.sh");
        std::fs::write(&fake_gh, FAKE_GH).unwrap();
        let root = tmp.join("daemon-root");
        acl::mkdir_private(&root).unwrap();
        let checked = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        Fx {
            _t: t,
            tmp,
            origin,
            attacker,
            clone,
            worktree,
            fake_gh,
            root,
            checked,
        }
    }

    fn env(&self, more: &[(&str, &str)]) -> Env {
        let dir = ps(&self.tmp);
        let mut pairs = vec![("FAKE_GH_DIR", dir.as_str())];
        pairs.extend_from_slice(more);
        env_plus(&pairs)
    }

    fn input(&self) -> OpenPrInput {
        OpenPrInput {
            worktree: self.worktree.clone(),
            branch: BRANCH.into(),
            repo: ps(&self.origin),
            policy: RepoPolicy {
                allow_local_repos: true,
                allowed_repo_hosts: Vec::new(),
            },
            title: "Add /health".into(),
            body: "added /health\n\nOpened by conductor.".into(),
            root: self.root.clone(),
            expected_sha: Some(self.checked.clone()),
            gh: Some(GhCommand {
                cmd: sh(),
                args: vec![ps(&self.fake_gh)],
            }),
            after_fetch: None,
            env: Some(self.env(&[])),
        }
    }

    fn has_branch(&self, bare: &Path) -> bool {
        try_git(
            bare,
            &["rev-parse", "--verify", &format!("refs/heads/{BRANCH}")],
        )
        .is_ok()
    }

    /// Each gh call: (cwd, argv).
    fn gh_calls(&self) -> Vec<(String, Vec<String>)> {
        let Ok(text) = std::fs::read_to_string(self.tmp.join("gh-calls")) else {
            return Vec::new();
        };
        text.trim()
            .split('\n')
            .map(|l| {
                let mut parts = l.split(' ').map(b64_decode);
                let cwd = parts.next().unwrap_or_default();
                (cwd, parts.collect())
            })
            .collect()
    }

    fn commit_in_worktree(&self, file: &str, msg: &str) {
        std::fs::write(self.worktree.join(file), "x\n").unwrap();
        git(&self.worktree, &["add", "."]);
        commit(&self.worktree, msg);
    }
}

fn ok_or_error(r: &OpenPrResult) -> String {
    match r {
        OpenPrResult::Ok { .. } => "ok".into(),
        OpenPrResult::Err { error } => error.clone(),
    }
}

fn error_of(r: &OpenPrResult) -> String {
    match r {
        OpenPrResult::Ok { url, .. } => panic!("expected an error, got {url}"),
        OpenPrResult::Err { error } => error.clone(),
    }
}

const PR7: &str = "https://github.com/benjgrad/fixture-app/pull/7";

// ---------------------------------------------------------------- open_pr (ADR-0010)

#[tokio::test]
async fn pushes_the_branch_and_opens_the_pr_with_repo_head_base() {
    let f = Fx::new();
    let r = open_pr(f.input()).await;
    assert_eq!(
        r,
        OpenPrResult::Ok {
            url: PR7.into(),
            reused: false
        }
    );
    let pushed = git(&f.origin, &["rev-parse", &format!("refs/heads/{BRANCH}")]);
    assert_eq!(pushed.trim(), f.checked);
    let calls = f.gh_calls();
    let argv: Vec<Vec<String>> = calls.iter().map(|c| c.1.clone()).collect();
    assert_eq!(
        argv,
        vec![
            sv(&[
                "pr",
                "view",
                BRANCH,
                "--repo",
                "local/origin",
                "--json",
                "url",
                "--jq",
                ".url"
            ]),
            sv(&[
                "repo",
                "view",
                "local/origin",
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name"
            ]),
            sv(&[
                "pr",
                "create",
                "--repo",
                "local/origin",
                "--head",
                BRANCH,
                "--base",
                "main",
                "--title",
                "Add /health",
                "--body",
                "added /health\n\nOpened by conductor."
            ]),
        ]
    );
    // gh runs outside the worktree (it reads no repo config); no token anywhere in argv.
    for (cwd, _) in &calls {
        assert!(platform::same_path(cwd, &f.root), "{cwd}");
    }
    let all = argv.concat().join(" ").to_lowercase();
    assert!(!all.contains("token"));
}

#[tokio::test]
async fn reuses_the_existing_pr_for_the_branch() {
    let f = Fx::new();
    open_pr(f.input()).await;
    let again = open_pr(f.input()).await;
    assert_eq!(
        again,
        OpenPrResult::Ok {
            url: PR7.into(),
            reused: true
        }
    );
    let creates = f
        .gh_calls()
        .iter()
        .filter(|c| c.1.get(1).map(String::as_str) == Some("create"))
        .count();
    assert_eq!(creates, 1);
}

/// A dir whose only CLI is git: POSIX links git into an empty dir; Windows uses git.exe's own dir.
fn only_git_path(f: &Fx) -> String {
    if Platform::current().is_windows() {
        let out = Command::new("where").arg("git").output().unwrap();
        let first = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap()
            .trim()
            .to_string();
        return ps(Path::new(&first).parent().unwrap());
    }
    let dir = f.tmp.join("only-git");
    std::fs::create_dir(&dir).unwrap();
    let which = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let real = String::from_utf8_lossy(&which.stdout).trim().to_string();
    platform::fs::symlink(Path::new(&real), &dir.join("git")).unwrap();
    ps(&dir)
}

#[tokio::test]
async fn a_missing_gh_is_a_clear_error() {
    let f = Fx::new();
    let mut i = f.input();
    i.gh = None;
    i.env = Some(env_with_path(&f.env(&[]), &only_git_path(&f)));
    let e = error_of(&open_pr(i).await);
    assert!(e.contains("gh (the GitHub CLI) is not on PATH"), "{e}");
}

#[tokio::test]
async fn a_failed_gh_pr_create_reports_the_error() {
    let f = Fx::new();
    let mut i = f.input();
    i.env = Some(f.env(&[("FAKE_GH_FAIL", "1")]));
    let e = error_of(&open_pr(i).await);
    assert!(
        e.contains("gh pr create failed: HTTP 401: Bad credentials"),
        "{e}"
    );
}

// ---------------------------------------------------------------- hardening (2026-10-23)

#[tokio::test]
async fn a_planted_pre_push_hook_in_the_shared_clone_does_not_run() {
    let f = Fx::new();
    let marker = f.tmp.join("hook-ran");
    let hook = f.clone.join(".git").join("hooks").join("pre-push");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", ps(&marker)),
    )
    .unwrap();
    set_exec(&hook);
    let r = open_pr(f.input()).await;
    assert_eq!(ok_or_error(&r), "ok");
    assert!(!marker.exists());
    assert!(f.has_branch(&f.origin));
}

#[tokio::test]
async fn a_rewritten_remote_origin_url_does_not_redirect_the_push() {
    let f = Fx::new();
    git(&f.clone, &["config", "remote.origin.url", &ps(&f.attacker)]);
    let r = open_pr(f.input()).await;
    assert_eq!(ok_or_error(&r), "ok");
    assert!(f.has_branch(&f.origin));
    assert!(!f.has_branch(&f.attacker));
}

/// Plant everything an agent could write into the shared clone to hijack the push.
fn plant(tmp: &Path, clone: &Path, origin: &Path, attacker: &Path) -> PathBuf {
    let marker = tmp.join("pwned");
    let m = ps(&marker);
    let evil_hooks = tmp.join("evil-hooks");
    std::fs::create_dir_all(&evil_hooks).unwrap();
    for h in ["pre-push", "reference-transaction", "post-checkout"] {
        std::fs::write(evil_hooks.join(h), format!("#!/bin/sh\ntouch '{m}'\n")).unwrap();
        set_exec(&evil_hooks.join(h));
    }
    // gitconfig syntax reads backslashes as escapes: write Windows paths with forward slashes.
    let cfg = |p: &Path| ps(p).replace('\\', "/");
    std::fs::write(
        tmp.join("evil.gitconfig"),
        format!(
            "[url \"{}\"]\n\tinsteadOf = {}\n",
            cfg(attacker),
            cfg(origin)
        ),
    )
    .unwrap();
    let a = ps(attacker);
    let o = ps(origin);
    let set = |k: &str, v: &str| {
        git(clone, &["config", "--add", k, v]);
    };
    set("remote.origin.url", &a);
    set("remote.origin.pushurl", &a);
    set(&format!("url.{a}.insteadOf"), &o);
    set(&format!("url.{a}.pushInsteadOf"), &o);
    set("core.hooksPath", &ps(&evil_hooks));
    set("credential.helper", &format!("!touch '{m}'"));
    set("core.sshCommand", &format!("touch '{m}'"));
    set("core.fsmonitor", &format!("touch '{m}'"));
    set("uploadpack.packObjectsHook", &format!("touch '{m}'"));
    set("include.path", &ps(&tmp.join("evil.gitconfig")));
    marker
}

#[tokio::test]
async fn the_push_never_reads_the_shared_clones_config() {
    let f = Fx::new();
    let marker = plant(&f.tmp, &f.clone, &f.origin, &f.attacker);
    let r = open_pr(f.input()).await;
    assert_eq!(ok_or_error(&r), "ok");
    assert!(f.has_branch(&f.origin));
    assert!(!f.has_branch(&f.attacker));
    assert!(!marker.exists());
}

#[tokio::test]
async fn a_config_change_racing_between_fetch_and_push_cant_matter() {
    let f = Fx::new();
    let planted = std::sync::Arc::new(std::sync::Mutex::new(None::<PathBuf>));
    let slot = planted.clone();
    let (tmp, clone, origin, attacker) = (
        f.tmp.clone(),
        f.clone.clone(),
        f.origin.clone(),
        f.attacker.clone(),
    );
    let mut i = f.input();
    i.after_fetch = Some(Box::new(move |_| {
        *slot.lock().unwrap() = Some(plant(&tmp, &clone, &origin, &attacker));
    }));
    let r = open_pr(i).await;
    assert_eq!(ok_or_error(&r), "ok");
    let marker = planted.lock().unwrap().clone().expect("planted");
    assert!(f.has_branch(&f.origin));
    assert!(!f.has_branch(&f.attacker));
    assert!(!marker.exists());
}

#[tokio::test]
async fn the_push_repo_is_a_fresh_private_dir_with_minimal_config_deleted_after() {
    let f = Fx::new();
    type Seen = (PathBuf, bool, Vec<String>);
    let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<Seen>));
    let slot = seen.clone();
    let mut i = f.input();
    i.after_fetch = Some(Box::new(move |p| {
        let keys = git(p, &["config", "--local", "--list"])
            .trim()
            .lines()
            .map(|l| l.split('=').next().unwrap_or("").to_string())
            .collect();
        *slot.lock().unwrap() = Some((p.to_path_buf(), is_private_dir(p), keys));
    }));
    let r = open_pr(i).await;
    assert_eq!(ok_or_error(&r), "ok");
    let (dir, private, keys) = seen.lock().unwrap().clone().expect("after_fetch ran");
    assert!(
        ps(&dir).starts_with(&ps(&f.root.join("private").join("push-"))),
        "{}",
        dir.display()
    );
    assert!(private);
    for k in keys {
        assert!(k.starts_with("core."), "{k}");
    }
    assert!(!dir.exists());
    assert_eq!(
        std::fs::read_dir(f.root.join("private")).unwrap().count(),
        0
    );
}

#[tokio::test]
async fn a_symlinked_root_private_is_refused() {
    let f = Fx::new();
    let elsewhere = f.tmp.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    if try_symlink(&elsewhere, &f.root.join("private")).is_none() {
        return;
    }
    let e = error_of(&open_pr(f.input()).await);
    assert!(e.contains("private push repo"), "{e}");
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    assert!(!f.has_branch(&f.origin));
}

#[tokio::test]
async fn a_commit_after_the_checks_makes_the_action_refuse() {
    let f = Fx::new();
    f.commit_in_worktree("sneaky.txt", "after the checks");
    let e = error_of(&open_pr(f.input()).await);
    assert!(e.contains("the branch moved after the checks"), "{e}");
    assert!(!f.has_branch(&f.origin));
    assert!(f.gh_calls().is_empty());
}

#[tokio::test]
async fn a_gh_url_that_is_not_a_github_pr_url_is_not_reported() {
    let f = Fx::new();
    let mut i = f.input();
    i.env = Some(f.env(&[("FAKE_GH_URL", "https://evil.example/x")]));
    let e = error_of(&open_pr(i).await);
    assert!(e.contains("unexpected PR URL"), "{e}");
}

#[tokio::test]
async fn resolve_head_reports_the_worktree_head() {
    let f = Fx::new();
    assert_eq!(
        resolve_head(&f.worktree, None).await,
        Some(f.checked.clone())
    );
    assert_eq!(resolve_head(&f.tmp, None).await, None);
}

// ---------------------------------------------------------------- checkClean

fn dirty(c: &CleanState) -> Vec<String> {
    c.dirty.clone().unwrap_or_default()
}

#[tokio::test]
async fn check_clean_a_clean_tree_reports_its_head() {
    let f = Fx::new();
    assert_eq!(
        check_clean(&f.worktree, None).await,
        CleanState {
            head: Some(f.checked.clone()),
            dirty: None
        }
    );
}

#[tokio::test]
async fn check_clean_modified_staged_untracked_are_dirty() {
    let f = Fx::new();
    std::fs::write(f.worktree.join("health.txt"), "changed\n").unwrap();
    std::fs::create_dir(f.worktree.join("new")).unwrap();
    std::fs::write(f.worktree.join("new").join("x.txt"), "x").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    let d = dirty(&r);
    assert!(d.contains(&" M health.txt".to_string()), "{d:?}");
    assert!(d.contains(&"?? new/x.txt".to_string()), "{d:?}");
}

#[tokio::test]
async fn check_clean_gitignored_files_do_not_count() {
    let f = Fx::new();
    std::fs::write(f.worktree.join(".gitignore"), "dist/\nnode_modules/\n").unwrap();
    git(&f.worktree, &["add", ".gitignore"]);
    commit(&f.worktree, "ignore");
    std::fs::create_dir(f.worktree.join("dist")).unwrap();
    std::fs::write(f.worktree.join("dist").join("out.js"), "x").unwrap();
    std::fs::create_dir_all(f.worktree.join("node_modules").join("a")).unwrap();
    std::fs::write(f.worktree.join("node_modules/a/i.js"), "x").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.dirty, None);
    assert_eq!(
        r.head.as_deref(),
        Some(git(&f.worktree, &["rev-parse", "HEAD"]).trim())
    );
}

#[tokio::test]
async fn check_clean_assume_unchanged_hides_nothing() {
    let f = Fx::new();
    git(
        &f.worktree,
        &["update-index", "--assume-unchanged", "health.txt"],
    );
    std::fs::write(f.worktree.join("health.txt"), "changed\n").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    assert!(dirty(&r).contains(&"hidden (h): health.txt".to_string()));
}

#[tokio::test]
async fn check_clean_skip_worktree_hides_nothing() {
    let f = Fx::new();
    git(
        &f.worktree,
        &["update-index", "--skip-worktree", "health.txt"],
    );
    std::fs::write(f.worktree.join("health.txt"), "changed\n").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    assert!(dirty(&r).contains(&"hidden (S): health.txt".to_string()));
}

#[tokio::test]
async fn check_clean_info_exclude_in_the_shared_clone_hides_nothing() {
    let f = Fx::new();
    std::fs::create_dir_all(f.clone.join(".git").join("info")).unwrap();
    std::fs::write(f.clone.join(".git/info/exclude"), "sneaky.txt\n").unwrap();
    std::fs::write(f.worktree.join("sneaky.txt"), "x").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    assert_eq!(dirty(&r), vec!["?? sneaky.txt"]);
}

#[tokio::test]
async fn check_clean_a_self_ignoring_gitignore_is_dirty() {
    let f = Fx::new();
    std::fs::write(f.worktree.join(".gitignore"), ".gitignore\nsneaky.txt\n").unwrap();
    std::fs::write(f.worktree.join("sneaky.txt"), "x").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    assert_eq!(dirty(&r), vec!["?? .gitignore (ignores itself)"]);
}

#[tokio::test]
async fn check_clean_a_nested_self_ignoring_gitignore_is_dirty() {
    let f = Fx::new();
    std::fs::create_dir(f.worktree.join("deep")).unwrap();
    std::fs::write(f.worktree.join("deep/.gitignore"), "*\n").unwrap();
    std::fs::write(f.worktree.join("deep/x.txt"), "x").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(dirty(&r), vec!["?? deep/.gitignore (ignores itself)"]);
}

#[tokio::test]
async fn check_clean_submodule_changes_hidden_by_ignore_all_are_dirty() {
    let f = Fx::new();
    let sub = f.tmp.join("subrepo");
    std::fs::create_dir(&sub).unwrap();
    git(&sub, &["init", "--quiet", "-b", "main"]);
    std::fs::write(sub.join("a.txt"), "1\n").unwrap();
    git(&sub, &["add", "."]);
    commit(&sub, "s");
    git(
        &f.worktree,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            &ps(&sub),
            "sub",
        ],
    );
    commit(&f.worktree, "sub");
    assert_eq!(check_clean(&f.worktree, None).await.dirty, None);
    std::fs::write(f.worktree.join("sub").join("a.txt"), "2\n").unwrap();
    git(&f.clone, &["config", "submodule.sub.ignore", "all"]);
    git(&f.clone, &["config", "diff.ignoreSubmodules", "all"]);
    assert_eq!(git(&f.worktree, &["status", "--porcelain"]).trim(), "");
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    assert_eq!(dirty(&r), vec![" M sub"]);
}

#[tokio::test]
async fn check_clean_a_repo_config_excludes_file_hides_nothing() {
    let f = Fx::new();
    let ex = f.tmp.join("evil-excludes");
    std::fs::write(&ex, "sneaky.txt\n").unwrap();
    git(&f.clone, &["config", "core.excludesFile", &ps(&ex)]);
    std::fs::write(f.worktree.join("sneaky.txt"), "x").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(r.head, None);
    assert_eq!(dirty(&r), vec!["?? sneaky.txt"]);
}

#[tokio::test]
async fn check_clean_a_planted_fsmonitor_or_hooks_do_not_run() {
    let f = Fx::new();
    let marker = f.tmp.join("pwned");
    git(
        &f.clone,
        &[
            "config",
            "core.fsmonitor",
            &format!("touch '{}'", ps(&marker)),
        ],
    );
    git(&f.clone, &["config", "core.hooksPath", &ps(&f.tmp)]);
    std::fs::write(f.worktree.join("health.txt"), "changed\n").unwrap();
    let r = check_clean(&f.worktree, None).await;
    assert_eq!(dirty(&r), vec![" M health.txt"]);
    assert!(!marker.exists());
}

#[tokio::test]
async fn a_non_allowlisted_repo_is_a_clear_error_nothing_pushed() {
    let f = Fx::new();
    let mut i = f.input();
    i.policy.allow_local_repos = false;
    let e = error_of(&open_pr(i).await);
    assert!(e.contains("local"), "{e}");
    assert!(!f.has_branch(&f.origin));
    let mut i = f.input();
    i.repo = "https://gitlab.com/o/r.git".into();
    let e = error_of(&open_pr(i).await);
    assert!(e.contains("is not a GitHub repository"), "{e}");
    assert!(f.gh_calls().is_empty());
}

#[test]
fn push_target_github_over_https_or_ssh_only() {
    let none = RepoPolicy::default();
    assert_eq!(
        push_target("github.com/benjgrad/app", &none).unwrap(),
        PushTarget {
            url: "https://github.com/benjgrad/app.git".into(),
            gh_repo: "benjgrad/app".into(),
            local: false
        }
    );
    assert_eq!(
        push_target("git@github.com:benjgrad/app.git", &none)
            .unwrap()
            .gh_repo,
        "benjgrad/app"
    );
    let ghe = RepoPolicy {
        allow_local_repos: false,
        allowed_repo_hosts: vec!["ghe.acme.io".into()],
    };
    assert_eq!(
        push_target("https://ghe.acme.io/o/r", &ghe)
            .unwrap()
            .gh_repo,
        "ghe.acme.io/o/r"
    );
    assert!(
        push_target("https://gitlab.com/o/r", &none)
            .unwrap_err()
            .contains("not a GitHub repository")
    );
    assert!(push_target("/tmp/x.git", &none).is_err());
    assert!(push_target("ext::sh -c touch", &none).is_err());
}

// ---------------------------------------------------------------- open-pr.gh-version.test.ts

const FAKE_GH_VERSIONED: &str = r#"
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_GH_DIR, 'gh-calls'), a.join(' ') + '\n');
const is = (x, y) => a[0] === x && (y === undefined || a[1] === y);
if (is('--version')) { console.log(process.env.FAKE_GH_VERSION_OUT); process.exit(0); }
if (is('repo', 'view')) { console.log('main'); process.exit(0); }
if (is('pr', 'view')) { console.error('no pull requests found'); process.exit(1); }
if (is('pr', 'create')) { console.log('https://github.com/benjgrad/fixture-app/pull/7'); process.exit(0); }
process.exit(2);
"#;

/// The fake `gh` is an executable on PATH (no `gh` override), as the daemon finds it.
fn versioned_input(f: &Fx, version_out: &str) -> OpenPrInput {
    let bin = f.tmp.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    write_fake_bin(&bin, "gh", FAKE_GH_VERSIONED, Platform::current()).unwrap();
    let path = path_with(&[&ps(&bin), &std::env::var("PATH").unwrap_or_default()]);
    let dir = ps(&f.tmp);
    let mut env = env_with_path(&platform::spawn::process_env(), &path);
    env.push(("FAKE_GH_DIR".into(), dir));
    env.push(("FAKE_GH_VERSION_OUT".into(), version_out.into()));
    let mut i = f.input();
    i.gh = None;
    i.body = "Opened by conductor.".into();
    i.env = Some(env);
    i
}

fn version_calls(f: &Fx) -> Vec<String> {
    std::fs::read_to_string(f.tmp.join("gh-calls"))
        .map(|t| t.trim().lines().map(str::to_string).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn gh_2_14_is_refused_with_the_upgrade_message() {
    let f = Fx::new();
    let r = open_pr(versioned_input(&f, "gh version 2.14.0 (2022-07-20)")).await;
    assert_eq!(
        r,
        OpenPrResult::Err {
            error: "gh ≥ 2.40.0 required (found 2.14.0): upgrade gh, e.g. brew upgrade gh".into()
        }
    );
    assert!(!f.has_branch(&f.origin));
    assert_eq!(version_calls(&f), vec!["--version"]);
}

#[tokio::test]
async fn an_unparsable_gh_version_is_refused_too() {
    let f = Fx::new();
    let e = error_of(&open_pr(versioned_input(&f, "gh version unknown")).await);
    assert!(
        e.contains("gh ≥ 2.40.0 required (found gh version unknown)"),
        "{e}"
    );
    assert!(!f.has_branch(&f.origin));
}

#[tokio::test]
async fn gh_at_or_above_the_floor_proceeds() {
    for v in ["2.40.0", "2.103.3"] {
        let f = Fx::new();
        let r = open_pr(versioned_input(&f, &format!("gh version {v} (2025-01-01)"))).await;
        assert_eq!(
            r,
            OpenPrResult::Ok {
                url: PR7.into(),
                reused: false
            },
            "{v}"
        );
        assert!(f.has_branch(&f.origin));
        assert_eq!(version_calls(&f)[0], "--version");
    }
}
