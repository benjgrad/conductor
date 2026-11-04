//! `conductor-daemon run` (MR-T13b), the port of `packages/daemon/src/main.ts` `run()`:
//! env → config, the outcome server on 127.0.0.1, the permission-prompt probe, the real ADR-0005
//! CLI driver, the daemon core, and signals.
//!
//! Exits (10-contracts §Daemon auto-update, ADR-0021 §2.4):
//! - 0 after SIGINT/SIGTERM (Ctrl-C / console close on Windows);
//! - 78 (`EXIT_FATAL_AUTH`) when the link is revoked, unauthorized or the protocol is too old, so
//!   the service units don't restart-loop (TD-119); under launchd the job also boots itself out;
//! - 1 when the daemon can't start (bad config, the root can't be made private).
//!
//! The first of shutdown and fatal wins, as TS's `exiting` flag: the SIGTERM that launchd's
//! bootout sends after a fatal close must not turn 78 into 0.

use crate::claude::cli_driver::{CliDriverOptions, create_cli_driver, probe_permission_prompts};
use crate::claude::outcome_server::{OutcomeServerOptions, start_outcome_server};
use crate::commands::service::stop_supervised_job;
use crate::config::{DaemonConfig, Env, load_config, machine_facts};
use crate::daemon::{Daemon, DaemonOptions};
use crate::inventory::report::ScanFn;
use crate::platform::signals::DaemonSignal;
use crate::platform::{CliOptions, exec_file_cli, native_exe_problem};
use crate::sysinfo::SysInfo;
use crate::ws_client::fatal_exit_code;
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// Starts a tool without waiting for it.
pub type StartDetached = Box<dyn FnMut(&str, &[String]) + Send>;

/// What `run` takes from the machine; tests pass their own.
pub struct RunDeps {
    /// Shutdown and rescan requests (`platform::signals::daemon_signals` in `main`).
    pub signals: mpsc::UnboundedReceiver<DaemonSignal>,
    /// Start a tool without waiting for it (the launchd bootout after a fatal close).
    pub start_detached: StartDetached,
    /// The user id (`gui/<uid>` for launchd); None on Windows.
    pub uid: Option<u32>,
    /// Where `run`'s own lines go. Default: stderr, `[conductor-daemon] <msg>`.
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// How long killed children get before `run` returns. Default: the config's kill grace (TS
    /// `setTimeout(process.exit, killGraceMs)`). Tests shorten it.
    pub exit_grace: Option<Duration>,
    /// Tests only: the inventory scan (default: the real one, which probes gh, az and claude).
    pub scan_inventory: Option<ScanFn>,
    /// Tests only: the machine's live resources (default: the real ones).
    pub sysinfo: Option<SysInfo>,
}

impl RunDeps {
    /// The real seams around `signals`.
    pub fn new(signals: mpsc::UnboundedReceiver<DaemonSignal>, uid: Option<u32>) -> Self {
        RunDeps {
            signals,
            start_detached: Box::new(|file: &str, args: &[String]| {
                let _ = std::process::Command::new(file)
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .spawn();
            }),
            uid,
            log: Arc::new(|m: &str| eprintln!("[conductor-daemon] {m}")),
            exit_grace: None,
            scan_inventory: None,
            sysinfo: None,
        }
    }
}

/// `claude --version` output → "2.1.308": the first `\d+\.\d+\.\d+`, else the trimmed output,
/// else None (TS `claudeCodeVersion`).
pub fn parse_claude_version(stdout: &str) -> Option<String> {
    let b = stdout.as_bytes();
    let digits = |mut i: usize| {
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        (i > s).then_some(i)
    };
    for start in 0..b.len() {
        if start > 0 && b[start - 1].is_ascii_digit() {
            continue;
        }
        let Some(a) = digits(start) else { continue };
        if b.get(a) != Some(&b'.') {
            continue;
        }
        let Some(c) = digits(a + 1) else { continue };
        if b.get(c) != Some(&b'.') {
            continue;
        }
        if let Some(e) = digits(c + 1) {
            return Some(stdout[start..e].to_string());
        }
    }
    let t = stdout.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// TD-077: is `root` inside a `.claude` directory (a path component named exactly `.claude`)?
/// Claude Code treats any `.claude` directory as protected config and denies writes there.
pub fn inside_dot_claude(root: &Path) -> bool {
    root.components()
        .any(|c| matches!(c, Component::Normal(n) if n == ".claude"))
}

/// The line `run` prints once the daemon has started.
pub fn startup_line(c: &DaemonConfig) -> String {
    format!(
        "{} → {} (root {}, {})",
        c.machine_id,
        c.orchestrator_url,
        c.root_dir.display(),
        if c.credential.is_some() {
            "enrolled"
        } else {
            "local mode"
        }
    )
}

/// `<bin> --version` → its version, or None when the CLI is missing or not a native exe (U-015).
pub async fn claude_code_version(bin: &str, log: &(dyn Fn(&str) + Send + Sync)) -> Option<String> {
    if let Some(problem) = native_exe_problem(bin, &crate::platform::spawn::process_env(), None) {
        log(&problem);
        return None;
    }
    let opts = CliOptions {
        timeout: Some(Duration::from_millis(10_000)),
        ..CliOptions::default()
    };
    match exec_file_cli(bin, &["--version".to_string()], opts).await {
        Ok(out) if out.output.status.success() && !out.timed_out => {
            parse_claude_version(&String::from_utf8_lossy(&out.output.stdout))
        }
        _ => None,
    }
}

/// Run the daemon until a signal stops it or the link fails for good; returns the exit code.
/// Needs a tokio runtime.
pub async fn run_daemon(env: &Env, mut deps: RunDeps) -> i32 {
    let log = deps.log.clone();
    let config = match load_config(env, &machine_facts()) {
        Ok(c) => c,
        Err(e) => {
            log(&e.to_string());
            return 1;
        }
    };
    let claude_bin = env
        .get("CONDUCTOR_CLAUDE_BIN")
        .cloned()
        .unwrap_or_else(|| "claude".to_string());
    let outcome_server = match start_outcome_server(OutcomeServerOptions::default()).await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log(&format!("cannot start the outcome server: {e}"));
            return 1;
        }
    };
    // ADR-0023: auto mode + prompts to the board need a CLI that has them; probed once per start.
    let prompts = probe_permission_prompts(&claude_bin, &[]).await;
    if !prompts.supported {
        // TD-187: ADR-0023 asks for a machine alert; the alert frame has no kind for this yet.
        log(&format!(
            "WARNING: this Claude Code can't send permission prompts to conductor ({}); agents \
             run with the old flags and anything that would prompt is denied. Update Claude Code.",
            prompts.reason.as_deref().unwrap_or("unknown")
        ));
    }
    let kill_grace = Duration::from_millis(config.kill_grace_ms);
    let driver = create_cli_driver(CliDriverOptions {
        claude_bin: Some(claude_bin.clone()),
        kill_grace: Some(kill_grace),
        end_grace: Some(Duration::from_millis(config.end_grace_ms)),
        permission_prompts: Some(prompts.supported),
        ..CliDriverOptions::new(outcome_server.clone())
    });
    // The link can fail before the loop below runs: the channel keeps the code until then.
    let (fatal_tx, mut fatal_rx) = mpsc::unbounded_channel::<u16>();
    let version = claude_code_version(&claude_bin, &*log).await;
    let daemon = match Daemon::new(DaemonOptions {
        claude_code_version: version,
        claude_bin: Some(claude_bin),
        // The daemon's own lines go where `run`'s do (stderr, `[conductor-daemon] `, as TS).
        log: Some(log.clone()),
        scan_inventory: deps.scan_inventory.take(),
        sysinfo: deps.sysinfo.take(),
        on_fatal: Some(Arc::new(move |code: u16, _: &str| {
            let _ = fatal_tx.send(code);
        })),
        ..DaemonOptions::new(config.clone(), Arc::new(driver))
    }) {
        Ok(d) => d,
        Err(e) => {
            log(&e.to_string());
            outcome_server.close().await;
            return 1;
        }
    };
    if inside_dot_claude(&config.root_dir) {
        log(&format!(
            "WARNING: CONDUCTOR_ROOT ({}) is inside a .claude directory; Claude Code will deny \
             agent file writes there. Use a root outside .claude (default ~/.conductor).",
            config.root_dir.display()
        ));
    }
    daemon.start();
    log(&startup_line(&config));

    let code = loop {
        tokio::select! {
            sig = deps.signals.recv() => match sig {
                Some(DaemonSignal::Rescan) => daemon.rescan_inventory().await,
                // A closed channel: nothing can stop us any more, so stop now.
                Some(DaemonSignal::Shutdown) | None => break 0,
            },
            Some(close) = fatal_rx.recv() => {
                // Revoked, unauthorized or protocol too old: the daemon already logged why. Under
                // launchd also boot the job out, so KeepAlive doesn't restart it (TD-119).
                stop_supervised_job(env, deps.uid, &mut *deps.start_detached);
                break fatal_exit_code(close);
            }
        }
    };
    // TS `daemon.stop()`: killSessions defaults to true (held prompts denied, agents stopped).
    daemon.stop(true);
    outcome_server.close().await;
    // Give killed children a moment to exit.
    tokio::time::sleep(deps.exit_grace.unwrap_or(kill_grace)).await;
    code
}

#[cfg(test)]
mod tests;
