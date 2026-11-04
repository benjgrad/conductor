//! Port of `packages/daemon/src/config.ts` (MR-T05): daemon configuration (M1-T05; 07 §Compute,
//! §Ports). Everything comes from env vars with defaults that work for a single laptop talking to
//! an orchestrator on localhost, plus `<root>/config.json` (M2-T10) and `<root>/machine.json`
//! (M2-T04, `credential`).
//!
//! The env is always passed in ([`Env`]), never read inside, so every rule is a pure test.

use crate::credential::{
    self, CredentialError, MachineCredential, credential_path, daemon_ws_url, is_secure_or_loopback,
};
use crate::platform::{self, Platform, PrivateError, machine};
use conductor_protocol::{
    CONDUCTOR_PORT_ENV, DEFAULT_CONDUCTOR_PORT, WorkingCopyMode, api_paths,
    repo::is_canonical_remote,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};

/// The environment (`process.env`).
pub type Env = HashMap<String, String>;

/// This process's environment.
pub fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Credential(#[from] CredentialError),
    #[error(transparent)]
    Private(#[from] PrivateError),
}

impl From<io::Error> for ConfigError {
    fn from(e: io::Error) -> Self {
        ConfigError::Private(e.into())
    }
}

fn invalid(msg: impl Into<String>) -> ConfigError {
    ConfigError::Invalid(msg.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortPoolConfig {
    /// First port of the pool (inclusive).
    pub start: u32,
    /// Last port of the pool (inclusive).
    pub end: u32,
    /// Ports per session range (07: default 10).
    pub range_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackoffConfig {
    pub initial_ms: u64,
    pub max_ms: u64,
    pub factor: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DaemonConfig {
    /// Full WS URL: CONDUCTOR_ORCHESTRATOR_URL, else the enrolled `url` (https → wss) + daemonWs,
    /// else `ws://<host>:<CONDUCTOR_PORT>` + `API_PATHS.daemonWs`.
    pub orchestrator_url: String,
    /// Root dir: shared clones (`repos/`), worktrees (`wt/`), daemon state (`state/`),
    /// `machine.json`.
    pub root_dir: PathBuf,
    /// The enrolled `machine_id`, else (local mode) CONDUCTOR_MACHINE_ID or the hostname.
    pub machine_id: String,
    /// The machine credential sent on the WS upgrade (M2-T04); None in local mode. Never logged.
    pub credential: Option<String>,
    /// `register.daemon_version`: the crate version, `+<CONDUCTOR_BUILD_SHA>` when set.
    pub daemon_version: String,
    pub tags: Vec<String>,
    /// Advertised CPU budget (cores) after the owner reserve (07).
    pub budget_cpu: u64,
    /// Advertised memory budget (MB) after the owner reserve (07).
    pub budget_mem_mb: u64,
    pub max_sessions: u64,
    pub max_concurrent_builds: u64,
    /// ADR-0033 P2: one-shot `assistant_job` slots, outside `max_sessions` (CONDUCTOR_LIGHT_SLOTS,
    /// default 1). Env only, so `config.json` and `machine.json` are unchanged.
    pub light_slots: u64,
    pub port_pool: PortPoolConfig,
    /// Refuse start_session / run_cmd with `memory_pressure` below this much free memory.
    pub min_free_mem_mb: u64,
    /// Delay before the next request_work after `no_work`.
    pub work_poll_ms: u64,
    /// A `work_assignment` holds a slot until its start_session arrives, at most this long.
    pub assignment_hold_ms: u64,
    /// Heartbeat interval until `registered` says otherwise.
    pub heartbeat_interval_ms: u64,
    pub reconnect: BackoffConfig,
    /// After `complete_state` + `turn_end` the daemon calls end(); kill() if still alive after
    /// this.
    pub end_grace_ms: u64,
    /// Grace passed to DriverSession.kill (SIGTERM → SIGKILL).
    pub kill_grace_ms: u64,
    pub git_name: String,
    pub git_email: String,
    /// Clone absolute paths / `file://` repos (M1-T14). Default false; the E2E sets it.
    pub allow_local_repos: bool,
    /// When non-empty, only these remote repo hosts are cloned (M1-T14). Default: any host.
    pub allowed_repo_hosts: Vec<String>,
    /// Claude Code's config dir, where it writes session transcripts
    /// (`projects/<cwd-slug>/<id>.jsonl`, ADR-0008). Default: `CLAUDE_CONFIG_DIR`, else
    /// `~/.claude`.
    pub claude_config_dir: PathBuf,
    /// M2-T10: CONDUCTOR_ROOTS (PATH-like), absolute; None = use `config.json`'s `roots`, which
    /// every scan re-reads.
    pub roots_override: Option<Vec<PathBuf>>,
    /// Tests only: CONDUCTOR_TEST_REMOTE_ALIASES (`<path>=<host/org/repo>,…`) gives local test
    /// repos a canonical remote in the inventory. Parsed only with allow_local_repos, else empty.
    pub test_remote_aliases: BTreeMap<PathBuf, String>,
    /// The inventory rescan interval (ADR-0013: 10 minutes).
    pub inventory_interval_ms: u64,
}

/// Defaults: 1 core / 2 GB reserved per session (07), 25 % owner reserve on the machine.
pub const OWNER_RESERVE: f64 = 0.25;
pub const SESSION_CPU: u64 = 1;
pub const SESSION_MEM_MB: u64 = 2048;

fn raw<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str).filter(|s| !s.is_empty())
}

/// JS `Number(raw)` for the shapes an env var holds: whitespace trimmed, `""` → 0, decimal with a
/// sign, fraction and exponent, `0x`/`0o`/`0b`. None for NaN.
fn js_number(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let ok = t
        .bytes()
        .all(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.' | b'e' | b'E'))
        && t.bytes().any(|c| c.is_ascii_digit());
    if !ok {
        return None;
    }
    t.parse::<f64>().ok()
}

fn int(env: &Env, name: &str, fallback: u64, min: u64) -> Result<u64, ConfigError> {
    let Some(r) = raw(env, name) else {
        return Ok(fallback);
    };
    match js_number(r) {
        Some(n) if n.fract() == 0.0 && n.is_finite() && n >= min as f64 => Ok(n as u64),
        _ => Err(invalid(format!("{name}={r} is not an integer >= {min}"))),
    }
}

fn str_or(env: &Env, name: &str, fallback: &str) -> String {
    raw(env, name).unwrap_or(fallback).to_string()
}

fn list(env: &Env, name: &str) -> Vec<String> {
    raw(env, name)
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

fn bool_or(env: &Env, name: &str, fallback: bool) -> Result<bool, ConfigError> {
    let Some(r) = raw(env, name) else {
        return Ok(fallback);
    };
    match r.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Ok(true),
        "0" | "false" | "no" => Ok(false),
        _ => Err(invalid(format!(
            "{name}={r} is not a boolean (1/0, true/false)"
        ))),
    }
}

/// `conductorPort(env)` (`@conductor/shared`): CONDUCTOR_PORT, default 7400.
pub fn conductor_port(env: &Env) -> Result<u16, ConfigError> {
    let Some(r) = env.get(CONDUCTOR_PORT_ENV).filter(|s| !s.is_empty()) else {
        return Ok(DEFAULT_CONDUCTOR_PORT);
    };
    match js_number(r) {
        Some(n) if n.fract() == 0.0 && (1.0..=65535.0).contains(&n) => Ok(n as u16),
        _ => Err(invalid(format!(
            "{CONDUCTOR_PORT_ENV}={r} is not a TCP port"
        ))),
    }
}

// ------------------------------------------------------------------------------- config.json

/// One repo's settings in `config.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoFileConfig {
    pub mode: WorkingCopyMode,
}

/// `<root>/config.json` (M2-T10, `conductor-daemon config`): the repo roots the inventory scans and
/// the per-repo working-copy mode (U-060; default `reference`). Written 0600.
///
/// `repos` is kept sorted by repo; TS kept insertion order. Both read either.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonFileConfig {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub repos: BTreeMap<String, RepoFileConfig>,
}

impl DaemonFileConfig {
    fn check(&self) -> Result<(), String> {
        if self.roots.iter().any(String::is_empty) {
            return Err("roots: a root is an empty string".into());
        }
        Ok(())
    }
}

pub fn file_config_path(root_dir: &Path) -> PathBuf {
    root_dir.join("config.json")
}

/// `<root>/config.json`, or the defaults when it doesn't exist. Errs (naming the file) if invalid.
pub fn read_file_config(root_dir: &Path) -> Result<DaemonFileConfig, ConfigError> {
    let path = file_config_path(root_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(DaemonFileConfig::default()),
        Err(e) => return Err(e.into()),
    };
    let p = path.display();
    let raw: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| invalid(format!("{p} is not valid JSON")))?;
    // The zod issue text can't be reproduced; serde's message names the field and the problem.
    let cfg: DaemonFileConfig =
        serde_json::from_value(raw).map_err(|e| invalid(format!("{p} is invalid: {e}")))?;
    cfg.check()
        .map_err(|m| invalid(format!("{p} is invalid: {m}")))?;
    Ok(cfg)
}

/// `JSON.stringify(cfg, null, 2) + "\n"`.
pub fn file_config_json(cfg: &DaemonFileConfig) -> String {
    let mut s = serde_json::to_string_pretty(cfg).expect("a config serialises");
    s.push('\n');
    s
}

/// Write `<root>/config.json` atomically, private (0600 / owner-only DACL). Returns its path.
pub fn write_file_config(root_dir: &Path, cfg: &DaemonFileConfig) -> Result<PathBuf, ConfigError> {
    cfg.check().map_err(invalid)?;
    platform::mkdir_private(root_dir)?;
    let path = file_config_path(root_dir);
    platform::write_private_file(&path, file_config_json(cfg).as_bytes())?;
    Ok(path)
}

/// CONDUCTOR_ROOTS (`:`-separated on POSIX, `;` on Windows), resolved; None when unset.
pub fn roots_from_env(env: &Env) -> Option<Vec<PathBuf>> {
    let r = env.get("CONDUCTOR_ROOTS")?;
    if r.trim().is_empty() {
        return None;
    }
    Some(
        r.split(Platform::current().path_delimiter())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(platform::resolve)
            .collect(),
    )
}

/// CONDUCTOR_TEST_REMOTE_ALIASES `<path>=<host/org/repo>,…`; errs on a bad entry.
pub fn parse_remote_aliases(raw: &str) -> Result<BTreeMap<PathBuf, String>, ConfigError> {
    let mut out = BTreeMap::new();
    for item in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (path, remote) = match item.rfind('=') {
            Some(eq) if eq > 0 => (&item[..eq], &item[eq + 1..]),
            _ => ("", ""),
        };
        if path.is_empty() || !is_canonical_remote(remote) {
            return Err(invalid(format!(
                "CONDUCTOR_TEST_REMOTE_ALIASES entry {} is not <path>=<host/org/repo>",
                serde_json::to_string(item).unwrap_or_default()
            )));
        }
        out.insert(platform::resolve(path), remote.to_string());
    }
    Ok(out)
}

// ------------------------------------------------------------------------------- loadConfig

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineFacts {
    pub cpu_total: u64,
    pub mem_total_mb: u64,
    pub hostname: String,
    pub home: PathBuf,
}

pub fn machine_facts() -> MachineFacts {
    MachineFacts {
        cpu_total: machine::cpu_count() as u64,
        mem_total_mb: machine::total_mem_bytes() / (1024 * 1024),
        hostname: machine::hostname(),
        home: machine::home_dir(),
    }
}

/// `<root>`: CONDUCTOR_ROOT, default `~/.conductor`.
pub fn root_dir_from(env: &Env, home: &Path) -> PathBuf {
    match raw(env, "CONDUCTOR_ROOT") {
        Some(r) => platform::resolve(r),
        None => platform::resolve(home.join(".conductor")),
    }
}

/// The daemon version: the crate version, plus `+<sha>` from [`pick_build_sha`].
pub fn daemon_version(env: &Env) -> String {
    let v = env!("CARGO_PKG_VERSION");
    match pick_build_sha(
        raw(env, "CONDUCTOR_BUILD_SHA"),
        option_env!("CONDUCTOR_BUILD_SHA"),
    ) {
        Some(sha) => format!("{v}+{sha}"),
        None => v.to_string(),
    }
}

/// The build sha: `CONDUCTOR_BUILD_SHA` at runtime, as the TS daemon read it, else the one baked in
/// at compile time (MR-T15: the served tarball's binary has no wrapper to set it, and its
/// `--version` must equal the version the orchestrator serves). A baked value counts only when it
/// is alphanumeric and not `unknown`, cut to 7 characters, as `package-daemon.sh` names it.
pub fn pick_build_sha<'a>(runtime: Option<&'a str>, baked: Option<&'a str>) -> Option<&'a str> {
    if let Some(sha) = runtime.filter(|s| !s.is_empty()) {
        return Some(sha);
    }
    let baked = baked?.trim();
    if baked.is_empty() || baked == "unknown" || !baked.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(&baked[..baked.len().min(7)])
}

/// [`load_config_with`] reading the real `machine.json`.
pub fn load_config(env: &Env, facts: &MachineFacts) -> Result<DaemonConfig, ConfigError> {
    load_config_with(env, facts, credential::load_credential)
}

/// Build the config from env (see `config.ts`'s `loadConfig` for every variable). When
/// `<root>/machine.json` exists (M2-T04 `enroll`), its `machine_id` replaces CONDUCTOR_MACHINE_ID,
/// its `url` is the default orchestrator URL, and its credential is sent on the WS upgrade; the
/// orchestrator URL must then be wss:// (plain ws:// only to a loopback host).
pub fn load_config_with(
    env: &Env,
    facts: &MachineFacts,
    read_credential: impl Fn(&Path) -> Result<Option<MachineCredential>, CredentialError>,
) -> Result<DaemonConfig, ConfigError> {
    let root_dir = root_dir_from(env, &facts.home);
    let cred = read_credential(&root_dir)?;
    let host = str_or(env, "CONDUCTOR_HOST", "127.0.0.1");
    let env_url = raw(env, "CONDUCTOR_ORCHESTRATOR_URL");
    // TS evaluates the fallback even when the env var wins (a bad CONDUCTOR_PORT still errs).
    let fallback = match &cred {
        Some(c) => daemon_ws_url(&c.url).map_err(invalid)?,
        None => format!(
            "ws://{host}:{}{}",
            conductor_port(env)?,
            api_paths::DAEMON_WS
        ),
    };
    let orchestrator_url = env_url.map_or(fallback, String::from);
    // An enrolled daemon never sends its credential in cleartext off this machine.
    if cred.is_some() {
        let source = match env_url {
            Some(_) => "CONDUCTOR_ORCHESTRATOR_URL".to_string(),
            None => format!("the url in {}", credential_path(&root_dir).display()),
        };
        if !Url::parse(&orchestrator_url).is_ok_and(|u| is_secure_or_loopback(&u)) {
            return Err(invalid(format!(
                "{source} ({orchestrator_url}) is not wss://: refusing to send the machine \
                 credential in cleartext (plain ws:// is allowed only to a loopback host)"
            )));
        }
    }
    let budget_cpu = int(
        env,
        "CONDUCTOR_BUDGET_CPU",
        1.max((facts.cpu_total as f64 * (1.0 - OWNER_RESERVE)).floor() as u64),
        0,
    )?;
    let budget_mem_mb = int(
        env,
        "CONDUCTOR_BUDGET_MEM_MB",
        SESSION_MEM_MB.max((facts.mem_total_mb as f64 * (1.0 - OWNER_RESERVE)).floor() as u64),
        0,
    )?;
    let max_sessions = int(
        env,
        "CONDUCTOR_MAX_SESSIONS",
        1.max((budget_cpu / SESSION_CPU).min(budget_mem_mb / SESSION_MEM_MB)),
        0,
    )?;
    let pool = str_or(env, "CONDUCTOR_PORT_POOL", "41000-48999");
    let (start, end) = parse_pool(&pool).ok_or_else(|| {
        invalid(format!(
            "CONDUCTOR_PORT_POOL={pool} is not \"<start>-<end>\""
        ))
    })?;
    let range_size = int(env, "CONDUCTOR_PORT_RANGE_SIZE", 10, 1)?;
    if start < 1 || end > 65535 || (end as i128) - (start as i128) + 1 < range_size as i128 {
        return Err(invalid(format!(
            "CONDUCTOR_PORT_POOL={pool} cannot hold one range of {range_size}"
        )));
    }
    let port_pool = PortPoolConfig {
        start: start as u32,
        end: end as u32,
        range_size: u32::try_from(range_size).unwrap_or(u32::MAX),
    };
    let allow_local_repos = bool_or(env, "CONDUCTOR_ALLOW_LOCAL_REPOS", false)?;
    let claude_config_dir = match raw(env, "CLAUDE_CONFIG_DIR") {
        Some(d) => platform::resolve(d),
        None => platform::resolve(facts.home.join(".claude")),
    };
    Ok(DaemonConfig {
        orchestrator_url,
        machine_id: match &cred {
            Some(c) => c.machine_id.clone(),
            None => str_or(env, "CONDUCTOR_MACHINE_ID", &facts.hostname),
        },
        credential: cred.map(|c| c.credential),
        daemon_version: daemon_version(env),
        tags: list(env, "CONDUCTOR_TAGS"),
        budget_cpu,
        budget_mem_mb,
        max_sessions,
        max_concurrent_builds: int(env, "CONDUCTOR_MAX_CONCURRENT_BUILDS", 2, 1)?,
        light_slots: int(env, "CONDUCTOR_LIGHT_SLOTS", 1, 1)?,
        port_pool,
        min_free_mem_mb: int(env, "CONDUCTOR_MIN_FREE_MEM_MB", 512, 0)?,
        work_poll_ms: int(env, "CONDUCTOR_WORK_POLL_MS", 5000, 1)?,
        assignment_hold_ms: 60_000,
        heartbeat_interval_ms: 10_000,
        reconnect: BackoffConfig {
            initial_ms: 500,
            max_ms: 30_000,
            factor: 2.0,
        },
        end_grace_ms: 10_000,
        kill_grace_ms: 5_000,
        git_name: str_or(env, "CONDUCTOR_GIT_NAME", "conductor"),
        git_email: str_or(env, "CONDUCTOR_GIT_EMAIL", "conductor@localhost"),
        allow_local_repos,
        allowed_repo_hosts: list(env, "CONDUCTOR_ALLOWED_REPO_HOSTS")
            .into_iter()
            .map(|h| h.to_lowercase())
            .collect(),
        claude_config_dir,
        roots_override: roots_from_env(env),
        test_remote_aliases: if allow_local_repos {
            parse_remote_aliases(&str_or(env, "CONDUCTOR_TEST_REMOTE_ALIASES", ""))?
        } else {
            BTreeMap::new()
        },
        inventory_interval_ms: 10 * 60_000,
        root_dir,
    })
}

/// `^(\d+)-(\d+)$`, as numbers (saturating: a huge number fails the range check after).
fn parse_pool(pool: &str) -> Option<(u64, u64)> {
    let (a, b) = pool.split_once('-')?;
    let num = |s: &str| {
        (!s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            .then(|| s.parse::<u64>().unwrap_or(u64::MAX))
    };
    Some((num(a)?, num(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn facts() -> MachineFacts {
        MachineFacts {
            cpu_total: 8,
            mem_total_mb: 16384,
            hostname: "box".into(),
            home: PathBuf::from("/home/me"),
        }
    }

    fn local(_: &Path) -> Result<Option<MachineCredential>, CredentialError> {
        Ok(None)
    }

    fn cred() -> MachineCredential {
        MachineCredential {
            url: "https://conductor.example.com".into(),
            machine_id: "m-1".into(),
            credential: "secret-xyz".into(),
        }
    }

    fn enrolled(
        c: MachineCredential,
    ) -> impl Fn(&Path) -> Result<Option<MachineCredential>, CredentialError> {
        move |_| Ok(Some(c.clone()))
    }

    fn load(e: &[(&str, &str)]) -> Result<DaemonConfig, ConfigError> {
        load_config_with(&env(e), &facts(), local)
    }

    // ------------------------------------------------------------------ units.test.ts loadConfig

    #[test]
    fn defaults_localhost_orchestrator_owner_reserve_and_port_pool() {
        let c = load(&[]).unwrap();
        assert_eq!(c.orchestrator_url, "ws://127.0.0.1:7400/ws/daemon");
        assert_eq!(c.root_dir, platform::resolve("/home/me/.conductor"));
        assert_eq!(c.machine_id, "box");
        assert_eq!(c.budget_cpu, 6);
        assert_eq!(c.budget_mem_mb, 12288);
        assert_eq!(c.max_sessions, 6); // min(6 cores / 1, 12288 MB / 2048)
        assert_eq!(c.max_concurrent_builds, 2);
        assert_eq!(c.light_slots, 1);
        assert_eq!(
            c.port_pool,
            PortPoolConfig {
                start: 41000,
                end: 48999,
                range_size: 10
            }
        );
    }

    #[test]
    fn reads_env_overrides_and_rejects_bad_values() {
        let c = load(&[
            ("CONDUCTOR_PORT", "7999"),
            ("CONDUCTOR_TAGS", "gpu, mac ,"),
            ("CONDUCTOR_MAX_SESSIONS", "3"),
            ("CONDUCTOR_PORT_POOL", "50000-50099"),
        ])
        .unwrap();
        assert_eq!(c.orchestrator_url, "ws://127.0.0.1:7999/ws/daemon");
        assert_eq!(c.tags, vec!["gpu", "mac"]);
        assert_eq!(c.max_sessions, 3);
        assert_eq!(c.port_pool.start, 50000);
        assert!(load(&[("CONDUCTOR_MAX_SESSIONS", "x")]).is_err());
        assert!(load(&[("CONDUCTOR_PORT_POOL", "5-6")]).is_err());
        assert!(load(&[("CONDUCTOR_MAX_CONCURRENT_BUILDS", "0")]).is_err());
        // The TS messages.
        assert_eq!(
            load(&[("CONDUCTOR_MAX_SESSIONS", "x")])
                .unwrap_err()
                .to_string(),
            "CONDUCTOR_MAX_SESSIONS=x is not an integer >= 0"
        );
        assert_eq!(
            load(&[("CONDUCTOR_PORT_POOL", "5-6")])
                .unwrap_err()
                .to_string(),
            "CONDUCTOR_PORT_POOL=5-6 cannot hold one range of 10"
        );
        assert_eq!(
            load(&[("CONDUCTOR_PORT_POOL", "a-b")])
                .unwrap_err()
                .to_string(),
            "CONDUCTOR_PORT_POOL=a-b is not \"<start>-<end>\""
        );
        assert!(load(&[("CONDUCTOR_PORT", "70000")]).is_err());
    }

    #[test]
    fn local_repos_are_off_by_default_and_repo_hosts_unrestricted_unless_listed() {
        let d = load(&[]).unwrap();
        assert!(!d.allow_local_repos);
        assert!(d.allowed_repo_hosts.is_empty());
        let c = load(&[
            ("CONDUCTOR_ALLOW_LOCAL_REPOS", "true"),
            (
                "CONDUCTOR_ALLOWED_REPO_HOSTS",
                "GitHub.com, gitlab.example.org",
            ),
        ])
        .unwrap();
        assert!(c.allow_local_repos);
        assert_eq!(
            c.allowed_repo_hosts,
            vec!["github.com", "gitlab.example.org"]
        );
        assert!(
            !load(&[("CONDUCTOR_ALLOW_LOCAL_REPOS", "0")])
                .unwrap()
                .allow_local_repos
        );
        assert!(load(&[("CONDUCTOR_ALLOW_LOCAL_REPOS", "maybe")]).is_err());
    }

    // ------------------------------------------------------- credential.test.ts loadConfig + cred

    #[test]
    fn uses_the_enrolled_machine_id_the_stored_url_and_the_credential() {
        let c = load_config_with(
            &env(&[("CONDUCTOR_MACHINE_ID", "ignored")]),
            &facts(),
            enrolled(cred()),
        )
        .unwrap();
        assert_eq!(c.machine_id, "m-1");
        assert_eq!(c.orchestrator_url, "wss://conductor.example.com/ws/daemon");
        assert_eq!(c.credential.as_deref(), Some("secret-xyz"));
    }

    #[test]
    fn refuses_a_cleartext_url_to_a_non_loopback_host_when_enrolled() {
        let off = env(&[(
            "CONDUCTOR_ORCHESTRATOR_URL",
            "ws://conductor.example.com/ws/daemon",
        )]);
        let msg = load_config_with(&off, &facts(), enrolled(cred()))
            .unwrap_err()
            .to_string();
        assert!(msg.starts_with("CONDUCTOR_ORCHESTRATOR_URL (ws://conductor.example.com/ws/daemon) is not wss://: refusing to send the machine credential in cleartext"), "{msg}");
        let plain = MachineCredential {
            url: "http://conductor.example.com".into(),
            ..cred()
        };
        let msg = load_config_with(&env(&[]), &facts(), enrolled(plain))
            .unwrap_err()
            .to_string();
        assert!(
            msg.contains("machine.json (") && msg.contains("cleartext"),
            "{msg}"
        );
        // Loopback and wss are fine; local mode (no credential) is never checked.
        let lo = env(&[("CONDUCTOR_ORCHESTRATOR_URL", "ws://localhost:1/ws/daemon")]);
        assert_eq!(
            load_config_with(&lo, &facts(), enrolled(cred()))
                .unwrap()
                .orchestrator_url,
            "ws://localhost:1/ws/daemon"
        );
        assert_eq!(
            load_config_with(&off, &facts(), local).unwrap().credential,
            None
        );
    }

    #[test]
    fn conductor_orchestrator_url_still_wins() {
        let e = env(&[("CONDUCTOR_ORCHESTRATOR_URL", "ws://127.0.0.1:1/ws/daemon")]);
        let c = load_config_with(&e, &facts(), enrolled(cred())).unwrap();
        assert_eq!(c.orchestrator_url, "ws://127.0.0.1:1/ws/daemon");
    }

    #[test]
    fn local_mode_is_unchanged() {
        let c = load(&[("CONDUCTOR_MACHINE_ID", "laptop")]).unwrap();
        assert_eq!(c.machine_id, "laptop");
        assert_eq!(c.credential, None);
        assert!(c.orchestrator_url.starts_with("ws://127.0.0.1:"));
        assert!(c.orchestrator_url.ends_with("/ws/daemon"));
    }

    #[test]
    fn daemon_version_appends_conductor_build_sha() {
        let plain = env!("CARGO_PKG_VERSION");
        assert_eq!(plain.split('.').count(), 3, "{plain}");
        assert_eq!(
            load(&[("CONDUCTOR_BUILD_SHA", "3b18e51")])
                .unwrap()
                .daemon_version,
            format!("{plain}+3b18e51")
        );
    }

    #[test]
    fn build_sha_runtime_wins_else_the_baked_one() {
        assert_eq!(
            pick_build_sha(Some("abc1234"), Some("fff0000")),
            Some("abc1234")
        );
        assert_eq!(pick_build_sha(None, Some("fff0000")), Some("fff0000"));
        assert_eq!(pick_build_sha(Some(""), Some("fff0000")), Some("fff0000"));
        assert_eq!(
            pick_build_sha(None, Some("0123456789abcdef")),
            Some("0123456")
        );
        assert_eq!(pick_build_sha(None, Some("unknown")), None);
        assert_eq!(pick_build_sha(None, Some("")), None);
        assert_eq!(pick_build_sha(None, Some("ab$cd")), None);
        assert_eq!(pick_build_sha(None, None), None);
    }

    // ------------------------------------------------------------------------- extra cases

    #[test]
    fn js_number_shapes() {
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number("0x1f"), Some(31.0));
        assert_eq!(js_number("1.5"), Some(1.5));
        assert_eq!(js_number("x"), None);
        assert_eq!(js_number("1-2"), None);
        assert!(load(&[("CONDUCTOR_MAX_SESSIONS", "1.5")]).is_err());
        assert_eq!(
            load(&[("CONDUCTOR_MAX_SESSIONS", "1e1")])
                .unwrap()
                .max_sessions,
            10
        );
    }

    #[test]
    fn roots_and_remote_aliases() {
        assert_eq!(roots_from_env(&env(&[])), None);
        assert_eq!(roots_from_env(&env(&[("CONDUCTOR_ROOTS", "  ")])), None);
        let sep = Platform::current().path_delimiter();
        let roots = roots_from_env(&env(&[(
            "CONDUCTOR_ROOTS",
            &format!("/a{sep} /b/../c {sep}"),
        )]))
        .unwrap();
        assert_eq!(
            roots,
            vec![platform::resolve("/a"), platform::resolve("/c")]
        );
        let a = parse_remote_aliases("/srv/x=github.com/org/x, /srv/y=github.com/org/y").unwrap();
        assert_eq!(
            a.get(&platform::resolve("/srv/x")).map(String::as_str),
            Some("github.com/org/x")
        );
        let msg = parse_remote_aliases("=github.com/a/b")
            .unwrap_err()
            .to_string();
        assert_eq!(
            msg,
            "CONDUCTOR_TEST_REMOTE_ALIASES entry \"=github.com/a/b\" is not <path>=<host/org/repo>"
        );
        assert!(parse_remote_aliases("/x=notaremote").is_err());
        // Only with local repos allowed.
        let off = load(&[("CONDUCTOR_TEST_REMOTE_ALIASES", "bad")]).unwrap();
        assert!(off.test_remote_aliases.is_empty());
        assert!(
            load(&[
                ("CONDUCTOR_ALLOW_LOCAL_REPOS", "1"),
                ("CONDUCTOR_TEST_REMOTE_ALIASES", "bad")
            ])
            .is_err()
        );
    }

    #[test]
    fn file_config_round_trip_defaults_and_errors() {
        let t = tempfile::tempdir().unwrap();
        // %TEMP% is not owner-only on Windows: make the temp dir private before creating in it.
        platform::mkdir_private(t.path()).unwrap();
        let root = t.path().join("root");
        assert_eq!(
            read_file_config(&root).unwrap(),
            DaemonFileConfig::default()
        );
        let mut cfg = DaemonFileConfig {
            roots: vec!["/src".into()],
            ..Default::default()
        };
        cfg.repos.insert(
            "github.com/org/app".into(),
            RepoFileConfig {
                mode: WorkingCopyMode::Checkout,
            },
        );
        let path = write_file_config(&root, &cfg).unwrap();
        assert_eq!(read_file_config(&root).unwrap(), cfg);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"roots\": [\n    \"/src\"\n  ],\n  \"repos\": {\n    \"github.com/org/app\": {\n      \"mode\": \"checkout\"\n    }\n  }\n}\n"
        );
        std::fs::write(&path, "{nope").unwrap();
        let msg = read_file_config(&root).unwrap_err().to_string();
        assert_eq!(msg, format!("{} is not valid JSON", path.display()));
        std::fs::write(&path, r#"{"repos":{"x":{"mode":"bogus"}}}"#).unwrap();
        let msg = read_file_config(&root).unwrap_err().to_string();
        assert!(
            msg.starts_with(&format!("{} is invalid: ", path.display())),
            "{msg}"
        );
        std::fs::write(&path, r#"{"roots":[""]}"#).unwrap();
        assert!(read_file_config(&root).is_err());
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(
            read_file_config(&root).unwrap(),
            DaemonFileConfig::default()
        );
    }

    #[test]
    fn machine_facts_are_real() {
        let f = machine_facts();
        assert!(f.cpu_total >= 1 && f.mem_total_mb > 0 && !f.hostname.is_empty());
    }
}
