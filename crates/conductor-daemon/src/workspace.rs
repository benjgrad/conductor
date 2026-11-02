//! Port of `packages/daemon/src/workspace.ts` (MR-T10).
//!
//! Shared clones and per-session worktrees (07 §Code). One shared clone per repo under
//! `<root>/repos/`; agents never edit it. Each session gets `git worktree add <root>/wt/<session_id>`
//! on its own branch. A NEW worktree is based on the freshly fetched `origin/<default_branch>`
//! (M2-T13a, TD-026): `git fetch origin <default_branch>` runs before each new worktree,
//! serialised per clone. Existing worktrees and branches are reused untouched.
//!
//! No OS `cfg` here (tests/seam.rs).

use crate::exec::{Env, set_env};
use crate::platform::{self, CliOptions, Platform};
use crate::store::DaemonStore;
use conductor_protocol::RepoInventoryEntry;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Which `ticket.repo` values the daemon will clone (M1-T14; `DaemonConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoPolicy {
    /// Accept absolute paths and `file://` URLs (default false; the E2E fixture repo needs it).
    pub allow_local_repos: bool,
    /// When non-empty, the remote host must be one of these (case-insensitive).
    pub allowed_repo_hosts: Vec<String>,
}

impl From<&crate::config::DaemonConfig> for RepoPolicy {
    fn from(c: &crate::config::DaemonConfig) -> Self {
        RepoPolicy {
            allow_local_repos: c.allow_local_repos,
            allowed_repo_hosts: c.allowed_repo_hosts.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("repo not allowed: {quoted}: {why}")]
pub struct RepoNotAllowedError {
    quoted: String,
    pub why: String,
}

impl RepoNotAllowedError {
    pub fn new(repo: &str, why: impl Into<String>) -> Self {
        RepoNotAllowedError {
            quoted: serde_json::to_string(repo).unwrap_or_default(),
            why: why.into(),
        }
    }
}

/// Node's `path.isAbsolute` for this OS.
pub fn is_absolute_path(p: &str) -> bool {
    if Platform::current().is_windows() {
        platform::win_path::is_absolute(p)
    } else {
        p.starts_with('/')
    }
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn is_label(l: &str) -> bool {
    // [A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?
    let b = l.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

fn is_host(h: &str) -> bool {
    h.split('.').all(is_label)
}

fn is_segment(s: &str) -> bool {
    // [A-Za-z0-9_][A-Za-z0-9._-]*
    let b = s.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphanumeric() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `SEGMENT(?:/SEGMENT)+`
fn is_repo_path(p: &str) -> bool {
    let segs: Vec<&str> = p.split('/').collect();
    segs.len() >= 2 && segs.iter().all(|s| is_segment(s))
}

/// scp-style ssh `user@host:org/repo` → the host.
fn scp_host(repo: &str) -> Option<&str> {
    let (user, rest) = repo.split_once('@')?;
    if !is_segment(user) {
        return None;
    }
    let (host, path) = rest.split_once(':')?;
    (is_host(host) && is_repo_path(path)).then_some(host)
}

/// canonical `host/org/repo` → the host.
fn canonical_host(repo: &str) -> Option<&str> {
    let (host, path) = repo.split_once('/')?;
    (is_host(host) && is_repo_path(path)).then_some(host)
}

/// The hostname of an `https://` URL whose path is `/org/repo…` with no query or fragment, as
/// WHATWG `URL` would read it for the URLs the policy accepts (TD-206: a hand parser; exotic
/// forms such as IPv6 literals or percent-encoding are refused rather than normalised).
fn https_host(repo: &str) -> Result<String, &'static str> {
    let rest = &repo["https://".len()..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let after = &rest[end..];
    let host_port = match authority.rsplit_once('@') {
        Some((_, hp)) => hp,
        None => authority,
    };
    let host = match host_port.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
        Some(_) => return Err("not a valid URL"),
        None => host_port,
    };
    if host.is_empty() || !is_host(host) {
        return Err("not a valid URL");
    }
    let (path, extra) = match after.find(['?', '#']) {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, ""),
    };
    // `?` or `#` alone parse to an empty search / hash in WHATWG URL.
    if !(extra.is_empty() || extra == "?" || extra == "#") {
        return Err("expected https://host/org/repo");
    }
    match path.strip_prefix('/') {
        Some(p) if is_repo_path(p) => Ok(host.to_ascii_lowercase()),
        _ => Err("expected https://host/org/repo"),
    }
}

/// Validate `repo` against the policy and return where to clone it from (M1-T14). Accepted:
///   - canonical `host/org/repo` → `https://host/org/repo.git`
///   - `https://host[:port]/org/repo[.git]`, as is
///   - scp-style ssh `user@host:org/repo[.git]`, as is
///   - an absolute path or a `file://` URL, as is, only with `allow_local_repos`
///
/// Anything else is refused, and a remote host must be in `allowed_repo_hosts` when that list is
/// non-empty.
pub fn clone_source(repo: &str, policy: &RepoPolicy) -> Result<String, RepoNotAllowedError> {
    let err = |why: &str| RepoNotAllowedError::new(repo, why);
    // JS `\s` (plus NUL).
    if repo.is_empty() || repo.chars().any(|c| c == '\0' || is_js_space(c)) {
        return Err(err("empty or contains whitespace"));
    }
    if is_absolute_path(repo) || starts_with_ci(repo, "file:") {
        if !policy.allow_local_repos {
            return Err(err("local repos need allowLocalRepos"));
        }
        return Ok(repo.to_string());
    }
    let host: String;
    let source: String;
    if starts_with_ci(repo, "https://") {
        host = https_host(repo).map_err(err)?;
        source = repo.to_string();
    } else if let Some(h) = scp_host(repo) {
        host = h.to_string();
        source = repo.to_string();
    } else if let Some(h) = canonical_host(repo) {
        host = h.to_string();
        source = format!("https://{}.git", repo.strip_suffix(".git").unwrap_or(repo));
    } else {
        return Err(err(
            "expected host/org/repo, https://host/org/repo or user@host:org/repo",
        ));
    }
    if repo.split(['/', ':']).any(|s| s == ".." || s == ".") {
        return Err(err("path has . or .. segments"));
    }
    let allowed = &policy.allowed_repo_hosts;
    if !allowed.is_empty() && !allowed.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
        return Err(err(&format!("host {host} is not in allowedRepoHosts")));
    }
    Ok(source)
}

/// JS RegExp `\s`.
pub fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Filesystem-safe, collision-resistant directory name for a repo (byte-compatible with TS: the
/// clone dirs under `<root>/repos` are reused across the upgrade).
pub fn repo_slug(repo: &str) -> String {
    // .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    let mut s = repo;
    if let Some(i) = repo.find("://") {
        let scheme = &repo[..i];
        let b = scheme.as_bytes();
        if !b.is_empty()
            && b[0].is_ascii_alphabetic()
            && b.iter()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'))
        {
            s = &repo[i + 3..];
        }
    }
    // .replace(/[^A-Za-z0-9._-]+/g, '_')
    let mut readable = String::new();
    let mut in_run = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            readable.push(c);
            in_run = false;
        } else if !in_run {
            readable.push('_');
            in_run = true;
        }
    }
    // .replace(/^[_.]+/, '').slice(-60)
    let trimmed = readable.trim_start_matches(['_', '.']);
    let readable = &trimmed[trimmed.len().saturating_sub(60)..];
    let hash = hex::encode(Sha256::digest(repo.as_bytes()));
    format!(
        "{}-{}",
        if readable.is_empty() {
            "repo"
        } else {
            readable
        },
        &hash[..8]
    )
}

/// Max CLAUDE.md bytes passed via appendSystemPrompt; a larger file is skipped (M1-T14).
pub const MAX_CLAUDE_MD_BYTES: u64 = 64 * 1024;

/// A conservative subset of `git check-ref-format --branch`: ASCII letters, digits, `._/-`; no
/// leading `-` / `/` / `.`, no `..`, `//`, `/.`, trailing `/` or `.lock`.
pub fn is_safe_branch_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphanumeric() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'/' | b'-'))
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("/.")
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.split('/').any(|seg| seg.ends_with(".lock"))
}

/// The `repo_inventory` digest: sha256 of the entries' JSON with TS's key order.
pub fn inventory_digest(entries: &[RepoInventoryEntry]) -> String {
    #[derive(serde::Serialize)]
    struct Entry<'a> {
        repo: &'a str,
        path: &'a str,
        head_commit: &'a str,
        tree_clean: bool,
    }
    let ordered: Vec<Entry<'_>> = entries
        .iter()
        .map(|e| Entry {
            repo: e.repo.as_str(),
            path: e.path.as_str(),
            head_commit: &e.head_commit,
            tree_clean: e.tree_clean,
        })
        .collect();
    let json = serde_json::to_string(&ordered).expect("entries serialise");
    hex::encode(Sha256::digest(json.as_bytes()))
}

/// A failed git run: Node's `execFile` error (`message`, plus `stdout` / `stderr`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitError {
    pub message: String,
    pub stdout: String,
    pub stderr: String,
}

impl GitError {
    /// git's own message (stderr), else the error message (the TS `errText`).
    pub fn text(&self) -> String {
        let s = self.stderr.trim();
        if s.is_empty() {
            self.message.clone()
        } else {
            s.to_string()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    RepoNotAllowed(#[from] RepoNotAllowedError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("{0}")]
    Other(String),
}

impl WorkspaceError {
    fn text(&self) -> String {
        match self {
            WorkspaceError::Git(g) => g.text(),
            other => other.to_string(),
        }
    }
}

const GIT_MAX_BUFFER: usize = 16 * 1024 * 1024;

/// Run git in `cwd` with `env` (default: this process's) plus `GIT_TERMINAL_PROMPT=0`; stdout, or
/// a [`GitError`]. Through `platform::spawn`: on Windows a bare `git` never resolves from the cwd,
/// which is often an agent-writable worktree.
pub async fn git(cwd: &Path, args: &[String], env: Option<&Env>) -> Result<String, GitError> {
    let mut env = env.cloned().unwrap_or_else(platform::spawn::process_env);
    set_env(
        &mut env,
        "GIT_TERMINAL_PROMPT",
        "0",
        Platform::current().is_windows(),
    );
    let opts = CliOptions {
        cwd: Some(cwd.to_path_buf()),
        env: Some(env),
        ..Default::default()
    };
    let cmdline = format!("git {}", args.join(" "));
    match platform::exec_file_cli("git", args, opts).await {
        Err(e) => Err(GitError {
            message: e.to_string(),
            stdout: String::new(),
            stderr: String::new(),
        }),
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&out.output.stderr).into_owned();
            if out.output.stdout.len() > GIT_MAX_BUFFER {
                return Err(GitError {
                    message: "stdout maxBuffer length exceeded".into(),
                    stdout,
                    stderr,
                });
            }
            if out.output.status.success() {
                Ok(stdout)
            } else {
                Err(GitError {
                    message: format!("Command failed: {cmdline}\n{stderr}"),
                    stdout,
                    stderr,
                })
            }
        }
    }
}

fn p2s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// What `Workspace::ensure_worktree` needs.
#[derive(Debug, Clone, Default)]
pub struct EnsureWorktree {
    pub repo: String,
    pub session_id: String,
    pub branch: String,
    pub base_ref: String,
    /// The repo's default branch; None = the clone's `origin/HEAD`.
    pub default_branch: Option<String>,
}

/// A log sink.
pub type LogFn = Box<dyn Fn(&str) + Send + Sync>;

type Locks = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

/// Options beyond the repo policy.
#[derive(Default)]
pub struct WorkspaceOptions {
    pub policy: RepoPolicy,
    pub log: Option<LogFn>,
    /// The environment git runs with (default: this process's). Tests put a wrapper on PATH.
    pub env: Option<Env>,
}

pub struct Workspace {
    pub root_dir: PathBuf,
    store: Arc<Mutex<DaemonStore>>,
    policy: RepoPolicy,
    log: LogFn,
    env: Option<Env>,
    cloning: Locks,
    locks: Locks,
}

fn key_lock(locks: &Locks, key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut m = locks.lock().unwrap_or_else(|e| e.into_inner());
    m.entry(key.to_string()).or_default().clone()
}

impl Workspace {
    pub fn new(
        root_dir: impl Into<PathBuf>,
        store: Arc<Mutex<DaemonStore>>,
        opts: WorkspaceOptions,
    ) -> Self {
        Workspace {
            root_dir: root_dir.into(),
            store,
            policy: opts.policy,
            log: opts.log.unwrap_or_else(|| Box::new(|_| {})),
            env: opts.env,
            cloning: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn policy(&self) -> &RepoPolicy {
        &self.policy
    }

    pub fn worktree_path(&self, session_id: &str) -> PathBuf {
        self.root_dir.join("wt").join(session_id)
    }

    async fn git(&self, cwd: &Path, args: &[&str]) -> Result<String, GitError> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        git(cwd, &args, self.env.as_ref()).await
    }

    fn known_clone(&self, repo: &str) -> Option<PathBuf> {
        let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let known = store.repos().get(repo)?;
        let p = PathBuf::from(known);
        p.join(".git").exists().then_some(p)
    }

    /// The shared clone for `repo`, cloning it on first use (one clone at a time per repo).
    pub async fn ensure_clone(&self, repo: &str) -> Result<PathBuf, WorkspaceError> {
        if let Some(p) = self.known_clone(repo) {
            return Ok(p);
        }
        let lock = key_lock(&self.cloning, repo);
        let _held = lock.lock().await;
        if let Some(p) = self.known_clone(repo) {
            return Ok(p);
        }
        let repos_dir = self.root_dir.join("repos");
        std::fs::create_dir_all(&repos_dir).map_err(|e| WorkspaceError::Other(e.to_string()))?;
        let path = repos_dir.join(repo_slug(repo));
        if !path.join(".git").exists() {
            let src = clone_source(repo, &self.policy)?;
            self.git(&repos_dir, &["clone", "--quiet", "--", &src, &p2s(&path)])
                .await?;
        }
        self.store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put_repo(repo, &p2s(&path))
            .map_err(|e| WorkspaceError::Other(e.to_string()))?;
        Ok(path)
    }

    /// Create (or reuse) the session worktree on `branch` (see the TS doc comment):
    /// - an existing worktree is reused; an existing branch without one is checked out again;
    /// - ADR-0008 reopen: a branch checked out in another worktree directly under `<root>/wt` is
    ///   returned as is; checked out anywhere else is an error;
    /// - only a NEW branch fetches `origin <default_branch>` first and starts from it, without
    ///   upstream tracking. A failed fetch is an error naming the repo.
    pub async fn ensure_worktree(&self, o: &EnsureWorktree) -> Result<PathBuf, WorkspaceError> {
        let mut refs = vec![&o.branch, &o.base_ref];
        if let Some(d) = &o.default_branch {
            refs.push(d);
        }
        for r in refs {
            if r.is_empty() || r.starts_with('-') {
                return Err(WorkspaceError::Other(format!("invalid git ref: {r}")));
            }
        }
        if o.repo.starts_with('-') {
            return Err(WorkspaceError::Other(format!("invalid repo: {}", o.repo)));
        }
        clone_source(&o.repo, &self.policy)?; // before any clone or reuse (M1-T14)
        let clone = self.ensure_clone(&o.repo).await?;
        let path = self.worktree_path(&o.session_id);
        // Worktree mutations on one clone are serialized: a concurrent `worktree prune` could
        // otherwise drop another session's half-created worktree.
        let lock = key_lock(&self.locks, &p2s(&clone));
        let _held = lock.lock().await;
        if path.join(".git").exists() {
            return Ok(path);
        }
        let wt_dir = self.root_dir.join("wt");
        std::fs::create_dir_all(&wt_dir).map_err(|e| WorkspaceError::Other(e.to_string()))?;
        self.git(&clone, &["worktree", "prune"]).await?;
        if let Some(holder) = self.worktree_holding(&clone, &o.branch).await? {
            let holder = PathBuf::from(holder);
            let parent_is_wt = holder
                .parent()
                .is_some_and(|p| platform::same_path(p, &wt_dir));
            if parent_is_wt
                && holder.join(".git").exists()
                && let Some(name) = holder.file_name()
            {
                return Ok(wt_dir.join(name));
            }
            return Err(WorkspaceError::Other(format!(
                "branch {} is already checked out at {}",
                o.branch,
                holder.display()
            )));
        }
        let has_branch = self.git(&clone, &["branch", "--list", &o.branch]).await?;
        let ps = p2s(&path);
        if !has_branch.trim().is_empty() {
            self.git(&clone, &["worktree", "add", "--quiet", &ps, &o.branch])
                .await?;
        } else {
            let base = self
                .fresh_base(&o.repo, &clone, &o.base_ref, o.default_branch.as_deref())
                .await?;
            self.git(
                &clone,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "--no-track",
                    "-b",
                    &o.branch,
                    &ps,
                    &base,
                ],
            )
            .await?;
        }
        Ok(path)
    }

    /// Fetch the default branch into the clone and return the ref a new session branch starts
    /// from. Hooks are off for the fetch (the repo is untrusted).
    async fn fresh_base(
        &self,
        repo: &str,
        clone: &Path,
        base_ref: &str,
        default_branch: Option<&str>,
    ) -> Result<String, WorkspaceError> {
        let branch = match default_branch {
            Some(b) => b.to_string(),
            None => self.origin_head(clone).await.map_err(|e| {
                WorkspaceError::Other(format!(
                    "cannot resolve the default branch of {repo}: {}",
                    e.text()
                ))
            })?,
        };
        if !is_safe_branch_name(&branch) {
            return Err(WorkspaceError::Other(format!(
                "invalid default branch for {repo}: {}",
                serde_json::to_string(&branch).unwrap_or_default()
            )));
        }
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        self.git(
            clone,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "fetch",
                "--quiet",
                "origin",
                &refspec,
            ],
        )
        .await
        .map_err(|e| {
            WorkspaceError::Other(format!(
                "git fetch origin {branch} failed for {repo}: {}",
                e.text()
            ))
        })?;
        Ok(if base_ref == "HEAD" {
            format!("refs/remotes/origin/{branch}")
        } else {
            base_ref.to_string()
        })
    }

    /// The clone's default branch from `refs/remotes/origin/HEAD`, set once with
    /// `git remote set-head origin --auto` when missing. The loose ref file is read first.
    async fn origin_head(&self, clone: &Path) -> Result<String, WorkspaceError> {
        if let Some(b) = self.read_origin_head(clone).await {
            return Ok(b);
        }
        self.git(clone, &["remote", "set-head", "origin", "--auto"])
            .await?;
        self.read_origin_head(clone)
            .await
            .ok_or_else(|| WorkspaceError::Other("origin/HEAD is not set".into()))
    }

    async fn read_origin_head(&self, clone: &Path) -> Option<String> {
        const PREFIX: &str = "refs/remotes/origin/";
        let file = clone.join(".git/refs/remotes/origin/HEAD");
        if let Ok(text) = std::fs::read_to_string(file)
            && let Some(rest) = text.strip_prefix("ref: refs/remotes/origin/")
        {
            let name = rest.trim_end_matches(is_js_space);
            if !name.is_empty() && !name.chars().any(is_js_space) {
                return Some(name.to_string());
            }
        }
        let symref = format!("{PREFIX}HEAD");
        let r = self
            .git(clone, &["symbolic-ref", "--quiet", &symref])
            .await
            .ok()?;
        let r = r.trim();
        (r.starts_with(PREFIX) && r.len() > PREFIX.len()).then(|| r[PREFIX.len()..].to_string())
    }

    /// The worktree that has `branch` checked out (`git worktree list --porcelain`), or None.
    async fn worktree_holding(
        &self,
        clone: &Path,
        branch: &str,
    ) -> Result<Option<String>, GitError> {
        let out = self
            .git(clone, &["worktree", "list", "--porcelain"])
            .await?;
        Ok(parse_worktree_holding(&out, branch))
    }

    /// The worktree's CLAUDE.md (U-013), or None. The repo is untrusted (M1-T14): read only when
    /// lstat says it is a regular file (not a symlink), its realpath is inside the worktree, and
    /// it is at most [`MAX_CLAUDE_MD_BYTES`]; otherwise skipped with a log line. Type and size are
    /// checked again on the open file.
    ///
    /// TD-207: TS opens with `O_NOFOLLOW`; here the open follows a symlink swapped in after the
    /// lstat, and the post-open `metadata` (of the target) can't tell. The realpath check runs
    /// first in both.
    pub fn read_claude_md(&self, worktree: &Path) -> Option<String> {
        let path = worktree.join("CLAUDE.md");
        let skip = |why: &str| -> Option<String> {
            (self.log)(&format!("skipping {}: {why}", path.display()));
            None
        };
        let Ok(st) = std::fs::symlink_metadata(&path) else {
            return None; // absent
        };
        if st.file_type().is_symlink() || platform::fs::is_reparse_point(&st) {
            return skip("it is a symlink");
        }
        if !st.is_file() {
            return skip("not a regular file");
        }
        if st.len() > MAX_CLAUDE_MD_BYTES {
            return skip(&format!("larger than {MAX_CLAUDE_MD_BYTES} bytes"));
        }
        let inside = match (
            std::fs::canonicalize(worktree),
            std::fs::canonicalize(&path),
        ) {
            (Ok(w), Ok(f)) => f
                .strip_prefix(&w)
                .is_ok_and(|rel| !rel.as_os_str().is_empty()),
            (Err(e), _) | (_, Err(e)) => return skip(&e.to_string()),
        };
        if !inside {
            return skip("it resolves outside the worktree");
        }
        use std::io::Read;
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => return skip(&e.to_string()),
        };
        let fst = match f.metadata() {
            Ok(m) => m,
            Err(e) => return skip(&e.to_string()),
        };
        if !fst.is_file() {
            return skip("not a regular file");
        }
        if fst.len() > MAX_CLAUDE_MD_BYTES {
            return skip(&format!("larger than {MAX_CLAUDE_MD_BYTES} bytes"));
        }
        let mut buf = Vec::new();
        if let Err(e) = f
            .by_ref()
            .take(MAX_CLAUDE_MD_BYTES + 1)
            .read_to_end(&mut buf)
        {
            return skip(&e.to_string());
        }
        if buf.len() as u64 > MAX_CLAUDE_MD_BYTES {
            return skip(&format!("larger than {MAX_CLAUDE_MD_BYTES} bytes"));
        }
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    /// `repo_inventory` entries for every shared clone, sorted by repo.
    pub async fn inventory(&self) -> Vec<RepoInventoryEntry> {
        let repos: Vec<(String, String)> = {
            let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            store
                .repos()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        let mut out: Vec<RepoInventoryEntry> = Vec::new();
        for (repo, path) in repos {
            let p = PathBuf::from(&path);
            if !p.join(".git").exists() {
                continue;
            }
            let mut head = String::new();
            let mut clean = false;
            if let Ok(h) = self.git(&p, &["rev-parse", "HEAD"]).await {
                head = h.trim().to_string();
                if let Ok(st) = self.git(&p, &["status", "--porcelain"]).await {
                    clean = st.trim().is_empty();
                }
            }
            // An empty repo has no HEAD; report it as not clean.
            let entry = serde_json::json!({
                "repo": repo, "path": path, "head_commit": head, "tree_clean": clean,
            });
            if let Ok(e) = serde_json::from_value::<RepoInventoryEntry>(entry) {
                out.push(e);
            }
        }
        out.sort_by(|a, b| locale_compare(a.repo.as_str(), b.repo.as_str()));
        out
    }
}

/// The holder of `branch` in `git worktree list --porcelain` output.
pub fn parse_worktree_holding(out: &str, branch: &str) -> Option<String> {
    let want = format!("branch refs/heads/{branch}");
    let normalized = out.replace("\r\n", "\n");
    let mut blocks: Vec<Vec<&str>> = vec![Vec::new()];
    for line in normalized.split('\n') {
        if line.trim().is_empty() {
            blocks.push(Vec::new());
        } else if let Some(b) = blocks.last_mut() {
            b.push(line);
        }
    }
    for lines in blocks {
        let path = lines.iter().find_map(|l| l.strip_prefix("worktree "));
        if let Some(path) = path
            && lines.iter().any(|l| *l == want)
        {
            return Some(path.to_string());
        }
    }
    None
}

/// An approximation of ICU `localeCompare` for repo names (TD-208): case-insensitive first, then
/// lowercase before uppercase (ICU's tertiary order). ICU also orders punctuation before letters
/// and digits, which this does not.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

#[cfg(test)]
mod tests;
