//! Port of `packages/daemon/src/commands/service.ts` (M2-T18; MR-T13a): `conductor-daemon service
//! install | uninstall | restart | status` (ADR-0017 §Daemon distribution, ADR-0021 §3/§5). It
//! starts the daemon at login, as the user, never with sudo:
//! - macOS: a launchd agent, `~/Library/LaunchAgents/com.conductor.daemon.plist`, in `gui/<uid>`;
//!   logs in `<root>/logs/daemon.log`.
//! - Linux: a systemd user unit, `~/.config/systemd/user/conductor-daemon.service`; logs in the
//!   journal.
//!
//! Both run `<root>/bin/conductor-launch` (`assets/conductor-launch.sh`, the same bytes as the TS
//! daemon's asset and what install.sh writes), which execs `<root>/daemon/current/bin/conductor-daemon
//! run`, so an upgrade takes effect on restart. They set `CONDUCTOR_SUPERVISED`, `CONDUCTOR_ROOT`
//! and `PATH` (the installing shell's: launchd's own PATH has no claude, gh or Homebrew).
//!
//! **Intended difference from TS:** the units no longer pin `CONDUCTOR_NODE` and `service install`
//! no longer checks for Node 22+: the Rust binary needs no Node (Ben, 2026-11-03).
//!
//! Exit codes (TD-119, 10-contracts §Daemon auto-update): 78 `EXIT_FATAL_AUTH` must not restart
//! (systemd `RestartPreventExitStatus`; launchd can't exclude a status, so the daemon's fatal path
//! boots its own job out, [`stop_supervised_job`], with `ThrottleInterval` as a floor); 75 and any
//! other failure restart under both.
//!
//! Windows has no service manager here yet (the Scheduled Task is MR-T13b, U-114): `service`
//! refuses there with exit 2, as TS. Unit paths and PATH are always `/` and `:` (POSIX-only
//! units), also when the pure renderers run on Windows.

use super::Output;
use crate::config::{Env, root_dir_from};
use crate::credential::CREDENTIAL_FILE;
use crate::platform::{fs::posix_mode, fs::set_posix_mode, machine};
use std::io;
use std::path::{Path, PathBuf};

pub const LAUNCHD_LABEL: &str = "com.conductor.daemon";
pub const SYSTEMD_UNIT: &str = "conductor-daemon.service";

/// The launcher (ADR-0021 §3), version-independent: it lives in `<root>/bin`.
pub const LAUNCHER: &str = include_str!("../../assets/conductor-launch.sh");

pub const SERVICE_USAGE: &str = "usage: conductor-daemon service install|uninstall|restart|status";

/// The per-user service manager `service` drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceManager {
    Launchd,
    Systemd,
}

/// launchd on macOS, systemd --user on Linux, None elsewhere (win32 included), by Node platform
/// name (`platform/service-manager.ts`).
pub fn service_manager_for(node_platform: &str) -> Option<ServiceManager> {
    match node_platform {
        "darwin" => Some(ServiceManager::Launchd),
        "linux" => Some(ServiceManager::Systemd),
        _ => None,
    }
}

/// The service manager of this OS.
pub fn service_manager() -> Option<ServiceManager> {
    service_manager_for(machine::node_platform())
}

/// A tool's result: `status` None when it couldn't run (or died on a signal).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run a tool with `env` as its whole environment: argv only, never a shell (`spawnSync`).
pub fn run_tool(env: &Env, file: &str, args: &[String]) -> RunResult {
    match std::process::Command::new(file)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(o) => RunResult {
            status: o.status.code(),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Err(e) => RunResult {
            status: None,
            stdout: String::new(),
            stderr: e.to_string(),
        },
    }
}

/// What `service` needs from the machine; tests pass fakes (no launchctl or systemctl in CI).
pub struct ServiceDeps<'a> {
    /// launchd, systemd, or None where `service` isn't supported (win32).
    pub manager: Option<ServiceManager>,
    pub home: PathBuf,
    /// The user id (`gui/<uid>`); None on Windows (TS: -1).
    pub uid: Option<u32>,
    pub env: &'a Env,
    /// Run a tool (argv, no shell).
    pub run: &'a mut dyn FnMut(&str, &[String]) -> RunResult,
    pub io: &'a mut dyn Output,
    /// True under WSL (the systemd note differs).
    pub wsl: bool,
}

/// What the unit files are rendered from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitInputs {
    pub root: String,
    /// PATH for the daemon.
    pub path: String,
    pub home: String,
}

fn join(parts: &[&str]) -> String {
    let mut s = parts[0].trim_end_matches('/').to_string();
    for p in &parts[1..] {
        s.push('/');
        s.push_str(p);
    }
    s
}

fn unit_env(u: &UnitInputs, supervisor: &str) -> Vec<(&'static str, String)> {
    vec![
        ("CONDUCTOR_SUPERVISED", supervisor.to_string()),
        ("CONDUCTOR_ROOT", u.root.clone()),
        ("PATH", u.path.clone()),
    ]
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn launcher_path(root: &str) -> String {
    join(&[root, "bin", "conductor-launch"])
}

pub fn log_path(root: &str) -> String {
    join(&[root, "logs", "daemon.log"])
}

/// The launchd agent. KeepAlive restarts any failed exit; ThrottleInterval spaces restarts.
pub fn render_plist(u: &UnitInputs) -> String {
    let env = unit_env(u, "launchd")
        .iter()
        .map(|(k, v)| format!("    <key>{}</key>\n    <string>{}</string>", xml(k), xml(v)))
        .collect::<Vec<_>>()
        .join("\n");
    let launcher = xml(&launcher_path(&u.root));
    let home = xml(&u.home);
    let log = xml(&log_path(&u.root));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by conductor-daemon service install; re-run it rather than editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{launcher}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>{home}</string>
  <key>EnvironmentVariables</key>
  <dict>
{env}
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#
    )
}

/// A value systemd reads literally inside double quotes (`%` → `%%`); errs on what can't be.
fn systemd_quote(v: &str) -> Result<String, String> {
    if v.contains(['"', '\\', '\n', '\r']) {
        return Err(format!(
            "cannot write {} into a systemd unit (\", \\ or a newline)",
            serde_json::to_string(v).unwrap_or_default()
        ));
    }
    Ok(format!("\"{}\"", v.replace('%', "%%")))
}

/// The systemd user unit. 78 (EXIT_FATAL_AUTH) never restarts; 75 and other failures do.
pub fn render_systemd_unit(u: &UnitInputs) -> Result<String, String> {
    let env = unit_env(u, "systemd")
        .iter()
        .map(|(k, v)| systemd_quote(&format!("{k}={v}")).map(|q| format!("Environment={q}")))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    let exec = systemd_quote(&launcher_path(&u.root))?;
    Ok(format!(
        "# Written by conductor-daemon service install; re-run it rather than editing this file.
[Unit]
Description=conductor daemon
After=network-online.target

[Service]
Type=simple
ExecStart={exec}
{env}
WorkingDirectory=%h
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
"
    ))
}

/// The daemon's fatal-auth path (TD-119): under launchd, boot our own job out so KeepAlive doesn't
/// restart a revoked machine. It loads again at the next login. systemd needs nothing. `start`
/// launches the tool without waiting (MR-T13b passes a detached spawn).
pub fn stop_supervised_job(env: &Env, uid: Option<u32>, start: &mut dyn FnMut(&str, &[String])) {
    let (Some(uid), Some("launchd")) = (uid, env.get("CONDUCTOR_SUPERVISED").map(String::as_str))
    else {
        return;
    };
    start(
        "launchctl",
        &["bootout".to_string(), format!("gui/{uid}/{LAUNCHD_LABEL}")],
    );
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

/// Write `content` (atomically, `mode`) unless the file already holds exactly it. True if written.
fn write_if_changed(path: &str, content: &str, mode: u32) -> io::Result<bool> {
    let p = Path::new(path);
    if std::fs::read_to_string(p).is_ok_and(|c| c == content)
        && posix_mode(p).is_none_or(|m| m & 0o777 == mode)
    {
        return Ok(false);
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = format!("{path}.{}.tmp", hex::encode(rand::random::<[u8; 6]>()));
    let write = || -> io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        drop(f);
        set_posix_mode(Path::new(&tmp), mode)?;
        std::fs::rename(&tmp, p)
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}

fn plist_path(home: &str) -> String {
    join(&[
        home,
        "Library",
        "LaunchAgents",
        &format!("{LAUNCHD_LABEL}.plist"),
    ])
}

fn systemd_unit_path(home: &str) -> String {
    join(&[home, ".config", "systemd", "user", SYSTEMD_UNIT])
}

/// The PATH the units get: the installing shell's absolute entries, deduplicated, in order.
pub fn unit_path_var(path: Option<&str>) -> String {
    let mut dirs: Vec<&str> = Vec::new();
    for d in path.unwrap_or("").split(':') {
        if d.starts_with('/') && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs.join(":")
}

fn failed(r: &RunResult) -> String {
    let text = if !r.stderr.trim().is_empty() {
        r.stderr.trim().to_string()
    } else if !r.stdout.trim().is_empty() {
        r.stdout.trim().to_string()
    } else {
        format!(
            "exit {}",
            r.status.map_or("error".to_string(), |s| s.to_string())
        )
    };
    text.lines().next().unwrap_or("").to_string()
}

/// `launchctl print` output → the pid (`pid = 123`), if running.
fn launchd_pid(stdout: &str) -> Option<&str> {
    let mut rest = stdout;
    while let Some(i) = rest.find("pid = ") {
        let before = rest[..i].chars().next_back();
        let after = &rest[i + "pid = ".len()..];
        let digits = after
            .find(|c: char| !c.is_ascii_digit())
            .map_or(after, |end| &after[..end]);
        if !before.is_some_and(|c| c.is_alphanumeric() || c == '_') && !digits.is_empty() {
            return Some(digits);
        }
        rest = after;
    }
    None
}

struct Ctx<'d, 'a> {
    d: &'d mut ServiceDeps<'a>,
    manager: ServiceManager,
    unit: String,
}

impl Ctx<'_, '_> {
    fn run(&mut self, file: &str, args: &[&str]) -> RunResult {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        (self.d.run)(file, &args)
    }

    fn out(&mut self, l: &str) {
        self.d.io.out(l);
    }

    fn err(&mut self, l: &str) {
        self.d.io.err(l);
    }

    fn domain(&self) -> String {
        format!("gui/{}", self.d.uid.map_or(-1, i64::from))
    }

    fn target(&self) -> String {
        format!("{}/{LAUNCHD_LABEL}", self.domain())
    }

    // ---------------------------------------------------------------------------- launchd

    fn loaded(&mut self) -> bool {
        let t = self.target();
        self.run("launchctl", &["print", &t]).status == Some(0)
    }

    fn bootstrap(&mut self) -> i32 {
        let (domain, target, unit) = (self.domain(), self.target(), self.unit.clone());
        // A job disabled earlier (e.g. by `launchctl disable`) would refuse to bootstrap.
        self.run("launchctl", &["enable", &target]);
        let r = self.run("launchctl", &["bootstrap", &domain, &unit]);
        if r.status != Some(0) {
            self.err(&format!(
                "launchctl bootstrap {domain} failed: {}",
                failed(&r)
            ));
            return 1;
        }
        0
    }

    fn bootout(&mut self) {
        let t = self.target();
        self.run("launchctl", &["bootout", &t]);
    }

    // ---------------------------------------------------------------------------- systemd

    fn ctl(&mut self, args: &[&str]) -> RunResult {
        let mut a = vec!["--user"];
        a.extend_from_slice(args);
        self.run("systemctl", &a)
    }

    fn no_bus(&mut self, r: &RunResult) -> i32 {
        self.err(&format!(
            "systemctl --user failed: {}. It needs your login session's user manager \
             (not plain ssh/su); log in normally, or run: loginctl enable-linger \"$USER\"",
            failed(r)
        ));
        1
    }

    // ---------------------------------------------------------------------------- both

    fn render(&self, u: &UnitInputs) -> Result<String, String> {
        match self.manager {
            ServiceManager::Launchd => Ok(render_plist(u)),
            ServiceManager::Systemd => render_systemd_unit(u),
        }
    }

    fn logs(&self, root: &str) -> String {
        match self.manager {
            ServiceManager::Launchd => log_path(root),
            ServiceManager::Systemd => "journalctl --user -u conductor-daemon".to_string(),
        }
    }

    /// After the unit file is written (`changed`) or left as it was.
    fn activate(&mut self, changed: bool) -> i32 {
        match self.manager {
            ServiceManager::Launchd => {
                if changed {
                    if self.loaded() {
                        self.bootout();
                    }
                    return self.bootstrap();
                }
                if self.loaded() { 0 } else { self.bootstrap() }
            }
            ServiceManager::Systemd => {
                if changed {
                    // A changed unit applies to a running service only after a restart (which
                    // also starts it).
                    for args in [
                        &["daemon-reload"][..],
                        &["enable", SYSTEMD_UNIT],
                        &["restart", SYSTEMD_UNIT],
                    ] {
                        let r = self.ctl(args);
                        if r.status != Some(0) {
                            return self.no_bus(&r);
                        }
                    }
                } else {
                    let r = self.ctl(&["enable", "--now", SYSTEMD_UNIT]);
                    if r.status != Some(0) {
                        return self.no_bus(&r);
                    }
                }
                let wsl = if self.d.wsl {
                    " (WSL: systemd must be on in /etc/wsl.conf, and WSL itself starts only when you open it)"
                } else {
                    ""
                };
                self.out(&format!(
                    "to keep it running while you are logged out: loginctl enable-linger \"$USER\"{wsl}"
                ));
                0
            }
        }
    }

    fn uninstall(&mut self) -> io::Result<i32> {
        let unit = self.unit.clone();
        match self.manager {
            ServiceManager::Launchd => {
                if self.loaded() {
                    self.bootout();
                }
                remove_force(&unit)?;
            }
            ServiceManager::Systemd => {
                if exists(&unit) {
                    self.ctl(&["disable", "--now", SYSTEMD_UNIT]);
                }
                remove_force(&unit)?;
                self.ctl(&["daemon-reload"]);
            }
        }
        self.out(&format!("conductor-daemon service removed ({unit})"));
        Ok(0)
    }

    fn restart(&mut self) -> i32 {
        match self.manager {
            ServiceManager::Launchd => {
                if !self.loaded() {
                    return self.bootstrap();
                }
                let t = self.target();
                let r = self.run("launchctl", &["kickstart", "-k", &t]);
                if r.status != Some(0) {
                    self.err(&format!("launchctl kickstart failed: {}", failed(&r)));
                    return 1;
                }
                0
            }
            ServiceManager::Systemd => {
                let r = self.ctl(&["restart", SYSTEMD_UNIT]);
                if r.status == Some(0) {
                    0
                } else {
                    self.no_bus(&r)
                }
            }
        }
    }

    fn status(&mut self, root: &str) -> i32 {
        let unit = self.unit.clone();
        let installed = if exists(&unit) {
            "installed"
        } else {
            "not installed"
        };
        match self.manager {
            ServiceManager::Launchd => {
                let t = self.target();
                let r = self.run("launchctl", &["print", &t]);
                let pid = if r.status == Some(0) {
                    launchd_pid(&r.stdout).map(str::to_string)
                } else {
                    None
                };
                self.out(&format!("unit: {unit} ({installed})"));
                let state = match (&pid, r.status == Some(0)) {
                    (Some(p), _) => format!("running (pid {p})"),
                    (None, true) => "loaded, not running".to_string(),
                    (None, false) => "not loaded".to_string(),
                };
                self.out(&format!("state: {state}"));
                self.out(&format!("logs: {}", log_path(root)));
                if pid.is_some() { 0 } else { 3 }
            }
            ServiceManager::Systemd => {
                let r = self.ctl(&["is-active", SYSTEMD_UNIT]);
                let state = match r.stdout.trim() {
                    "" => "unknown".to_string(),
                    s => s.to_string(),
                };
                self.out(&format!("unit: {unit} ({installed})"));
                self.out(&format!("state: {state}"));
                let logs = self.logs(root);
                self.out(&format!("logs: {logs}"));
                if state == "active" { 0 } else { 3 }
            }
        }
    }

    fn install(&mut self, root: &str) -> Result<i32, String> {
        let daemon = join(&[root, "daemon", "current", "bin", "conductor-daemon"]);
        if !exists(&daemon) {
            self.err(&format!(
                "{daemon} is missing: install conductor with install.sh first (Machines → Add a machine)"
            ));
            return Ok(1);
        }
        if !exists(&join(&[root, CREDENTIAL_FILE])) {
            self.err(&format!(
                "warning: {root} is not enrolled; the daemon will run in local mode until you enroll it"
            ));
        }
        let logs = join(&[root, "logs"]);
        if !exists(&logs) {
            std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
            set_posix_mode(Path::new(&logs), 0o700).map_err(|e| e.to_string())?;
        }
        write_if_changed(&launcher_path(root), LAUNCHER, 0o755).map_err(|e| e.to_string())?;
        let inputs = UnitInputs {
            root: root.to_string(),
            path: unit_path_var(self.d.env.get("PATH").map(String::as_str)),
            home: self.d.home.to_string_lossy().into_owned(),
        };
        let content = self.render(&inputs)?;
        let unit = self.unit.clone();
        let changed = write_if_changed(&unit, &content, 0o644).map_err(|e| e.to_string())?;
        let code = self.activate(changed);
        if code != 0 {
            return Ok(code);
        }
        self.out(&format!("conductor-daemon service installed: {unit}"));
        let logs = self.logs(root);
        self.out(&format!("logs: {logs}"));
        Ok(0)
    }
}

fn remove_force(path: &str) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Run `service …`; returns the exit code (0 ok, 1 failed, 2 usage; `status`: 3 not running).
pub fn service_command(argv: &[String], d: &mut ServiceDeps<'_>) -> i32 {
    let sub = argv.first().map(String::as_str);
    let Some(sub) = sub
        .filter(|s| argv.len() == 1 && ["install", "uninstall", "restart", "status"].contains(s))
    else {
        d.io.err(SERVICE_USAGE);
        return 2;
    };
    let Some(manager) = d.manager else {
        d.io.err("service is not supported on this OS yet; start conductor-daemon yourself");
        return 2;
    };
    let root = root_dir_from(d.env, &d.home).to_string_lossy().into_owned();
    let home = d.home.to_string_lossy().into_owned();
    let unit = match manager {
        ServiceManager::Launchd => plist_path(&home),
        ServiceManager::Systemd => systemd_unit_path(&home),
    };
    let mut ctx = Ctx { d, manager, unit };
    let result = match sub {
        "install" => ctx.install(&root),
        "uninstall" => ctx.uninstall().map_err(|e| e.to_string()),
        "restart" => {
            if !exists(&ctx.unit) {
                let unit = ctx.unit.clone();
                ctx.err(&format!(
                    "the service is not installed ({unit}); run: conductor-daemon service install"
                ));
                Ok(1)
            } else {
                Ok(ctx.restart())
            }
        }
        _ => Ok(ctx.status(&root)),
    };
    result.unwrap_or_else(|e| {
        ctx.err(&format!("service {sub}: {e}"));
        1
    })
}

/// `service` on this machine: the real service manager, home, uid and tools.
pub fn run_service_command(argv: &[String], env: &Env, io: &mut dyn Output) -> i32 {
    let mut run = |file: &str, args: &[String]| run_tool(env, file, args);
    let mut d = ServiceDeps {
        manager: service_manager(),
        home: machine::home_dir(),
        uid: machine::current_uid(),
        env,
        run: &mut run,
        io,
        wsl: machine::is_wsl(),
    };
    service_command(argv, &mut d)
}

#[cfg(test)]
mod tests;
