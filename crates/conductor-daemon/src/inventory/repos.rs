//! Port of `packages/daemon/src/inventory/repos.ts` (MR-T11): the repo half of the inventory
//! (M2-T10; ADR-0013 §Inventory, 10-contracts §Machines protocol v2).
//!
//! Walks the configured roots for git work trees: depth ≤ 6, never through a symlink (or a
//! junction), skipping `node_modules` and dot-directories. Per repo it reads only refs and
//! `remote.origin.url`, with hooks off and no system config ([`git_read`]); it runs no repo code.
//! Remotes are canonicalised with the shared `canonical_repo` (TD-107: no copy of the grammar).
//!
//! No OS `cfg` here (tests/seam.rs).

use crate::claude::transcript::realpath;
use crate::exec::{Env, sv};
use crate::inventory::git::git_read;
use crate::platform;
use conductor_protocol::repo::{canonical_repo, is_canonical_remote};
use conductor_protocol::{InventoryRepo, WorkingCopyMode};
use futures_util::StreamExt;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Where the scanners log (the TS `log?: (msg) => void`).
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// A log that drops everything.
pub fn no_log() -> Log {
    Arc::new(|_| {})
}

/// The deepest directory level a repo is found at (the root is 0).
pub const MAX_DEPTH: usize = 6;
/// Walk bounds: a huge home dir must not stall the daemon.
pub const MAX_DIRS: usize = 50_000;
pub const MAX_REPOS: usize = 1_000;
const CONCURRENCY: usize = 8;

#[derive(Clone)]
pub struct ScanReposOptions {
    pub roots: Vec<PathBuf>,
    /// Per-repo working-copy mode from `config.json`, by absolute path. Default `reference`.
    pub modes: BTreeMap<String, WorkingCopyMode>,
    /// When non-empty, a remote on another host is reported as null.
    pub allowed_repo_hosts: Vec<String>,
    /// Tests only (CONDUCTOR_TEST_REMOTE_ALIASES): checkout path → canonical remote.
    pub test_remote_aliases: BTreeMap<PathBuf, String>,
    /// The git environment (default: this process's).
    pub env: Option<Env>,
    pub log: Log,
}

impl ScanReposOptions {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        ScanReposOptions {
            roots,
            modes: BTreeMap::new(),
            allowed_repo_hosts: Vec::new(),
            test_remote_aliases: BTreeMap::new(),
            env: None,
            log: no_log(),
        }
    }
}

fn is_work_tree(dir: &Path) -> bool {
    // A directory, or a file (`gitdir: …`) for linked worktrees and submodules.
    std::fs::symlink_metadata(dir.join(".git"))
        .map(|m| m.is_dir() || m.is_file())
        .unwrap_or(false)
}

/// The work trees under `roots`, absolute, de-duplicated, in walk order.
pub fn find_work_trees(roots: &[PathBuf], log: &Log) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut visited = 0usize;
    for raw in roots {
        // The root the user chose may itself be a symlink; nothing under it is followed.
        let root = match realpath(&platform::resolve(raw)) {
            Ok(r) => r,
            Err(_) => {
                log(&format!(
                    "inventory: root {} is missing or unreadable; skipped",
                    raw.display()
                ));
                continue;
            }
        };
        let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(root, 0)]);
        while let Some((dir, depth)) = queue.pop_front() {
            if !seen.insert(dir.clone()) {
                continue;
            }
            visited += 1;
            if visited > MAX_DIRS {
                log(&format!("inventory: stopped after {MAX_DIRS} directories"));
                return found;
            }
            if is_work_tree(&dir) {
                found.push(dir);
                if found.len() >= MAX_REPOS {
                    log(&format!("inventory: stopped after {MAX_REPOS} repos"));
                    return found;
                }
                continue; // nested repos (submodules) are not separate inventory entries
            }
            if depth >= MAX_DEPTH {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue; // EACCES, vanished
            };
            for e in entries.flatten() {
                // `file_type` doesn't follow links: a symlink or junction is never a directory here.
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let name = e.file_name();
                let name = name.to_string_lossy();
                if !is_dir || name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                queue.push_back((dir.join(&*name), depth + 1));
            }
        }
    }
    found
}

/// `origin`'s URL as a canonical remote, or None (unparsable, refused or a disallowed host).
pub fn canonical_remote(url: &str, allowed_repo_hosts: &[String]) -> Option<String> {
    let c = canonical_repo(js_trim(url))?;
    if !is_canonical_remote(&c) {
        return None;
    }
    let host = &c[..c.find('/').unwrap_or(c.len())];
    if !allowed_repo_hosts.is_empty()
        && !allowed_repo_hosts.iter().any(|h| h.to_lowercase() == host)
    {
        return None;
    }
    Some(c)
}

/// ECMAScript white space and line terminators (`String.prototype.trim`, the regex `\s`).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn real_or_self(p: &Path) -> PathBuf {
    realpath(p).unwrap_or_else(|_| platform::resolve(p))
}

/// The shared `isAbsolutePath` (`machines/inventory.ts`, ADR-0024 §8): the refinement of
/// `AbsolutePathSchema`, which the generated `AbsolutePath` type doesn't carry.
pub fn is_inventory_absolute_path(p: &str) -> bool {
    if p.encode_utf16().count() < 2 || p.contains('\0') {
        return false;
    }
    let dot_seg = |seg: &str| seg == "." || seg == "..";
    if p.starts_with("//") {
        return false;
    }
    if p.starts_with('/') {
        return !p.split('/').any(dot_seg);
    }
    let b = p.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    {
        return !p[2..].contains(':') && !p.split(['\\', '/']).any(dot_seg);
    }
    false
}

/// The `BranchNameSchema` refinement: 1–255 chars, no white space or NUL, no leading `-`, no `..`.
fn branch_problem(b: &str) -> Option<&'static str> {
    let n = b.encode_utf16().count();
    if n < 1 {
        return Some("Too small: expected string to have >=1 characters");
    }
    if n > 255 {
        return Some("Too big: expected string to have <=255 characters");
    }
    if b.chars().any(|c| is_js_space(c) || c == '\0') || b.starts_with('-') || b.contains("..") {
        return Some("expected a branch name");
    }
    None
}

fn is_head_commit(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64)
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Why an entry fails `InventoryRepoSchema` (the first problem), or None.
pub fn inventory_repo_problem(
    path: &str,
    remote: Option<&str>,
    default_branch: &str,
    head_commit: &str,
) -> Option<String> {
    if path.encode_utf16().count() < 2 {
        return Some("path: Too small: expected string to have >=2 characters".into());
    }
    if !is_inventory_absolute_path(path) {
        return Some("path: expected an absolute path without . or .. segments".into());
    }
    if let Some(r) = remote
        && !is_canonical_remote(r)
    {
        return Some("remote: expected host/org/repo".into());
    }
    if let Some(p) = branch_problem(default_branch) {
        return Some(format!("default_branch: {p}"));
    }
    if !is_head_commit(head_commit) {
        return Some("head_commit: Invalid string: must match pattern".into());
    }
    None
}

async fn default_branch(dir: &Path, env: Option<&[(String, String)]>) -> String {
    let head = git_read(
        dir,
        &sv(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
        env,
    )
    .await;
    const PREFIX: &str = "refs/remotes/origin/";
    let r = js_trim(&head.stdout);
    if head.code == Some(0) && r.starts_with(PREFIX) && r.len() > PREFIX.len() {
        return r[PREFIX.len()..].to_string();
    }
    for b in ["main", "master"] {
        for r in [
            format!("refs/remotes/origin/{b}"),
            format!("refs/heads/{b}"),
        ] {
            let args = vec![
                "show-ref".to_string(),
                "--verify".into(),
                "--quiet".into(),
                r,
            ];
            if git_read(dir, &args, env).await.code == Some(0) {
                return b.to_string();
            }
        }
    }
    "main".to_string()
}

/// One repo's inventory entry, or None (no commit yet, or it fails `InventoryRepoSchema`).
pub async fn scan_repo(
    dir: &Path,
    opts: &ScanReposOptions,
    aliases: &HashMap<PathBuf, String>,
) -> Option<InventoryRepo> {
    let env = opts.env.as_deref();
    let head = git_read(
        dir,
        &sv(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
        env,
    )
    .await;
    if head.code != Some(0) {
        return None;
    }
    let remote = match aliases.get(&real_or_self(dir)) {
        Some(alias) => Some(alias.clone()),
        None => {
            let url = git_read(dir, &sv(&["config", "--get", "remote.origin.url"]), env).await;
            if url.code == Some(0) {
                canonical_remote(&url.stdout, &opts.allowed_repo_hosts)
            } else {
                None
            }
        }
    };
    let path = path_string(dir);
    let branch = default_branch(dir, env).await;
    let head_commit = js_trim(&head.stdout).to_string();
    let mode = opts
        .modes
        .get(&path)
        .copied()
        .unwrap_or(WorkingCopyMode::Reference);
    if let Some(why) = inventory_repo_problem(&path, remote.as_deref(), &branch, &head_commit) {
        (opts.log)(&format!("inventory: {path} not reported: {why}"));
        return None;
    }
    let built = (|| -> Result<InventoryRepo, String> {
        Ok(InventoryRepo {
            path: path.as_str().try_into().map_err(|e| format!("path: {e}"))?,
            remote: remote.clone(),
            default_branch: branch
                .as_str()
                .try_into()
                .map_err(|e| format!("default_branch: {e}"))?,
            head_commit: head_commit
                .as_str()
                .try_into()
                .map_err(|e| format!("head_commit: {e}"))?,
            mode,
        })
    })();
    match built {
        Ok(r) => Some(r),
        Err(why) => {
            (opts.log)(&format!("inventory: {path} not reported: {why}"));
            None
        }
    }
}

/// JS `a < b` on strings: UTF-16 code unit order (byte order differs outside the BMP).
pub fn js_str_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Every reportable repo under the roots, sorted by path. Never fails for one bad repo.
pub async fn scan_repos(opts: &ScanReposOptions) -> Vec<InventoryRepo> {
    let dirs = find_work_trees(&opts.roots, &opts.log);
    let aliases: HashMap<PathBuf, String> = opts
        .test_remote_aliases
        .iter()
        .map(|(p, r)| (real_or_self(p), r.clone()))
        .collect();
    let aliases = &aliases;
    // Owned items: a stream of `&PathBuf` makes the future fail rustc's higher-ranked `Send`
    // check (rust-lang/rust#102211), and the daemon core spawns the scan (MR-T12).
    let mut out: Vec<InventoryRepo> = futures_util::stream::iter(dirs.iter().cloned())
        .map(|dir: PathBuf| async move { scan_repo(&dir, opts, aliases).await })
        .buffer_unordered(CONCURRENCY)
        .filter_map(|r| async move { r })
        .collect()
        .await;
    out.sort_by(|a, b| js_str_cmp(&a.path, &b.path));
    out
}

#[cfg(test)]
mod tests;
