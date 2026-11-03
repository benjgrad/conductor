//! Port of `inventory/capabilities.test.ts` (M2-T10 acceptance): capability probes against fake
//! binaries on PATH, MCP / skill / agent names from fixture Claude Code config. Names and versions
//! only: no account name, command or env. The probes spawn real (fake) processes because the
//! spawn, PATH lookup, timeout and tree kill are what is under test.

use super::*;
use crate::actions::open_pr::tests::{ps, try_symlink};
use crate::claude::transcript::realpath;
use crate::test_support::fake_bin::path_with;
use conductor_protocol::WorkingCopyMode;
use conductor_protocol::capabilities::capability_keys;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn on_windows() -> bool {
    Platform::current().is_windows()
}

struct Fx {
    _t: tempfile::TempDir,
    tmp: PathBuf,
    bin: PathBuf,
    sys: PathBuf,
    claude_dir: PathBuf,
}

fn which(name: &str) -> String {
    let out = std::process::Command::new(if on_windows() { "where" } else { "which" })
        .arg(name)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

impl Fx {
    fn new() -> Fx {
        let t = tempfile::tempdir().unwrap();
        let tmp = realpath(t.path()).unwrap();
        // TD-193: a space and parentheses, like `C:\Program Files (x86)\…\wbin\az.cmd`.
        let bin = tmp.join("Program Files (x86)").join("wbin");
        let claude_dir = tmp.join("claude-config");
        let sys = tmp.join("sys");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir(&sys).unwrap();
        std::fs::create_dir(&claude_dir).unwrap();
        if !on_windows() {
            // PATH = the fake bin dir + links to the real sh, sleep and git only. Never /usr/bin:
            // a CI runner has real gh / az there, which would answer the probes.
            for name in ["sh", "sleep", "git"] {
                platform::fs::symlink(Path::new(&which(name)), &sys.join(name)).unwrap();
            }
        }
        Fx {
            _t: t,
            tmp,
            bin,
            sys,
            claude_dir,
        }
    }

    /// A fake CLI on PATH running `body` in sh. POSIX: a `#!/bin/sh` script. Windows: `name.sh`
    /// plus a `name.cmd` shim running it in Git Bash (as `az.cmd` is a shim), so the probe goes
    /// through spawn's PATHEXT lookup and cmd.exe escaping.
    fn fake(&self, name: &str, body: &str) {
        if on_windows() {
            let shell = platform::workflow_shell(Platform::current()).unwrap().file;
            std::fs::write(self.bin.join(format!("{name}.sh")), format!("{body}\n")).unwrap();
            std::fs::write(
                self.bin.join(format!("{name}.cmd")),
                format!("@\"{}\" \"%~dp0{name}.sh\" %*\r\n", ps(&shell)),
            )
            .unwrap();
            return;
        }
        let f = self.bin.join(name);
        std::fs::write(&f, format!("#!/bin/sh\n{body}\n")).unwrap();
        platform::fs::set_executable(&f).unwrap();
    }

    fn env(&self) -> Env {
        let get = |k: &str| std::env::var(k).unwrap_or_default();
        if on_windows() {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            let sys32 = ps(&Path::new(&root).join("System32"));
            vec![
                ("PATH".into(), path_with(&[&ps(&self.bin), &sys32])),
                ("PATHEXT".into(), get("PATHEXT")),
                ("SystemRoot".into(), root),
                ("HOME".into(), ps(&self.tmp)),
            ]
        } else {
            vec![
                ("PATH".into(), path_with(&[&ps(&self.bin), &ps(&self.sys)])),
                ("HOME".into(), ps(&self.tmp)),
            ]
        }
    }

    fn opts(&self) -> ScanCapabilitiesOptions {
        let mut o =
            ScanCapabilitiesOptions::new(self.claude_dir.clone(), self.tmp.join(".claude.json"));
        o.env = Some(self.env());
        o
    }

    fn write(&self, p: &Path, v: &Value) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    /// An enabled plugin `<name>@mkt` whose `.mcp.json` declares `servers`.
    fn plugin(&self, name: &str, servers: &[&str]) {
        let dir = self
            .claude_dir
            .join("plugins")
            .join("cache")
            .join("mkt")
            .join(name)
            .join("1.0.0");
        let m: serde_json::Map<String, Value> =
            servers.iter().map(|s| (s.to_string(), json!({}))).collect();
        self.write(&dir.join(".mcp.json"), &json!({ "mcpServers": m }));
        self.write(
            &self.claude_dir.join("settings.json"),
            &json!({ "enabledPlugins": { format!("{name}@mkt"): true } }),
        );
        self.write(
            &self.claude_dir.join("plugins").join("installed_plugins.json"),
            &json!({ "version": 2, "plugins": { format!("{name}@mkt"): [{ "installPath": ps(&dir) }] } }),
        );
    }
}

fn logger() -> (Log, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    (
        Arc::new(move |m: &str| sink.lock().unwrap().push(m.to_string())),
        lines,
    )
}

fn cli(name: &str, version: Option<&str>, authed: bool) -> Capability {
    Capability::Cli {
        name: name.try_into().unwrap(),
        version: version.map(str::to_string),
        authed,
    }
}

fn named(kind: &str, name: &str, repo: Option<&str>) -> Capability {
    let name = name.try_into().unwrap();
    let repo = repo.map(str::to_string);
    match kind {
        "mcp" => Capability::Mcp { name },
        "skill" => Capability::Skill { name, repo },
        _ => Capability::Agent { name, repo },
    }
}

fn mcp_sorted(caps: &[Capability]) -> Vec<String> {
    let mut v: Vec<String> = caps
        .iter()
        .filter_map(|c| match c {
            Capability::Mcp { name } => Some(name.to_string()),
            _ => None,
        })
        .collect();
    v.sort();
    v
}

// ---------------------------------------------------------------- cli probes

#[tokio::test]
async fn gh_az_authed_and_no_account_name_in_the_output() {
    let fx = Fx::new();
    fx.fake(
        "gh",
        &[
            r#"if [ "$1" = --version ]; then echo "gh version 2.50.0 (2024-05-29)"; exit 0; fi"#,
            r#"if [ "$1" = auth ]; then echo "github.com"; echo "  ✓ Logged in to github.com account octo-secret-user (keyring)" >&2; echo "token: gho_SECRET"; exit 0; fi"#,
            "exit 2",
        ]
        .join("\n"),
    );
    fx.fake(
        "az",
        &[
            r#"if [ "$1" = --version ]; then echo "azure-cli                         2.60.0 *"; exit 0; fi"#,
            r#"if [ "$1" = account ]; then echo '{"user": {"name": "az-secret@corp.example"}}'; exit 0; fi"#,
            "exit 2",
        ]
        .join("\n"),
    );
    fx.fake("claude", r#"echo "2.1.308 (Claude Code)""#);
    let (log, lines) = logger();
    let mut o = fx.opts();
    o.log = log;
    let caps = scan_capabilities(&o).await;
    assert!(caps.contains(&cli("gh", Some("2.50.0"), true)), "{caps:?}");
    assert!(caps.contains(&cli("az", Some("2.60.0"), true)), "{caps:?}");
    if on_windows() {
        // U-110: a claude.cmd shim is not a usable claude on Windows.
        assert!(!caps.iter().any(|c| matches!(c, Capability::Claude { .. })));
        assert!(
            lines
                .lock()
                .unwrap()
                .join("\n")
                .contains("not a native .exe")
        );
    } else {
        assert!(caps.contains(&Capability::Claude {
            version: "2.1.308".into()
        }));
    }
    let text = serde_json::to_string(&caps).unwrap();
    for secret in [
        "octo-secret-user",
        "gho_SECRET",
        "az-secret",
        "corp.example",
    ] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
}

#[tokio::test]
async fn a_failed_auth_probe_is_not_authed_and_a_missing_cli_is_omitted() {
    let fx = Fx::new();
    fx.fake(
        "gh",
        "if [ \"$1\" = --version ]; then echo \"gh version 2.40.0\"; exit 0; fi\nexit 1",
    );
    let caps = scan_capabilities(&fx.opts()).await;
    assert!(caps.contains(&cli("gh", Some("2.40.0"), false)), "{caps:?}");
    let has_cli = |n: &str| {
        caps.iter()
            .any(|c| matches!(c, Capability::Cli { name, .. } if name.as_str() == n))
    };
    assert!(!has_cli("jira"));
    assert!(!has_cli("az"));
    assert!(!caps.iter().any(|c| matches!(c, Capability::Claude { .. })));
}

#[tokio::test]
async fn jira_and_git_report_their_versions_never_authed() {
    let fx = Fx::new();
    fx.fake(
        "jira",
        r#"echo '(Version="1.5.1", GitCommit="abc", GoVersion="go1.22")'"#,
    );
    let git = which("git").replace('\\', "/");
    fx.fake("git", &format!("exec \"{git}\" \"$@\""));
    let caps = scan_capabilities(&fx.opts()).await;
    assert!(
        caps.contains(&cli("jira", Some("1.5.1"), false)),
        "{caps:?}"
    );
    let g = caps
        .iter()
        .find_map(|c| match c {
            Capability::Cli {
                name,
                version,
                authed,
            } if name.as_str() == "git" => Some((version.clone(), *authed)),
            _ => None,
        })
        .expect("git reported");
    assert!(!g.1);
    let v = g.0.expect("a git version");
    assert!(cli_version_from(&v).as_deref() == Some(v.as_str()), "{v}");
}

#[tokio::test]
async fn a_hanging_probe_is_killed_at_the_timeout() {
    let fx = Fx::new();
    let pid_file = fx.tmp.join("az.pid");
    let p = ps(&pid_file).replace('\\', "/");
    // The sleeper's own pid: Windows reads its Windows pid from MSYS /proc (bash's $! is not one).
    fx.fake(
        "az",
        &if on_windows() {
            format!("sleep 30 & cat /proc/$!/winpid >> \"{p}\"; wait")
        } else {
            format!("echo $$ >> '{p}'\nexec sleep 30")
        },
    );
    let mut o = fx.opts();
    // TS waits the real 5 s; the bound is the same code path, so 1 s keeps the suite fast.
    o.probe_timeout = Duration::from_secs(1);
    let t0 = Instant::now();
    let caps = scan_capabilities(&o).await;
    let elapsed = t0.elapsed();
    assert!(elapsed >= Duration::from_millis(900), "{elapsed:?}");
    assert!(elapsed < Duration::from_millis(4_500), "{elapsed:?}");
    assert!(caps.contains(&cli("az", None, false)), "{caps:?}");
    // Both az probes (version + account show) ran and were killed: no sleeper is left.
    let text = std::fs::read_to_string(&pid_file).unwrap();
    let pids: Vec<&str> = text.split_whitespace().collect();
    assert_eq!(pids.len(), 2, "{text}");
    // TD-189: on Windows a Git Bash background job escapes the tree kill; the probe still settles.
    if !on_windows() {
        for pid in pids {
            let alive = std::process::Command::new("kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(!alive, "pid {pid} survived");
        }
    }
}

// ---------------------------------------------------------------- names from Claude Code config

#[tokio::test]
async fn mcp_names_from_user_scope_and_enabled_plugins_never_their_config() {
    let fx = Fx::new();
    fx.write(
        &fx.tmp.join(".claude.json"),
        &json!({
            "oauthAccount": { "emailAddress": "someone@example.com" },
            "mcpServers": {
                "slack": { "command": "npx-secret-cmd", "args": ["--token", "sekret-arg"], "env": { "SLACK_TOKEN": "sekret-env" } },
                "atlassian": { "type": "http", "url": "https://mcp.secret-host.example/v1" },
                "my server": { "command": "x" }
            }
        }),
    );
    let cache = fx.claude_dir.join("plugins").join("cache").join("mkt");
    let plugin = cache.join("ctx").join("1.0.0");
    let other = cache.join("pathy").join("1.0.0");
    let disabled = cache.join("off").join("1.0.0");
    let legacy = cache.join("v1").join("1.0.0");
    fx.write(
        &plugin.join(".mcp.json"),
        &json!({ "mcpServers": { "context7": { "command": "npx", "env": { "KEY": "sekret-plugin" } } } }),
    );
    fx.write(
        &other.join(".claude-plugin").join("plugin.json"),
        &json!({ "name": "pathy", "mcpServers": "./servers.json" }),
    );
    fx.write(
        &other.join("servers.json"),
        &json!({ "mcpServers": { "linear": {} } }),
    );
    fx.write(
        &disabled.join(".mcp.json"),
        &json!({ "mcpServers": { "nope": {} } }),
    );
    // The v1 shape (one object per plugin, not an array), with servers in its manifest.
    fx.write(
        &legacy.join(".claude-plugin").join("plugin.json"),
        &json!({ "mcpServers": { "sentry": {} } }),
    );
    fx.write(
        &fx.claude_dir.join("settings.json"),
        &json!({ "enabledPlugins": { "ctx@mkt": true, "pathy@mkt": true, "off@mkt": false, "v1@mkt": true } }),
    );
    fx.write(
        &fx.claude_dir.join("plugins").join("installed_plugins.json"),
        &json!({
            "version": 2,
            "plugins": {
                "ctx@mkt": [{ "scope": "user", "installPath": ps(&plugin) }],
                "pathy@mkt": [{ "scope": "user", "installPath": ps(&other) }],
                "off@mkt": [{ "scope": "user", "installPath": ps(&disabled) }],
                "v1@mkt": { "installPath": ps(&legacy) }
            }
        }),
    );
    let caps = scan_capabilities(&fx.opts()).await;
    assert_eq!(
        mcp_sorted(&caps),
        ["atlassian", "context7", "linear", "sentry", "slack"]
    );
    let text = serde_json::to_string(&caps).unwrap();
    for secret in [
        "npx",
        "sekret",
        "secret-host",
        "https://",
        "SLACK_TOKEN",
        "someone@example.com",
    ] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
}

#[test]
fn a_manifest_path_outside_the_plugin_is_ignored() {
    let fx = Fx::new();
    let dir = fx.tmp.join("p");
    fx.write(
        &dir.join(".claude-plugin").join("plugin.json"),
        &json!({ "mcpServers": "../evil.json" }),
    );
    fx.write(
        &fx.tmp.join("evil.json"),
        &json!({ "mcpServers": { "evil": {} } }),
    );
    assert!(plugin_mcp_names(&ps(&dir)).is_empty());
}

#[tokio::test]
async fn malformed_config_files_contribute_nothing() {
    let fx = Fx::new();
    std::fs::write(fx.tmp.join(".claude.json"), "{not json").unwrap();
    std::fs::write(fx.claude_dir.join("settings.json"), "[]").unwrap();
    let caps = scan_capabilities(&fx.opts()).await;
    assert!(mcp_sorted(&caps).is_empty());
}

#[tokio::test]
async fn skills_and_agents_user_scope_and_repo_scope_only_with_a_remote() {
    let fx = Fx::new();
    let mk = |dir: &Path| {
        std::fs::create_dir_all(dir.join("skills").join("review")).unwrap();
        std::fs::create_dir_all(dir.join("skills").join(".hidden")).unwrap();
        std::fs::create_dir_all(dir.join("agents")).unwrap();
        std::fs::write(dir.join("agents").join("planner.md"), "secret agent prompt").unwrap();
        std::fs::write(dir.join("agents").join("notes.txt"), "x").unwrap();
    };
    mk(&fx.claude_dir);
    let with_remote = fx.tmp.join("app");
    let no_remote = fx.tmp.join("local");
    mk(&with_remote.join(".claude"));
    std::fs::create_dir_all(no_remote.join(".claude").join("skills").join("local-only")).unwrap();
    // A symlinked skill dir counts (it is never followed for anything else).
    let linked = try_symlink(
        &with_remote.join(".claude").join("skills").join("review"),
        &fx.claude_dir.join("skills").join("linked"),
    )
    .is_some();
    let repo = |path: &Path, remote: Option<&str>| InventoryRepo {
        path: ps(path).as_str().try_into().unwrap(),
        remote: remote.map(str::to_string),
        default_branch: "main".try_into().unwrap(),
        head_commit: "a".repeat(40).as_str().try_into().unwrap(),
        mode: WorkingCopyMode::Reference,
    };
    let mut o = fx.opts();
    o.repos = vec![
        repo(&with_remote, Some("github.com/org/app")),
        repo(&no_remote, None),
    ];
    let caps = scan_capabilities(&o).await;
    let skills_and_agents: Vec<&Capability> = caps
        .iter()
        .filter(|c| matches!(c, Capability::Skill { .. } | Capability::Agent { .. }))
        .collect();
    let mut want = vec![
        named("skill", "review", None),
        named("agent", "planner", None),
        named("skill", "review", Some("github.com/org/app")),
        named("agent", "planner", Some("github.com/org/app")),
    ];
    if linked {
        want.push(named("skill", "linked", None));
    }
    for w in &want {
        assert!(
            skills_and_agents.contains(&w),
            "{w:?} missing from {caps:?}"
        );
    }
    assert_eq!(skills_and_agents.len(), want.len(), "{caps:?}");
    let text = serde_json::to_string(&caps).unwrap();
    assert!(!text.contains("secret agent prompt"));
    assert!(!text.contains("local-only"));
}

#[test]
fn normalize_mcp_name_plugin_server_to_server() {
    assert_eq!(normalize_mcp_name("plugin:slack:slack"), "slack");
    assert_eq!(normalize_mcp_name("plugin:gh:github"), "github");
    assert_eq!(normalize_mcp_name("slack"), "slack");
    assert_eq!(normalize_mcp_name("plugin:x"), "plugin:x");
    assert_eq!(normalize_mcp_name("plugin:a:b:c"), "b:c");
    assert_eq!(normalize_mcp_name("plugin::x"), "plugin::x");
    assert_eq!(normalize_mcp_name("plugin:a:"), "plugin:a:");
    assert_eq!(normalize_mcp_name("plugin:a:b\nc"), "plugin:a:b\nc");
}

#[tokio::test]
async fn a_plugin_mcp_name_is_reported_as_mcp_server() {
    let fx = Fx::new();
    fx.write(
        &fx.tmp.join(".claude.json"),
        &json!({ "mcpServers": { "plugin:slack:slack": {}, "plugin:gh:github": {} } }),
    );
    fx.plugin("ctx", &["plugin:ctx:context7"]);
    let caps = scan_capabilities(&fx.opts()).await;
    assert_eq!(mcp_sorted(&caps), ["context7", "github", "slack"]);
    let keys: Vec<String> = caps.iter().flat_map(capability_keys).collect();
    assert!(keys.contains(&"mcp:slack".to_string()));
    assert!(!keys.iter().any(|k| k.starts_with("mcp:plugin")));
}

#[tokio::test]
async fn an_invalid_name_is_logged_once_per_scan_and_not_reported() {
    let fx = Fx::new();
    fx.fake(
        "gh",
        "if [ \"$1\" = --version ]; then echo \"gh version 2.50.0\"; exit 0; fi\nexit 0",
    );
    fx.write(
        &fx.tmp.join(".claude.json"),
        &json!({ "mcpServers": { "slack": {}, "a:b": {}, "my server": {}, "plugin:p:x@y": {} } }),
    );
    fx.plugin("dup", &["a:b"]);
    std::fs::create_dir_all(fx.claude_dir.join("skills").join("review")).unwrap();
    std::fs::create_dir_all(fx.claude_dir.join("skills").join("x@host")).unwrap();
    let (log, lines) = logger();
    let mut o = fx.opts();
    o.log = log;
    let caps = scan_capabilities(&o).await;

    {
        let lines = lines.lock().unwrap();
        let ab: Vec<&String> = lines.iter().filter(|l| l.contains("\"a:b\"")).collect();
        assert_eq!(ab.len(), 1, "{lines:?}");
        assert!(ab[0].starts_with("inventory: capability mcp \"a:b\" not reported: "));
        assert!(ab[0].len() > "inventory: capability mcp \"a:b\" not reported: ".len());
        for prefix in [
            "inventory: capability mcp \"my server\" not reported: ",
            "inventory: capability skill \"x@host\" not reported: ",
            // A normalised name is logged as configured.
            "inventory: capability mcp \"plugin:p:x@y\" not reported: ",
        ] {
            assert!(
                lines.iter().any(|l| l.starts_with(prefix)),
                "{prefix} not in {lines:?}"
            );
        }
        assert_eq!(lines.len(), 4, "{lines:?}");
    }

    let text = serde_json::to_string(&caps).unwrap();
    for bad in ["a:b", "my server", "x@host", "x@y"] {
        assert!(!text.contains(bad), "{bad} in {text}");
    }
    assert!(caps.contains(&named("mcp", "slack", None)));
    assert!(caps.contains(&named("skill", "review", None)));
    assert!(caps.contains(&cli("gh", Some("2.50.0"), true)));

    // Once per scan, not once ever.
    scan_capabilities(&o).await;
    assert_eq!(lines.lock().unwrap().len(), 8);
}

#[test]
fn log_names_are_json_quoted_and_cut_at_200() {
    assert_eq!(log_name("a\"b"), "\"a\\\"b\"");
    let long = "x".repeat(250);
    assert_eq!(log_name(&long), format!("\"{}\u{2026}\"", "x".repeat(200)));
}

#[tokio::test]
async fn the_result_is_sorted_by_key_and_one_entry_per_cli() {
    let fx = Fx::new();
    fx.write(
        &fx.tmp.join(".claude.json"),
        &json!({ "mcpServers": { "zeta": {}, "alpha": {}, "plugin:x:alpha": {} } }),
    );
    std::fs::create_dir_all(fx.claude_dir.join("skills").join("beta")).unwrap();
    let caps = scan_capabilities(&fx.opts()).await;
    // POSIX: the linked real git answers its probe too ("cli:git" sorts first).
    let keys: Vec<String> = caps
        .iter()
        .map(capability_key)
        .filter(|k| !k.starts_with("cli:"))
        .collect();
    assert_eq!(keys, ["mcp:alpha", "mcp:zeta", "skill:beta"]);
    let all: Vec<String> = caps.iter().map(capability_key).collect();
    let mut sorted = all.clone();
    sorted.sort();
    assert_eq!(all, sorted);
}
