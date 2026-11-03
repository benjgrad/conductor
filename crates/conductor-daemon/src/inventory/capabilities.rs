//! Port of `packages/daemon/src/inventory/capabilities.ts` (MR-T11): the capability half of the
//! inventory (M2-T10; ADR-0013 §Inventory, ADR-0016).
//!
//! Names and versions only: a CLI's `authed` is the exit code of a read-only probe (its output is
//! dropped, so no account name is ever reported); MCP servers are reported by name, never their
//! command, args, env or URL; skills and agents by file name, never their contents.
//!
//! No OS `cfg` here (tests/seam.rs).

use crate::exec::{self, Env};
use crate::inventory::repos::{Log, js_str_cmp, no_log};
use crate::inventory::version::cli_version_from;
use crate::platform::{self, CliOptions, Platform};
use crate::workspace::is_absolute_path;
use conductor_protocol::capabilities::capability_key;
use conductor_protocol::repo::is_canonical_remote;
use conductor_protocol::{Capability, CapabilityName, InventoryRepo};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Each CLI probe is killed after this long (ADR-0013: a hung `az` must not stall the scan).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Names read per skills / agents directory, at most.
const MAX_NAMES: usize = 500;
/// After a probe's timeout, how long to wait for its pipes to close before settling anyway.
const PROBE_SETTLE: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct ScanCapabilitiesOptions {
    /// Claude Code's config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`): skills, agents, plugins.
    pub claude_config_dir: PathBuf,
    /// Claude Code's user config, holding user-scope `mcpServers` (`~/.claude.json`).
    pub claude_user_config: PathBuf,
    /// The `claude` binary (CONDUCTOR_CLAUDE_BIN, else `claude`).
    pub claude_bin: String,
    /// The scanned repos: each one with a remote contributes its `.claude/skills|agents`.
    pub repos: Vec<InventoryRepo>,
    /// Probe environment (default: this process's); PATH decides which CLIs are found.
    pub env: Option<Env>,
    pub probe_timeout: Duration,
    /// Where a capability that isn't reported is logged (once per scan).
    pub log: Log,
}

impl ScanCapabilitiesOptions {
    pub fn new(claude_config_dir: PathBuf, claude_user_config: PathBuf) -> Self {
        ScanCapabilitiesOptions {
            claude_config_dir,
            claude_user_config,
            claude_bin: "claude".into(),
            repos: Vec::new(),
            env: None,
            probe_timeout: PROBE_TIMEOUT,
            log: no_log(),
        }
    }
}

/// One probe's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    /// Exit code; None when killed (timeout) or not spawned.
    pub code: Option<i32>,
    pub stdout: String,
    /// The binary isn't on PATH.
    pub missing: bool,
}

/// Run one CLI with no shell (Windows: PATHEXT, so `az.cmd` is found), stdin closed, its tree
/// killed at the timeout. Never fails.
pub async fn probe(
    cmd: &str,
    args: &[String],
    env: &[(String, String)],
    timeout: Duration,
) -> Probe {
    let mut probe_env = exec::clean_env(env);
    exec::set_env(
        &mut probe_env,
        "NO_COLOR",
        "1",
        Platform::current().is_windows(),
    );
    let opts = CliOptions {
        env: Some(probe_env),
        timeout: Some(timeout),
        ..Default::default()
    };
    // TD-189: a survivor holding the pipes (a Windows Git Bash job escapes the tree kill) would
    // keep the output from ever closing: settle anyway, shortly after the kill, as TS does.
    match tokio::time::timeout(
        timeout + PROBE_SETTLE,
        platform::exec_file_cli(cmd, args, opts),
    )
    .await
    {
        Err(_) => Probe {
            code: None,
            stdout: String::new(),
            missing: false,
        },
        Ok(Err(e)) => Probe {
            code: None,
            stdout: String::new(),
            missing: e.code() == "ENOENT",
        },
        Ok(Ok(out)) => Probe {
            code: if out.timed_out {
                None
            } else {
                out.output.status.code()
            },
            stdout: String::from_utf8_lossy(&out.output.stdout).into_owned(),
            missing: false,
        },
    }
}

/// `(name, version args, auth probe args)`.
type CliProbe = (
    &'static str,
    &'static [&'static str],
    Option<&'static [&'static str]>,
);

/// The CLIs ADR-0016's connectors need.
const CLIS: &[CliProbe] = &[
    ("gh", &["--version"], Some(&["auth", "status"])),
    (
        "az",
        &["--version"],
        Some(&["account", "show", "--output", "none"]),
    ),
    // TD-151: jira-cli has no agreed read-only auth probe yet (`jira me` prints the user), so
    // `authed` is always false for jira (payoff M5).
    ("jira", &["version"], None),
    ("git", &["--version"], None),
];

async fn scan_clis(env: &[(String, String)], timeout: Duration) -> Vec<Capability> {
    let results = futures_util::future::join_all(CLIS.iter().map(
        |(name, version_args, auth_args)| async move {
            let version_argv = exec::sv(version_args);
            let ver = probe(name, &version_argv, env, timeout);
            let auth = async {
                match auth_args {
                    Some(a) => Some(probe(name, &exec::sv(a), env, timeout).await),
                    None => None,
                }
            };
            let (ver, auth) = tokio::join!(ver, auth);
            if ver.missing {
                return None;
            }
            Some(Capability::Cli {
                name: CapabilityName::try_from(*name).expect("a valid CLI name"),
                version: if ver.code == Some(0) {
                    cli_version_from(&ver.stdout)
                } else {
                    None
                },
                authed: auth.is_some_and(|a| a.code == Some(0)),
            })
        },
    ))
    .await;
    results.into_iter().flatten().collect()
}

async fn scan_claude(
    bin: &str,
    env: &[(String, String)],
    timeout: Duration,
    log: &Log,
) -> Vec<Capability> {
    // U-110: a claude.cmd shim can't run conductor's sessions, so it is not a claude capability.
    if let Some(problem) = platform::native_exe_problem(bin, env, None) {
        log(&problem);
        return vec![];
    }
    let r = probe(bin, &exec::sv(&["--version"]), env, timeout).await;
    let version = if r.code == Some(0) {
        cli_version_from(&r.stdout)
    } else {
        None
    };
    match version {
        Some(version) => vec![Capability::Claude { version }],
        None => vec![],
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// The keys of `obj[field]` when it's an object: names, never values.
fn keys_of(obj: Option<&Value>, field: &str) -> Vec<String> {
    match obj.and_then(|o| o.as_object()).and_then(|o| o.get(field)) {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        _ => vec![],
    }
}

/// `path.relative(base, file)` starts with `..` or is absolute: `file` is outside `base`.
fn is_outside(base: &str, file: &str) -> bool {
    let (base, file) = (Path::new(base), Path::new(file));
    match file.strip_prefix(base) {
        Ok(rel) => rel.to_string_lossy().starts_with(".."),
        Err(_) => true,
    }
}

/// A plugin's MCP server names: its `.mcp.json`, and `plugin.json` `mcpServers` (object or path).
fn plugin_mcp_names(install_path: &str) -> Vec<String> {
    let base = Path::new(install_path);
    let mut names = keys_of(read_json(&base.join(".mcp.json")).as_ref(), "mcpServers");
    let manifest = read_json(&base.join(".claude-plugin").join("plugin.json"));
    match manifest
        .as_ref()
        .and_then(|m| m.as_object())
        .and_then(|m| m.get("mcpServers"))
    {
        Some(Value::Object(m)) => names.extend(m.keys().cloned()),
        Some(Value::String(rel)) => {
            // A path relative to the plugin, never outside it.
            let file = platform::fs::resolve_for(Platform::current(), install_path, rel);
            if !is_outside(install_path, &file) {
                names.extend(keys_of(read_json(Path::new(&file)).as_ref(), "mcpServers"));
            }
        }
        _ => {}
    }
    names
}

/// MCP server names: user scope (`mcpServers` in Claude Code's user config) and every enabled
/// plugin (`settings.json` `enabledPlugins`, located through `plugins/installed_plugins.json`).
/// Best effort: a missing or malformed file contributes nothing.
pub fn mcp_names(claude_config_dir: &Path, claude_user_config: &Path) -> Vec<String> {
    let mut names = keys_of(read_json(claude_user_config).as_ref(), "mcpServers");
    let settings = read_json(&claude_config_dir.join("settings.json"));
    let enabled: Vec<String> = match settings
        .as_ref()
        .and_then(|s| s.as_object())
        .and_then(|s| s.get("enabledPlugins"))
    {
        Some(Value::Object(m)) => m
            .iter()
            .filter(|(_, on)| **on == Value::Bool(true))
            .map(|(k, _)| k.clone())
            .collect(),
        _ => vec![],
    };
    if enabled.is_empty() {
        return names;
    }
    let installed = read_json(
        &claude_config_dir
            .join("plugins")
            .join("installed_plugins.json"),
    );
    // v2: `{version: 2, plugins: {"name@mkt": [{installPath}]}}`; v1: `{plugins: {"name@mkt": {installPath}}}`.
    let empty = serde_json::Map::new();
    let plugins = match installed
        .as_ref()
        .and_then(|i| i.as_object())
        .and_then(|i| i.get("plugins"))
    {
        Some(Value::Object(m)) => m,
        _ => &empty,
    };
    for id in &enabled {
        let entries: Vec<&Value> = match plugins.get(id) {
            Some(Value::Array(a)) => a.iter().collect(),
            Some(v) => vec![v],
            None => vec![],
        };
        for inst in entries {
            if let Some(Value::String(p)) = inst.as_object().and_then(|o| o.get("installPath"))
                && is_absolute_path(p)
            {
                names.extend(plugin_mcp_names(p));
            }
        }
    }
    names
}

/// `<dir>/skills/<name>` (a directory, or a symlink to one) and `<dir>/agents/<name>.md` names.
pub fn skill_and_agent_names(dir: &Path) -> (Vec<String>, Vec<String>) {
    let list = |sub: &str| -> Vec<(String, std::fs::FileType)> {
        let Ok(rd) = std::fs::read_dir(dir.join(sub)) else {
            return vec![];
        };
        rd.flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let ft = e.file_type().ok()?;
                Some((name, ft))
            })
            .filter(|(name, _)| !name.starts_with('.'))
            .take(MAX_NAMES)
            .collect()
    };
    let skills = list("skills")
        .into_iter()
        .filter(|(_, ft)| ft.is_dir() || ft.is_symlink())
        .map(|(n, _)| n)
        .collect();
    let agents = list("agents")
        .into_iter()
        .filter(|(n, ft)| (ft.is_file() || ft.is_symlink()) && n.ends_with(".md"))
        .map(|(n, _)| n[..n.len() - ".md".len()].to_string())
        .filter(|n| !n.is_empty())
        .collect();
    (skills, agents)
}

/// Claude Code names a plugin's MCP server `plugin:<plugin>:<server>`; the capability is
/// `<server>` (the TS `/^plugin:[^:]+:(.+)$/`).
pub fn normalize_mcp_name(name: &str) -> String {
    let normalized = (|| {
        let rest = name.strip_prefix("plugin:")?;
        let colon = rest.find(':')?;
        if colon == 0 {
            return None;
        }
        let server = &rest[colon + 1..];
        // `.` matches no line terminator, and `$` is the end of input.
        let terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        if server.is_empty() || server.contains(terminator) {
            return None;
        }
        Some(server.to_string())
    })();
    normalized.unwrap_or_else(|| name.to_string())
}

/// A name for the log: quoted and escaped (JSON), and cut at 200 UTF-16 units.
fn log_name(name: &str) -> String {
    let cut = if name.encode_utf16().count() > 200 {
        let mut units = 0;
        let s: String = name
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= 200
            })
            .collect();
        format!("{s}\u{2026}")
    } else {
        name.to_string()
    };
    serde_json::to_string(&cut).unwrap_or_default()
}

/// A candidate before the schema check.
enum Raw {
    Ready(Capability),
    Named {
        kind: &'static str,
        name: String,
        repo: Option<String>,
        /// The name as configured, when it was normalised (for the log).
        configured: Option<String>,
    },
}

fn check(kind: &'static str, name: &str, repo: Option<&str>) -> Result<Capability, String> {
    let n = CapabilityName::try_from(name).map_err(|e| format!("name: {e}"))?;
    if let Some(r) = repo
        && !is_canonical_remote(r)
    {
        return Err("repo: expected host/org/repo".into());
    }
    let repo = repo.map(str::to_string);
    Ok(match kind {
        "mcp" => Capability::Mcp { name: n },
        "skill" => Capability::Skill { name: n, repo },
        _ => Capability::Agent { name: n, repo },
    })
}

/// Every capability of this machine, schema-checked, de-duplicated and sorted.
pub async fn scan_capabilities(opts: &ScanCapabilitiesOptions) -> Vec<Capability> {
    let env = opts
        .env
        .clone()
        .unwrap_or_else(platform::spawn::process_env);
    let (clis, claude) = tokio::join!(
        scan_clis(&env, opts.probe_timeout),
        scan_claude(&opts.claude_bin, &env, opts.probe_timeout, &opts.log),
    );
    let mut raw: Vec<Raw> = clis.into_iter().chain(claude).map(Raw::Ready).collect();
    for configured in mcp_names(&opts.claude_config_dir, &opts.claude_user_config) {
        let name = normalize_mcp_name(&configured);
        let configured = (name != configured).then_some(configured);
        raw.push(Raw::Named {
            kind: "mcp",
            name,
            repo: None,
            configured,
        });
    }
    let named = |kind: &'static str, names: Vec<String>, repo: Option<&str>| -> Vec<Raw> {
        names
            .into_iter()
            .map(|name| Raw::Named {
                kind,
                name,
                repo: repo.map(str::to_string),
                configured: None,
            })
            .collect()
    };
    let (skills, agents) = skill_and_agent_names(&opts.claude_config_dir);
    raw.extend(named("skill", skills, None));
    raw.extend(named("agent", agents, None));
    for r in &opts.repos {
        // A repo without a routable remote reports no repo-scoped skills or agents.
        let Some(remote) = r.remote.as_deref() else {
            continue;
        };
        let (skills, agents) = skill_and_agent_names(&Path::new(r.path.as_str()).join(".claude"));
        raw.extend(named("skill", skills, Some(remote)));
        raw.extend(named("agent", agents, Some(remote)));
    }

    let mut by_key: HashMap<String, Capability> = HashMap::new();
    let mut logged: HashSet<String> = HashSet::new();
    for c in raw {
        let cap = match c {
            Raw::Ready(cap) => cap,
            Raw::Named {
                kind,
                name,
                repo,
                configured,
            } => match check(kind, &name, repo.as_deref()) {
                Ok(cap) => cap,
                Err(why) => {
                    // Not reported, logged once per scan; the rest of the inventory still goes out.
                    let tag = format!(
                        "{kind} {}",
                        log_name(configured.as_deref().unwrap_or(&name))
                    );
                    if logged.insert(tag.clone()) {
                        (opts.log)(&format!("inventory: capability {tag} not reported: {why}"));
                    }
                    continue;
                }
            },
        };
        // `cli:gh` and `cli:gh:authed` are one CLI: key on the name.
        let k = match &cap {
            Capability::Cli { name, .. } => format!("cli:{}", name.as_str()),
            other => capability_key(other),
        };
        by_key.entry(k).or_insert(cap);
    }
    let mut out: Vec<(String, Capability)> = by_key.into_iter().collect();
    out.sort_by(|(a, _), (b, _)| js_str_cmp(a, b));
    out.into_iter().map(|(_, c)| c).collect()
}

#[cfg(test)]
mod tests;
