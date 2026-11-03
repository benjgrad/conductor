//! Port of `packages/daemon/src/inventory/report.ts` (MR-T11): the `inventory` message (M2-T10;
//! ADR-0013 §Inventory, 10-contracts §Machines protocol v2).
//!
//! Sent after every `registered`, and after a rescan (every 10 minutes, on SIGHUP on POSIX, and
//! when the `<root>/state/rescan` trigger file appears) when its hash changed. Each one replaces
//! the machine's previous inventory wholesale; `hash` is also `request_work.repos_digest`.
//!
//! The hash must be byte-identical to the TS daemon's for the same machine state, so a machine
//! that moves from TS to Rust doesn't look changed: the hashed JSON keeps TS's key order and
//! string order (UTF-16 code units). `tests/fixtures/ts/inventory-payload.json`, written by the TS
//! code, is checked on both sides.
//!
//! No OS `cfg` here (tests/seam.rs). SIGHUP is wired by `main` (MR-T13), calling
//! [`InventoryReporter::rescan`].

use crate::config::{DaemonConfig, read_file_config};
use crate::inventory::capabilities::{ScanCapabilitiesOptions, scan_capabilities};
use crate::inventory::repos::{Log, MAX_DEPTH, ScanReposOptions, js_str_cmp, scan_repos};
use crate::platform::{self, machine};
use conductor_protocol::{Capability, InventoryPayload, InventoryRepo, WorkingCopyMode};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::task::AbortHandle;

/// One scan's result, before normalising.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InventoryScan {
    pub repos: Vec<InventoryRepo>,
    pub capabilities: Vec<Capability>,
}

/// A capability as a string with a fixed key order (sorting and hashing): the TS `capString`.
pub fn cap_string(c: &Capability) -> String {
    let s = match c {
        Capability::Cli {
            name,
            version,
            authed,
        } => serde_json::to_string(&("cli", name.as_str(), version.as_deref(), authed)),
        Capability::Mcp { name } => serde_json::to_string(&("mcp", name.as_str())),
        Capability::Skill { name, repo } => {
            serde_json::to_string(&("skill", name.as_str(), repo.as_deref()))
        }
        Capability::Agent { name, repo } => {
            serde_json::to_string(&("agent", name.as_str(), repo.as_deref()))
        }
        Capability::Claude { version } => serde_json::to_string(&("claude", version.as_str())),
    };
    s.expect("strings serialise")
}

/// The scan with repos sorted by path and capabilities in a stable order.
pub fn normalize_scan(scan: &InventoryScan) -> InventoryScan {
    let mut repos = scan.repos.clone();
    repos.sort_by(|a, b| js_str_cmp(&a.path, &b.path));
    let mut caps: Vec<(String, Capability)> = scan
        .capabilities
        .iter()
        .map(|c| (cap_string(c), c.clone()))
        .collect();
    caps.sort_by(|(a, _), (b, _)| js_str_cmp(a, b));
    InventoryScan {
        repos,
        capabilities: caps.into_iter().map(|(_, c)| c).collect(),
    }
}

/// sha256 of the normalised inventory. Order-independent; versions count (an upgrade is re-sent).
pub fn inventory_hash(scan: &InventoryScan) -> String {
    // Field order is TS's `{ repos, capabilities }` (a serde_json Map would sort the keys).
    #[derive(Serialize)]
    struct Hashed<'a> {
        repos: Vec<(&'a str, Option<&'a str>, &'a str, &'a str, WorkingCopyMode)>,
        capabilities: Vec<String>,
    }
    let n = normalize_scan(scan);
    let hashed = Hashed {
        repos: n
            .repos
            .iter()
            .map(|r| {
                (
                    r.path.as_str(),
                    r.remote.as_deref(),
                    r.default_branch.as_str(),
                    r.head_commit.as_str(),
                    r.mode,
                )
            })
            .collect(),
        capabilities: n.capabilities.iter().map(cap_string).collect(),
    };
    let json = serde_json::to_string(&hashed).expect("the inventory serialises");
    hex::encode(Sha256::digest(json.as_bytes()))
}

pub fn inventory_payload(scan: &InventoryScan) -> InventoryPayload {
    let n = normalize_scan(scan);
    let hash = inventory_hash(&n);
    InventoryPayload {
        repos: n.repos,
        capabilities: n.capabilities,
        hash: hash.as_str().try_into().expect("a sha256 is not empty"),
    }
}

/// The real scan: roots from CONDUCTOR_ROOTS, else `<root>/config.json` (re-read every scan).
/// `env` is the probe and git environment (this process's in production).
pub async fn scan_inventory(
    config: &DaemonConfig,
    env: &[(String, String)],
    log: Log,
) -> InventoryScan {
    let file = match read_file_config(&config.root_dir) {
        Ok(f) => f,
        Err(e) => {
            log(&format!("inventory: {e}; using no roots"));
            Default::default()
        }
    };
    let roots: Vec<PathBuf> = config
        .roots_override
        .clone()
        .unwrap_or_else(|| file.roots.iter().map(PathBuf::from).collect());
    let mut repos_opts = ScanReposOptions::new(roots.clone());
    repos_opts.modes = file
        .repos
        .iter()
        .map(|(p, r)| (p.clone(), r.mode))
        .collect();
    repos_opts.allowed_repo_hosts = config.allowed_repo_hosts.clone();
    repos_opts.test_remote_aliases = config.test_remote_aliases.clone();
    repos_opts.env = Some(env.to_vec());
    repos_opts.log = log.clone();
    let repos = scan_repos(&repos_opts).await;
    for w in repo_warnings(&roots, &repos) {
        log(&w);
    }

    let get = |k: &str| platform::spawn::env_get(env, k).filter(|v| !v.is_empty());
    // Claude Code keeps its user config (with user-scope MCP servers) next to the config dir when
    // CLAUDE_CONFIG_DIR is set, else in ~/.claude.json.
    let claude_user_config = if get("CLAUDE_CONFIG_DIR").is_some() {
        config.claude_config_dir.join(".claude.json")
    } else {
        machine::home_dir().join(".claude.json")
    };
    let mut caps_opts =
        ScanCapabilitiesOptions::new(config.claude_config_dir.clone(), claude_user_config);
    caps_opts.claude_bin = platform::spawn::env_get(env, "CONDUCTOR_CLAUDE_BIN")
        .unwrap_or("claude")
        .to_string();
    caps_opts.repos = repos.clone();
    caps_opts.env = Some(env.to_vec());
    caps_opts.log = log;
    let capabilities = scan_capabilities(&caps_opts).await;
    InventoryScan {
        repos,
        capabilities,
    }
}

/// Why tickets may not reach this machine, from the repo half of a scan: no roots, no repos under
/// them, or a repo whose origin can't be routed. The daemon logs these through [`once_log`].
pub fn repo_warnings(roots: &[PathBuf], repos: &[InventoryRepo]) -> Vec<String> {
    if roots.is_empty() {
        return vec![
            "inventory: no repo roots configured, so no tickets can be routed here; run: conductor-daemon config roots <dir>"
                .to_string(),
        ];
    }
    if repos.is_empty() {
        let list: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
        return vec![format!(
            "inventory: no git repos found under {} (searched {MAX_DEPTH} levels deep)",
            list.join(", ")
        )];
    }
    repos
        .iter()
        .filter(|r| r.remote.is_none())
        .map(|r| {
            format!(
                "inventory: {} has no usable origin remote; tickets can't be routed to it",
                r.path.as_str()
            )
        })
        .collect()
}

/// How many routable remotes the summary line names before `…`.
pub const SUMMARY_REMOTES: usize = 10;

/// The line logged when an inventory with a new hash is sent: which repos tickets can reach.
pub fn inventory_summary(p: &InventoryPayload) -> String {
    let mut remotes: Vec<&str> = Vec::new();
    for r in &p.repos {
        if let Some(remote) = r.remote.as_deref()
            && !remotes.contains(&remote)
        {
            remotes.push(remote);
        }
    }
    let routable = if remotes.is_empty() {
        "0 routable".to_string()
    } else {
        let shown = remotes[..remotes.len().min(SUMMARY_REMOTES)].join(", ");
        let more = if remotes.len() > SUMMARY_REMOTES {
            ", …"
        } else {
            ""
        };
        format!("{} routable: {shown}{more}", remotes.len())
    };
    format!(
        "inventory: sent {} repos ({routable}) and {} capabilities",
        p.repos.len(),
        p.capabilities.len()
    )
}

/// Messages remembered by [`once_log`] before it forgets them all (memory stays bounded).
pub const ONCE_LOG_CAP: usize = 1000;

/// `log` that prints each distinct message once per process. Scans repeat every 10 minutes; their
/// warnings (an invalid capability name, no roots, …) would otherwise repeat with them.
pub fn once_log(log: Log, cap: usize) -> Log {
    let seen: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    Arc::new(move |msg: &str| {
        {
            let mut s = seen.lock().unwrap_or_else(|e| e.into_inner());
            if s.contains(msg) {
                return;
            }
            if s.len() >= cap {
                s.clear();
            }
            s.insert(msg.to_string());
        }
        log(msg);
    })
}

/// What a reporter scans with. An error keeps the previous inventory.
pub type ScanFn = Arc<dyn Fn() -> BoxFuture<'static, Result<InventoryScan, String>> + Send + Sync>;
/// Where a reporter sends an `inventory` payload.
pub type SendFn = Arc<dyn Fn(InventoryPayload) + Send + Sync>;

type Scanning = Shared<BoxFuture<'static, ()>>;

#[derive(Default)]
struct State {
    latest: Option<InventoryPayload>,
    last_sent_hash: String,
    last_logged_hash: String,
    connected: bool,
    scanning: Option<Scanning>,
    again: bool,
    timer: Option<AbortHandle>,
}

struct Inner {
    scan: ScanFn,
    send: SendFn,
    interval: Duration,
    log: Log,
    state: Mutex<State>,
}

/// Scans, keeps the latest inventory and sends it: always after `registered`, otherwise only when
/// its hash changed since the last send. One scan at a time (a rescan asked for during a scan runs
/// once after it). A failed scan keeps the previous inventory. Cheap to clone (one shared state).
#[derive(Clone)]
pub struct InventoryReporter {
    inner: Arc<Inner>,
}

impl InventoryReporter {
    /// `interval`: the rescan period (ADR-0013: 10 minutes).
    pub fn new(scan: ScanFn, send: SendFn, interval: Duration, log: Log) -> Self {
        InventoryReporter {
            inner: Arc::new(Inner {
                scan,
                send,
                interval,
                log,
                state: Mutex::new(State::default()),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// First scan now (usually done before `registered` arrives), then every interval.
    pub fn start(&self) {
        // Spawned by scan_once: it runs to the end without being awaited here.
        drop(self.scan_once());
        let mut st = self.state();
        if st.timer.is_none() {
            let me = self.clone();
            let interval = self.inner.interval;
            let task = tokio::spawn(async move {
                let mut tick =
                    tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tick.tick().await;
                    me.rescan().await;
                }
            });
            st.timer = Some(task.abort_handle());
        }
    }

    pub fn stop(&self) {
        let mut st = self.state();
        if let Some(t) = st.timer.take() {
            t.abort();
        }
        st.connected = false;
    }

    /// The hash of the last inventory sent ("" before the first): `request_work.repos_digest`.
    pub fn hash(&self) -> String {
        self.state().last_sent_hash.clone()
    }

    /// After `registered`: wait for a scan (the running one, or a first one), then always send.
    pub async fn on_registered(&self) {
        let running = {
            let mut st = self.state();
            st.connected = true;
            st.scanning.clone()
        };
        if let Some(s) = running {
            s.await;
        }
        if self.state().latest.is_none() {
            self.scan_once().await;
        }
        let ready = {
            let st = self.state();
            st.latest.is_some() && st.connected
        };
        if ready {
            self.send_latest();
        }
    }

    pub fn on_disconnected(&self) {
        self.state().connected = false;
    }

    /// Rescan (timer, SIGHUP, the trigger file); send when connected and the hash changed.
    pub async fn rescan(&self) {
        self.scan_once().await;
        let changed = {
            let st = self.state();
            st.connected
                && st
                    .latest
                    .as_ref()
                    .is_some_and(|p| p.hash.as_str() != st.last_sent_hash)
        };
        if changed {
            self.send_latest();
        }
    }

    fn send_latest(&self) {
        let payload = {
            let mut st = self.state();
            let Some(p) = st.latest.clone() else {
                return;
            };
            st.last_sent_hash = p.hash.to_string();
            // Once per distinct inventory, not on every reconnect's resend.
            let fresh = st.last_logged_hash != p.hash.as_str();
            if fresh {
                st.last_logged_hash = p.hash.to_string();
            }
            (p, fresh)
        };
        let (payload, fresh) = payload;
        let summary = fresh.then(|| inventory_summary(&payload));
        (self.inner.send)(payload);
        if let Some(line) = summary {
            (self.inner.log)(&line);
        }
    }

    /// The running scan, or a new one (spawned, so it completes even if nobody awaits it).
    fn scan_once(&self) -> Scanning {
        let mut st = self.state();
        if let Some(s) = st.scanning.clone() {
            st.again = true;
            return s;
        }
        let me = self.clone();
        let run: Scanning = async move {
            loop {
                me.state().again = false;
                let result = (me.inner.scan)().await;
                let mut st = me.state();
                match result {
                    Ok(scan) => st.latest = Some(inventory_payload(&scan)),
                    Err(e) => (me.inner.log)(&format!("inventory scan failed: {e}")),
                }
                // Checked and cleared under one lock: a rescan asked for now is never lost.
                if !st.again {
                    st.scanning = None;
                    break;
                }
            }
        }
        .boxed()
        .shared();
        st.scanning = Some(run.clone());
        drop(st);
        tokio::spawn(run.clone());
        run
    }
}

/// `<root>/state/rescan`: its appearance asks the running daemon to rescan (MW-T09; the portable
/// twin of SIGHUP, which Windows doesn't have).
pub fn rescan_trigger_path(root: &Path) -> PathBuf {
    root.join("state").join("rescan")
}

/// Ask the running daemon to rescan (the `rescan` subcommand, MR-T13).
pub fn request_rescan(root: &Path) -> std::io::Result<()> {
    let path = rescan_trigger_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, b"")
}

/// The trigger file's poll period (MW-T09: at most 5 s).
pub const RESCAN_POLL: Duration = Duration::from_secs(2);

/// Poll for the trigger file every `poll`; when it is there, remove it and rescan. Abort the
/// returned handle to stop.
pub fn watch_rescan_trigger(
    root: &Path,
    reporter: InventoryReporter,
    poll: Duration,
) -> AbortHandle {
    let path = rescan_trigger_path(root);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(poll).await;
            if std::fs::symlink_metadata(&path).is_ok() {
                let _ = std::fs::remove_file(&path);
                reporter.rescan().await;
            }
        }
    })
    .abort_handle()
}

#[cfg(test)]
mod tests;
