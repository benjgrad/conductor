//! Port of `packages/daemon/src/actions/open-pr.ts` (MR-T10). The generic exec helpers it holds
//! in TS (`cleanEnv`, `run`, `tail`, `NO_HOOKS`, `privateDir`) live in `crate::exec`.
//!
//! ADR-0010 `open_pr`: conductor (this daemon code, never an agent) pushes the session branch and
//! opens a pull request against the repo's default branch with the GitHub CLI, or reuses the PR
//! that already exists for the branch. Agents keep their `git push` deny (ADR-0006).
//!
//! Hardening (security reviews, 2026-10-23): the push never runs in, or reads the config of, an
//! agent-writable repository:
//! 1. the session branch is FETCHED into a fresh daemon-private bare repo (`<root>/private/push-*`,
//!    0700, owner/lstat-checked, deleted after the push), hooks off, only the file transport, an
//!    explicit `--upload-pack=git-upload-pack`;
//! 2. the fetched tip must EQUAL the commit the entry checks ran on (`expected_sha`);
//! 3. exactly that commit is pushed to an explicit URL from the daemon's own store, allow-listed to
//!    GitHub, hooks off, only https/ssh transports, no system config, no inherited `GIT_*`;
//! 4. gh gets `--repo <owner>/<name>` from that trusted URL, explicit `--head` and `--base`, and
//!    runs in the daemon root. `gh --version` must be at least `GH_MIN_VERSION` first (M2-T10).
//!
//! Residual risk (ADR-0010 implementation notes): agents run as the same uid (U-004, TD-083).

use crate::exec::{self, Env, Run, no_hooks, private_dir, sv, tail600};
use crate::inventory::version::cli_version_from;
use crate::workspace::{RepoNotAllowedError, RepoPolicy, clone_source, is_absolute_path};
use conductor_protocol::GH_MIN_VERSION;
use conductor_protocol::capabilities::cli_version_at_least;
use regress::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// How to run gh: a program and the args before gh's own (tests: `(sh, [fake-gh.sh])`).
#[derive(Debug, Clone)]
pub struct GhCommand {
    pub cmd: String,
    pub args: Vec<String>,
}

impl Default for GhCommand {
    fn default() -> Self {
        GhCommand {
            cmd: "gh".into(),
            args: Vec::new(),
        }
    }
}

impl GhCommand {
    pub fn argv(&self, rest: &[&str]) -> Vec<String> {
        let mut v = self.args.clone();
        v.extend(rest.iter().map(|s| s.to_string()));
        v
    }
}

/// Test hook: runs after the fetch into the private repo (its path), before the push.
pub type AfterFetch = Box<dyn FnOnce(&Path) + Send>;

pub struct OpenPrInput {
    /// The session worktree (the objects to push).
    pub worktree: PathBuf,
    /// The session branch, from the daemon's store.
    pub branch: String,
    /// `ticket.repo` from the daemon's store.
    pub repo: String,
    pub policy: RepoPolicy,
    pub title: String,
    pub body: String,
    /// The daemon's root: gh runs here and the private push repos live under `<root>/private/`.
    pub root: PathBuf,
    /// The commit the entry checks ran on; None only for an entry without checks.
    pub expected_sha: Option<String>,
    /// Default `gh` from PATH.
    pub gh: Option<GhCommand>,
    pub after_fetch: Option<AfterFetch>,
    /// Environment for git and gh (default this process's), cleaned by `exec::run`.
    pub env: Option<Env>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenPrResult {
    Ok { url: String, reused: bool },
    Err { error: String },
}

fn fail(error: impl Into<String>) -> OpenPrResult {
    OpenPrResult::Err {
        error: error.into(),
    }
}

/// Where to push and what gh calls the repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub url: String,
    /// gh `--repo`: `owner/name`, or `host/owner/name` for a non-github.com host.
    pub gh_repo: String,
    pub local: bool,
}

const SEG: &str = "[A-Za-z0-9_.-]+";
static HTTPS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^https://([A-Za-z0-9.-]+)/({SEG})/({SEG}?)(?:\\.git)?/?$"
    ))
    .unwrap()
});
static SCP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "^git@([A-Za-z0-9.-]+):({SEG})/({SEG}?)(?:\\.git)?$"
    ))
    .unwrap()
});
static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("https?:\\/\\/\\S+").unwrap());
static BRANCH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z0-9][A-Za-z0-9._/-]*$").unwrap());
static PR_URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(conductor_protocol::GITHUB_PR_URL_RE).unwrap());

fn is_match(re: &Regex, s: &str) -> bool {
    re.find(s).is_some()
}

/// `GITHUB_PR_URL_RE.test(url)`.
pub fn is_github_pr_url(url: &str) -> bool {
    is_match(&PR_URL_RE, url)
}

/// The last `https?://\S+` in `s`.
fn last_url(s: &str) -> Option<String> {
    URL_RE.find_iter(s).last().map(|m| s[m.range()].to_string())
}

fn group(s: &str, m: &regress::Match, i: usize) -> String {
    m.group(i).map(|r| s[r].to_string()).unwrap_or_default()
}

/// The push URL for `repo`, from the same rule the clone used (`clone_source`), allow-listed:
/// GitHub (or an `allowed_repo_hosts` host) over https or ssh, `owner/name` only. A local path
/// only with `allow_local_repos` (tests). Anything else → a sentence for the human.
pub fn push_target(repo: &str, policy: &RepoPolicy) -> Result<PushTarget, String> {
    let url = clone_source(repo, policy).map_err(|e: RepoNotAllowedError| e.to_string())?;
    if is_absolute_path(&url)
        || url
            .get(..5)
            .is_some_and(|p| p.eq_ignore_ascii_case("file:"))
    {
        if !policy.allow_local_repos {
            return Err(format!("{repo} is a local path, not a GitHub repository"));
        }
        let base = Path::new(&url)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = base.strip_suffix(".git").unwrap_or(&base);
        return Ok(PushTarget {
            gh_repo: format!("local/{name}"),
            url,
            local: true,
        });
    }
    let m = HTTPS.find(&url).or_else(|| SCP.find(&url));
    let not_github = || {
        format!(
            "{repo} is not a GitHub repository conductor may push to (https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>)"
        )
    };
    let Some(m) = m else {
        return Err(not_github());
    };
    let host = group(&url, &m, 1).to_ascii_lowercase();
    let allowed = host == "github.com" || policy.allowed_repo_hosts.contains(&host);
    if !allowed {
        return Err(not_github());
    }
    let owner = group(&url, &m, 2);
    let raw = group(&url, &m, 3);
    let name = raw.strip_suffix(".git").unwrap_or(&raw).to_string();
    if name.is_empty() || owner.starts_with('-') || name.starts_with('-') {
        return Err(format!("{repo} has no valid owner/name"));
    }
    Ok(PushTarget {
        gh_repo: if host == "github.com" {
            format!("{owner}/{name}")
        } else {
            format!("{host}/{owner}/{name}")
        },
        url,
        local: false,
    })
}

const GH_MISSING: &str =
    "gh (the GitHub CLI) is not on PATH: install it and run `gh auth login` on this machine";

fn gh_spawn_error(r: &Run) -> Option<String> {
    r.spawn_error.as_ref().map(|e| {
        if e.code == "ENOENT" {
            GH_MISSING.to_string()
        } else {
            format!("gh could not run: {}", e.message)
        }
    })
}

pub async fn open_pr(i: OpenPrInput) -> OpenPrResult {
    if !is_match(&BRANCH_RE, &i.branch) {
        return fail(format!("invalid branch name {}", i.branch));
    }
    let target = match push_target(&i.repo, &i.policy) {
        Ok(t) => t,
        Err(e) => return fail(e),
    };
    let gh = i.gh.clone().unwrap_or_default();
    let env = i.env.clone();
    let run = |args: Vec<String>, cwd: PathBuf| {
        let gh_cmd = gh.cmd.clone();
        let env = env.clone();
        async move { exec::run(&gh_cmd, &args, &cwd, env.as_deref()).await }
    };
    // U-076: GH_MIN_VERSION is a safe floor, not a verified minimum.
    let ver = run(gh.argv(&["--version"]), i.root.clone()).await;
    if let Some(e) = gh_spawn_error(&ver) {
        return fail(e);
    }
    let found = if ver.code == Some(0) {
        cli_version_from(&ver.stdout)
    } else {
        None
    };
    if found.is_none() || !cli_version_at_least(found.as_deref(), GH_MIN_VERSION) {
        let shown = found.unwrap_or_else(|| {
            let src = if ver.stdout.is_empty() {
                &ver.stderr
            } else {
                &ver.stdout
            };
            let t = exec::tail(src, 60);
            if t.is_empty() { "unknown".into() } else { t }
        });
        return fail(format!(
            "gh ≥ {GH_MIN_VERSION} required (found {shown}): upgrade gh, e.g. brew upgrade gh"
        ));
    }
    let root = i.root.clone();
    let branch = i.branch.clone();
    let (title, body) = (i.title.clone(), i.body.clone());
    if let Some(err) = push_checked(i, &target).await {
        return err;
    }

    // Reuse the PR that already exists for the branch (a repeat of the same visit, or a retry).
    let view = run(
        gh.argv(&[
            "pr",
            "view",
            &branch,
            "--repo",
            &target.gh_repo,
            "--json",
            "url",
            "--jq",
            ".url",
        ]),
        root.clone(),
    )
    .await;
    if let Some(e) = gh_spawn_error(&view) {
        return fail(e);
    }
    if view.code == Some(0)
        && let Some(existing) = last_url(view.stdout.trim())
    {
        return pr_result(existing, true);
    }

    let repo_view = run(
        gh.argv(&[
            "repo",
            "view",
            &target.gh_repo,
            "--json",
            "defaultBranchRef",
            "--jq",
            ".defaultBranchRef.name",
        ]),
        root.clone(),
    )
    .await;
    let base = repo_view.stdout.trim().to_string();
    if repo_view.code != Some(0) || !is_match(&BRANCH_RE, &base) {
        let why = if repo_view.stderr.is_empty() {
            &repo_view.stdout
        } else {
            &repo_view.stderr
        };
        return fail(format!(
            "gh could not read the default branch of {}: {}",
            target.gh_repo,
            tail600(why)
        ));
    }
    let create = run(
        gh.argv(&[
            "pr",
            "create",
            "--repo",
            &target.gh_repo,
            "--head",
            &branch,
            "--base",
            &base,
            "--title",
            &title,
            "--body",
            &body,
        ]),
        root,
    )
    .await;
    if let Some(e) = &create.spawn_error {
        return fail(format!("gh could not run: {}", e.message));
    }
    if create.code != Some(0) {
        let why = if create.stderr.is_empty() {
            &create.stdout
        } else {
            &create.stderr
        };
        return fail(format!("gh pr create failed: {}", tail600(why)));
    }
    match last_url(&create.stdout) {
        Some(url) => pr_result(url, false),
        None => fail(format!(
            "gh pr create printed no URL: {}",
            tail600(&create.stdout)
        )),
    }
}

/// Only a `https://github.com/<o>/<r>/pull/<n>` URL is reported.
fn pr_result(url: String, reused: bool) -> OpenPrResult {
    if !is_github_pr_url(&url) {
        return fail(format!("gh reported an unexpected PR URL: {url}"));
    }
    OpenPrResult::Ok { url, reused }
}

/// Removes a private dir when dropped.
pub(crate) struct RemoveOnDrop(pub PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Fetch the session branch into a fresh private repo, check its tip is exactly the checked
/// commit, and push exactly that commit to the trusted URL. None = pushed.
async fn push_checked(i: OpenPrInput, target: &PushTarget) -> Option<OpenPrResult> {
    if let Some(sha) = &i.expected_sha
        && !exec::is_sha(sha)
    {
        return Some(fail(format!("invalid checked commit {sha}")));
    }
    let priv_dir = match private_dir(&i.root, "push-") {
        Ok(d) => d,
        Err(e) => return Some(fail(format!("private push repo: {e}"))),
    };
    let _cleanup = RemoveOnDrop(priv_dir.clone());
    let env = i.env.as_deref();
    let git = |args: Vec<String>, cwd: &Path| {
        let cwd = cwd.to_path_buf();
        async move {
            let mut a = no_hooks();
            a.extend(args);
            exec::run("git", &a, &cwd, env).await
        }
    };
    let p = priv_dir.to_string_lossy().into_owned();
    let init = git(sv(&["init", "--quiet", "--bare", &p]), &i.root).await;
    if let Some(e) = &init.spawn_error {
        return Some(fail(format!("git could not run: {}", e.message)));
    }
    if init.code != Some(0) {
        return Some(fail(format!("git init failed: {}", tail600(&init.stderr))));
    }

    // 1. Fetch the branch, with untrusted config off.
    let r#ref = format!("refs/heads/{}", i.branch);
    let wt = i.worktree.to_string_lossy().into_owned();
    let refspec = format!("+{0}:{0}", r#ref);
    let fetch = git(
        sv(&[
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--upload-pack=git-upload-pack",
            &wt,
            &refspec,
        ]),
        &priv_dir,
    )
    .await;
    if let Some(e) = &fetch.spawn_error {
        return Some(fail(format!("git could not run: {}", e.message)));
    }
    if fetch.code != Some(0) {
        return Some(fail(format!(
            "could not read the session branch: {}",
            tail600(&fetch.stderr)
        )));
    }
    // 2. The fetched tip must be exactly the checked commit.
    let tip = git(
        sv(&["rev-parse", "--verify", &format!("{}^{{commit}}", r#ref)]),
        &priv_dir,
    )
    .await;
    let sha = tip.stdout.trim().to_string();
    if tip.code != Some(0) || !exec::is_sha(&sha) {
        return Some(fail(format!(
            "the session branch {} has no commit to push",
            i.branch
        )));
    }
    if let Some(expected) = &i.expected_sha
        && *expected != sha
    {
        return Some(fail(format!(
            "the branch moved after the checks (they ran on {expected}, the branch is at {sha}): refusing to push an unchecked commit"
        )));
    }
    if let Some(hook) = i.after_fetch {
        hook(&priv_dir);
    }

    // 3. Push exactly that commit to the trusted URL.
    let mut args = sv(&[
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.ssh.allow=always",
    ]);
    if target.local {
        args.extend(sv(&["-c", "protocol.file.allow=always"]));
    }
    args.extend(sv(&[
        "push",
        "--quiet",
        "--no-verify",
        &target.url,
        &format!("{sha}:{}", r#ref),
    ]));
    let push = git(args, &priv_dir).await;
    if let Some(e) = &push.spawn_error {
        return Some(fail(format!("git could not run: {}", e.message)));
    }
    if push.code != Some(0) {
        let why = if push.stderr.is_empty() {
            &push.stdout
        } else {
            &push.stderr
        };
        return Some(fail(format!("git push failed: {}", tail600(why))));
    }
    None
}

/// The worktree's `HEAD` commit, for `cmd_exit.head_sha` (ADR-0010: the commit the entry checks
/// run on). Hooks off, no system config; None when it can't be resolved.
pub async fn resolve_head(worktree: &Path, env: Option<&[(String, String)]>) -> Option<String> {
    let mut args = no_hooks();
    args.extend(sv(&["rev-parse", "--verify", "HEAD^{commit}"]));
    let r = exec::run("git", &args, worktree, env).await;
    let sha = r.stdout.trim();
    (r.code == Some(0) && exec::is_sha(sha)).then(|| sha.to_string())
}

/// `checkClean`'s result: clean → `head` (the commit the check runs on) and no `dirty`; dirty →
/// the status lines and no head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanState {
    pub head: Option<String>,
    pub dirty: Option<Vec<String>>,
}

/// ADR-0010 entry checks run only on a clean worktree. Agent-writable state can hide changes
/// from a plain `git status` (final QA, 2026-10-26), so the tree is dirty if ANY of these says so:
/// status with the caches and `core.excludesFile` off; hidden index bits (assume-unchanged,
/// skip-worktree); untracked files honouring only in-tree `.gitignore`s; a self-ignoring
/// uncommitted `.gitignore`.
pub async fn check_clean(worktree: &Path, env: Option<&[(String, String)]>) -> CleanState {
    let git = |args: &[&str]| {
        let mut a = sv(&["-c", "core.fsmonitor=false"]);
        a.extend(no_hooks());
        a.extend(sv(args));
        async move { exec::run("git", &a, worktree, env).await }
    };
    let failed = |what: &str, r: &Run| CleanState {
        head: None,
        dirty: Some(vec![format!(
            "(git {what} failed: {})",
            exec::tail(
                if r.stderr.is_empty() {
                    &r.stdout
                } else {
                    &r.stderr
                },
                300
            )
        )]),
    };
    let lines = |r: &Run| -> Vec<String> {
        r.stdout
            .split('\n')
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect()
    };
    let st = git(&[
        "-c",
        "core.ignoreStat=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.excludesFile=",
        "status",
        "--porcelain",
        "--untracked-files=all",
        // QA 1b: submodule changes are not hidden by submodule.<name>.ignore / diff.ignoreSubmodules.
        "--ignore-submodules=none",
    ])
    .await;
    if st.code != Some(0) {
        return failed("status", &st);
    }
    let mut dirty = lines(&st);
    let lv = git(&["ls-files", "-v"]).await;
    if lv.code != Some(0) {
        return failed("ls-files -v", &lv);
    }
    for l in lines(&lv) {
        let Some(tag) = l.chars().next() else {
            continue;
        };
        if tag == 'S' || tag.is_ascii_lowercase() {
            let rest: String = l.chars().skip(2).collect();
            dirty.push(format!("hidden ({tag}): {rest}"));
        }
    }
    let un = git(&["ls-files", "--others", "--exclude-per-directory=.gitignore"]).await;
    if un.code != Some(0) {
        return failed("ls-files --others", &un);
    }
    for l in lines(&un) {
        let entry = format!("?? {l}");
        if !dirty.contains(&entry) {
            dirty.push(entry);
        }
    }
    let gi = git(&[
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-per-directory=.gitignore",
        "--",
        ".gitignore",
        ":(glob)**/.gitignore",
    ])
    .await;
    if gi.code != Some(0) {
        return failed("ls-files --ignored", &gi);
    }
    for l in lines(&gi) {
        let entry = format!("?? {l} (ignores itself)");
        if !dirty.contains(&entry) {
            dirty.push(entry);
        }
    }
    if !dirty.is_empty() {
        dirty.truncate(200);
        return CleanState {
            head: None,
            dirty: Some(dirty),
        };
    }
    CleanState {
        head: resolve_head(worktree, env).await,
        dirty: None,
    }
}

#[cfg(test)]
pub(crate) mod tests;
