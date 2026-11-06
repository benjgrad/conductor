//! Port of `packages/daemon/src/actions/checkout.ts` (MR-T10).
//!
//! ADR-0010 (Ben, 2026-10-26): entry checks run in a fresh, conductor-owned checkout of the exact
//! commit, never in the agent's worktree. The checkout is an ephemeral repo under
//! `<root>/private/check-*` (0700, lstat/owner-checked, like open_pr's push repo), created with
//! git's minimal config (hooks off, no repo-config filter drivers). The session branch is fetched
//! in with the open_pr hardening, its tip must equal the commit to check, and that commit is
//! checked out detached. M2-T30: the setup and the npm-style checks follow the repo's lockfile.
//!
//! The fetch copies the branch's whole history into an empty repo, which takes minutes on a large
//! repo, so it (and the checkout) runs under the check's own timeout, not `exec::run`'s 5 minutes:
//! 2026-11-06, a 60m check died 5 min in with an empty "could not read the session branch: ".

use crate::exec::{self, Env, Run, no_hooks, private_dir, sv, tail600};
use crate::platform::{self, acl};
use regress::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

pub struct FreshCheckoutInput {
    pub root: PathBuf,
    /// The session worktree (only read through a hardened fetch).
    pub worktree: PathBuf,
    pub branch: String,
    /// The commit to check.
    pub sha: String,
    pub env: Option<Env>,
    /// The budget for the fetch and the checkout (the check's timeout); None: [`FRESH_FETCH_TIMEOUT`].
    pub timeout: Option<Duration>,
}

/// The fetch / checkout budget when the check names none.
pub const FRESH_FETCH_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A check's fresh-checkout budget: its own timeout, never less than [`FRESH_FETCH_TIMEOUT`] (a
/// 1-minute lint still needs the clone of a large repo first).
pub fn fetch_budget(check: Option<Duration>) -> Duration {
    check.map_or(FRESH_FETCH_TIMEOUT, |c| c.max(FRESH_FETCH_TIMEOUT))
}

/// `90s`, `5m`, `2h`: the largest whole unit (the workflow's own duration style).
pub fn format_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s == 0 {
        format!("{}ms", d.as_millis())
    } else if s.is_multiple_of(3600) {
        format!("{}h", s / 3600)
    } else if s.is_multiple_of(60) {
        format!("{}m", s / 60)
    } else {
        format!("{s}s")
    }
}

/// Why fetching the session branch failed, for a human: never an empty tail (the fetch is
/// `--quiet`, so a killed one wrote nothing), and a timeout says so.
pub fn fetch_failure(branch: &str, r: &Run, elapsed: Duration, limit: Duration) -> String {
    if let Some(e) = &r.spawn_error {
        return format!(
            "could not run git to read the session branch `{branch}`: {}",
            e.message
        );
    }
    match r.code {
        None if elapsed >= limit => format!(
            "could not read the session branch `{branch}`: fetching it into a fresh checkout timed out after {} (a large repository can take that long; raise the check's timeout)",
            format_duration(limit)
        ),
        code => {
            let why = code.map_or_else(|| "killed".to_string(), |c| format!("exit {c}"));
            let out = tail600(&r.stderr);
            let out = if out.is_empty() {
                "no output".to_string()
            } else {
                out
            };
            format!("could not read the session branch `{branch}` (git fetch {why}): {out}")
        }
    }
}

/// FR (2026-11-06): `Some("origin/<default>")` when `sha` is already on origin's default branch,
/// i.e. the session branch has no commits ahead of it, so there is nothing to check. None: it has
/// commits ahead, or that can't be told (no `origin/HEAD`): then the checks run as usual. Reads the
/// agent's worktree like `resolve_head` does: refs only (no index, no filters), hooks off.
pub async fn no_commits_ahead(
    worktree: &Path,
    sha: &str,
    env: Option<&[(String, String)]>,
) -> Option<String> {
    if !exec::is_sha(sha) {
        return None;
    }
    let git = |args: &[&str]| {
        let mut a = no_hooks();
        a.extend(sv(args));
        async move { exec::run("git", &a, worktree, env).await }
    };
    let head = git(&[
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
    ])
    .await;
    let base = head.stdout.trim().to_string();
    if head.code != Some(0) || base.is_empty() {
        return None;
    }
    let anc = git(&[
        "merge-base",
        "--is-ancestor",
        sha,
        "refs/remotes/origin/HEAD",
    ])
    .await;
    (anc.code == Some(0)).then_some(base)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreshCheckout {
    Ok {
        dir: PathBuf,
        sha: String,
    },
    /// `head`: the branch tip actually found (when it differs from `sha`), else None.
    Err {
        error: String,
        head: Option<String>,
    },
}

pub async fn fresh_checkout(i: &FreshCheckoutInput) -> FreshCheckout {
    if !exec::is_sha(&i.sha) {
        return FreshCheckout::Err {
            error: format!("invalid commit {}", i.sha),
            head: None,
        };
    }
    let dir = match private_dir(&i.root, "check-") {
        Ok(d) => d,
        Err(e) => {
            return FreshCheckout::Err {
                error: format!("fresh checkout: {e}"),
                head: None,
            };
        }
    };
    let fail = |error: String, head: Option<String>| {
        remove_checkout(&dir);
        FreshCheckout::Err { error, head }
    };
    let git = |args: Vec<String>| {
        let mut a = no_hooks();
        a.extend(args);
        let dir = dir.clone();
        let env = i.env.clone();
        async move { exec::run("git", &a, &dir, env.as_deref()).await }
    };
    let limit = i.timeout.unwrap_or(FRESH_FETCH_TIMEOUT);
    // The fetch and the checkout: `exec::run`'s hardening, with the check's budget.
    let slow_git = |args: Vec<String>| {
        let mut a = no_hooks();
        a.extend(args);
        let dir = dir.clone();
        let base = match &i.env {
            Some(e) => e.clone(),
            None => platform::spawn::process_env(),
        };
        async move {
            exec::run_raw(
                "git",
                &a,
                &dir,
                exec::clean_env(&base),
                exec::RUN_MAX_BUFFER,
                limit,
            )
            .await
        }
    };
    let d = dir.to_string_lossy().into_owned();
    let init = git(sv(&["init", "--quiet", &d])).await;
    if init.code != Some(0) {
        return fail(format!("git init failed: {}", tail600(&init.stderr)), None);
    }
    let r#ref = format!("refs/heads/{}", i.branch);
    let wt = i.worktree.to_string_lossy().into_owned();
    let started = std::time::Instant::now();
    let fetch = slow_git(sv(&[
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
        &format!("+{0}:{0}", r#ref),
    ]))
    .await;
    if fetch.code != Some(0) {
        return fail(
            fetch_failure(&i.branch, &fetch, started.elapsed(), limit),
            None,
        );
    }
    let tip = git(sv(&[
        "rev-parse",
        "--verify",
        &format!("{}^{{commit}}", r#ref),
    ]))
    .await;
    let tip = tip.stdout.trim().to_string();
    if !exec::is_sha(&tip) {
        return fail(
            format!("the session branch {} has no commit", i.branch),
            None,
        );
    }
    if tip != i.sha {
        return fail(
            format!(
                "the branch moved: the checks are for {}, the branch is at {tip}",
                i.sha
            ),
            Some(tip),
        );
    }
    let co = slow_git(sv(&[
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--quiet",
        "--detach",
        "--force",
        &i.sha,
    ]))
    .await;
    if co.code != Some(0) {
        return fail(
            format!("git checkout failed: {}", tail600(&co.stderr)),
            None,
        );
    }
    FreshCheckout::Ok {
        dir,
        sha: i.sha.clone(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Pnpm,
    Yarn,
    Npm,
}

impl PackageManager {
    pub fn name(self) -> &'static str {
        match self {
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Npm => "npm",
        }
    }
}

/// M2-T30: the lockfiles that name a package manager, in precedence order, with their install.
const LOCKFILES: &[(&str, PackageManager, &str)] = &[
    (
        "pnpm-lock.yaml",
        PackageManager::Pnpm,
        "pnpm install --frozen-lockfile",
    ),
    // TD-176: Yarn 1.x ignores --immutable (it needs --frozen-lockfile).
    (
        "yarn.lock",
        PackageManager::Yarn,
        "yarn install --immutable",
    ),
    ("package-lock.json", PackageManager::Npm, "npm ci"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedManager {
    pub manager: PackageManager,
    /// The lockfile that decided it; None = only a `package.json`.
    pub lockfile: Option<&'static str>,
    pub install: &'static str,
}

/// The package manager of the repo at `dir`, from its committed lockfile; None = not a Node repo.
pub fn detect_package_manager(dir: &Path) -> Option<DetectedManager> {
    for (file, manager, install) in LOCKFILES {
        if dir.join(file).exists() {
            return Some(DetectedManager {
                manager: *manager,
                lockfile: Some(file),
                install,
            });
        }
    }
    dir.join("package.json")
        .exists()
        .then_some(DetectedManager {
            manager: PackageManager::Npm,
            lockfile: None,
            install: "npm install",
        })
}

/// The fresh checkout's setup: `configured` when set (`""` = none), else from the lockfile.
pub fn detect_setup(dir: &Path, configured: Option<&str>) -> Option<String> {
    if let Some(c) = configured {
        return (!c.trim().is_empty()).then(|| c.to_string());
    }
    detect_package_manager(dir).map(|d| d.install.to_string())
}

// A command segment starts the string or follows `&&`, `||`, `;` or a newline.
static NPM_SCRIPT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(^|&&|\\|\\||;|\\n)(\\s*)npm (run|run-script|test)(?=\\s|$)").unwrap()
});
static MANAGER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?:^|&&|\\|\\||;|\\n)\\s*(pnpm|yarn|npm)(?=\\s|$)").unwrap());

/// M2-T30: a check written for npm (`npm run <script>`, `npm test`) runs with the repo's own
/// package manager. npm repos and non-Node repos get `cmd` unchanged.
pub fn managed_command(dir: &Path, cmd: &str) -> String {
    let pm = match detect_package_manager(dir) {
        None => return cmd.to_string(),
        Some(d) if d.manager == PackageManager::Npm => return cmd.to_string(),
        Some(d) => d.manager.name(),
    };
    let mut out = String::new();
    let mut last = 0;
    for m in NPM_SCRIPT_RE.find_iter(cmd) {
        let r = m.range();
        let g = |i: usize| m.group(i).map(|x| &cmd[x]).unwrap_or("");
        out.push_str(&cmd[last..r.start]);
        let sub = if g(3) == "test" { "test" } else { "run" };
        out.push_str(&format!("{}{}{pm} {sub}", g(1), g(2)));
        last = r.end;
    }
    out.push_str(&cmd[last..]);
    out
}

/// M2-T30: when `cmd` runs a package manager (at the start of a command segment) that is not on
/// `path` (default: the daemon's PATH), a message naming it; None = every one it uses is there.
pub fn missing_manager(cmd: &str, path: Option<&str>) -> Option<String> {
    let env = platform::spawn::process_env();
    let path = match path {
        Some(p) => p.to_string(),
        None => platform::spawn::env_get(&env, "PATH")
            .unwrap_or("")
            .to_string(),
    };
    let mut used: Vec<&str> = Vec::new();
    for m in MANAGER_RE.find_iter(cmd) {
        if let Some(r) = m.group(1) {
            let b = &cmd[r];
            if !used.contains(&b) {
                used.push(b);
            }
        }
    }
    let missing: Vec<&str> = used
        .into_iter()
        .filter(|b| !platform::is_on_path(b, &path, &env))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let names = missing
        .iter()
        .map(|b| format!("`{b}`"))
        .collect::<Vec<_>>()
        .join(" and ");
    Some(format!(
        "{names} {} not on this machine's PATH, so `{cmd}` cannot run: install {} for the daemon's user and restart the daemon",
        if missing.len() == 1 { "is" } else { "are" },
        missing.join(" and ")
    ))
}

/// Remove a checkout (3 retries 50 ms apart, as `rmSync` `maxRetries`); errors are ignored.
pub fn remove_checkout(dir: &Path) {
    for attempt in 0..4 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 3 => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return,
        }
    }
}

/// On daemon start: remove fresh checkouts and push repos a previous daemon left behind.
pub fn sweep_private(root: &Path) {
    let base = root.join("private");
    if !base.exists() && std::fs::symlink_metadata(&base).is_err() {
        return;
    }
    // Same rule as private_dir: a real directory owned by this user, never followed.
    let opts = acl::AssertOwnerOnlyOptions {
        kind: acl::AclKind::Dir,
        check_access: false,
    };
    if acl::assert_owner_only(&base, opts).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&base) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("check-") || name.starts_with("push-") {
            remove_checkout(&e.path());
        }
    }
}

#[cfg(test)]
mod tests;
