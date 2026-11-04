//! The `conductor-daemon` binary (port of `packages/daemon/src/main.ts`; MR-T13a): the clap CLI
//! and its subcommands `run` (default), `enroll`, `config`, `service`, `rescan`, `hook
//! edit-guard`, `help` and `--version`. The exit codes are the TS ones: 0 ok, 1 failed, 2 usage
//! (and `service status` 3 = not running).
//!
//! `run` (TD-211, wired in MR-T15): config from the environment and `<root>`, the outcome + permission
//! MCP server on 127.0.0.1, the real ADR-0005 CLI driver, the daemon core, and signals
//! (`platform::signals`). A fatal close (4001, 4003, 4005) exits 78 (`EXIT_FATAL_AUTH`), which the
//! service units don't restart; under launchd the job is booted out first. Exit 75 (restart for an
//! update) belongs to the ADR-0021 updater, MR-T14.

use clap::{Parser, Subcommand};
use conductor_daemon::claude::cli_driver::{
    CliDriverOptions, create_cli_driver, default_claude_bin, probe_permission_prompts,
};
use conductor_daemon::claude::edit_guard::{EDIT_GUARD_SUBCOMMAND, run_edit_guard_hook};
use conductor_daemon::claude::outcome_server::{OutcomeServerOptions, start_outcome_server};
use conductor_daemon::commands::config::{CONFIG_USAGE, config_command};
use conductor_daemon::commands::enroll::{ENROLL_TOKEN_ENV, ENROLL_USAGE, run_enroll};
use conductor_daemon::commands::service::{
    SERVICE_USAGE, run_service_command, stop_supervised_job,
};
use conductor_daemon::commands::{Output, StdOutput};
use conductor_daemon::config::{
    Env, daemon_version, load_config, machine_facts, process_env, root_dir_from,
};
use conductor_daemon::daemon::{Daemon, DaemonOptions};
use conductor_daemon::inventory::report::{request_rescan, rescan_trigger_path};
use conductor_daemon::platform::machine;
use conductor_daemon::platform::signals::{self, ProcessSignal};
use conductor_daemon::platform::spawn::{
    CliOptions, StdioKind, exec_file_cli, native_exe_problem, spawn_cli,
};
use conductor_daemon::ws_client::fatal_exit_code;
use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

/// Every argument after the subcommand, handed as-is to the ported TS parsers so their messages
/// and exit codes stay the same.
#[derive(Debug, clap::Args)]
struct Rest {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

#[derive(Debug, Parser)]
#[command(
    name = "conductor-daemon",
    disable_help_flag = true,
    disable_help_subcommand = true,
    disable_version_flag = true
)]
struct Cli {
    /// Print the daemon version (ADR-0021 staging runs `<staging>/bin/conductor-daemon --version`).
    #[arg(long)]
    version: bool,
    /// `-h` / `--help`.
    #[arg(short = 'h', long = "help")]
    help: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(disable_help_flag = true)]
    Run(Rest),
    #[command(disable_help_flag = true)]
    Enroll(Rest),
    #[command(disable_help_flag = true)]
    Config(Rest),
    #[command(disable_help_flag = true)]
    Service(Rest),
    /// Ask the running daemon to rescan its inventory now (`<root>/state/rescan`).
    #[command(disable_help_flag = true)]
    Rescan,
    #[command(disable_help_flag = true)]
    Hook {
        name: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<OsString>,
    },
    #[command(disable_help_flag = true)]
    Help,
}

fn usage() -> String {
    let mut lines = vec!["usage: conductor-daemon [run]".to_string()];
    let strip = |l: &str| {
        l.strip_prefix("usage: ")
            .unwrap_or(l.trim_start())
            .to_string()
    };
    lines.push(format!(
        "       {}",
        ENROLL_USAGE.replacen("usage: ", "", 1)
    ));
    lines.extend(CONFIG_USAGE.lines().map(|l| format!("       {}", strip(l))));
    lines.push(format!("       {}", strip(SERVICE_USAGE)));
    lines.push("       conductor-daemon rescan".into());
    lines.push("       conductor-daemon --version".into());
    lines.join("\n")
}

fn dispatch(args: Vec<OsString>, env: &mut Env, io: &mut dyn Output) -> i32 {
    let first = args
        .first()
        .map(|a| a.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cli = match Cli::try_parse_from(
        std::iter::once(OsString::from("conductor-daemon")).chain(args),
    ) {
        Ok(c) => c,
        Err(_) => {
            io.err(&format!("unknown command: {first}\n{}", usage()));
            return 2;
        }
    };
    if cli.help {
        io.out(&usage());
        return 0;
    }
    if cli.version {
        io.out(&daemon_version(env));
        return 0;
    }
    match cli.command {
        None | Some(Command::Run(_)) => run(env),
        Some(Command::Enroll(r)) => run_enroll(&r.args, env, io),
        Some(Command::Config(r)) => config_command(&r.args, env, &machine::home_dir(), io),
        Some(Command::Service(r)) => run_service_command(&r.args, env, io),
        Some(Command::Rescan) => {
            let root = root_dir_from(env, &machine::home_dir());
            match request_rescan(&root) {
                Ok(()) => {
                    io.out(&format!(
                        "rescan requested ({}); a running daemon picks it up within seconds",
                        rescan_trigger_path(&root).display()
                    ));
                    0
                }
                Err(e) => {
                    io.err(&format!("rescan: {e}"));
                    1
                }
            }
        }
        Some(Command::Hook { name, args }) if name == EDIT_GUARD_SUBCOMMAND[1] => {
            run_edit_guard_hook(
                &args,
                &mut std::io::stdin().lock(),
                &mut std::io::stderr().lock(),
            )
        }
        Some(Command::Hook { name, .. }) => {
            io.err(&format!("unknown hook: {name}"));
            2
        }
        Some(Command::Help) => {
            io.out(&usage());
            0
        }
    }
}

fn log(msg: &str) {
    eprintln!("[conductor-daemon] {msg}");
}

/// `claude --version` → "2.1.308", or None when the CLI is missing or not native (U-015, U-110).
async fn claude_code_version(bin: &str) -> Option<String> {
    let env = conductor_daemon::platform::spawn::process_env();
    if let Some(problem) = native_exe_problem(bin, &env, None) {
        log(&problem);
        return None;
    }
    let opts = CliOptions {
        timeout: Some(Duration::from_secs(10)),
        ..CliOptions::default()
    };
    let out = exec_file_cli(bin, &["--version".to_string()], opts)
        .await
        .ok()?;
    if !out.output.status.success() || out.timed_out {
        return None;
    }
    parse_claude_version(&String::from_utf8_lossy(&out.output.stdout))
}

/// The first `\d+.\d+.\d+` in `claude --version`'s output, else the trimmed output (None if empty).
fn parse_claude_version(stdout: &str) -> Option<String> {
    let found = stdout
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|w| {
            let parts: Vec<&str> = w.split('.').collect();
            parts.len() >= 3 && parts[..3].iter().all(|p| !p.is_empty())
        });
    match found {
        Some(w) => Some(w.split('.').take(3).collect::<Vec<_>>().join(".")),
        None => Some(stdout.trim().to_string()).filter(|s| !s.is_empty()),
    }
}

/// The `run` subcommand: the daemon until a signal (exit 0) or a fatal close (78).
fn run(env: &Env) -> i32 {
    let config = match load_config(env, &machine_facts()) {
        Ok(c) => c,
        Err(e) => {
            log(&format!("fatal: {e}"));
            return 1;
        }
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log(&format!("fatal: cannot start the async runtime: {e}"));
            return 1;
        }
    };
    let code = rt.block_on(async move {
        let outcome_server = match start_outcome_server(OutcomeServerOptions::default()).await {
            Ok(s) => Arc::new(s),
            Err(e) => {
                log(&format!("fatal: cannot start the outcome server: {e}"));
                return 1;
            }
        };
        let claude_bin = default_claude_bin();
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
        let mut driver_opts = CliDriverOptions::new(outcome_server.clone());
        driver_opts.kill_grace = Some(Duration::from_millis(config.kill_grace_ms));
        driver_opts.end_grace = Some(Duration::from_millis(config.end_grace_ms));
        driver_opts.permission_prompts = Some(prompts.supported);
        let driver = Arc::new(create_cli_driver(driver_opts));

        let (fatal_tx, mut fatal_rx) = tokio::sync::mpsc::unbounded_channel::<u16>();
        let mut opts = DaemonOptions::new(config.clone(), driver);
        opts.claude_code_version = claude_code_version(&claude_bin).await;
        opts.claude_bin = Some(claude_bin);
        // Revoked, unauthorized or protocol too old: the daemon already logged why.
        opts.on_fatal = Some(Arc::new(move |code: u16, _why: &str| {
            let _ = fatal_tx.send(code);
        }));
        let daemon = match Daemon::new(opts) {
            Ok(d) => d,
            Err(e) => {
                log(&format!("fatal: {e}"));
                outcome_server.close().await;
                return 1;
            }
        };
        // TD-077: Claude Code treats any `.claude` directory as protected config.
        if config
            .root_dir
            .components()
            .any(|c| c.as_os_str() == ".claude")
        {
            log(&format!(
                "WARNING: CONDUCTOR_ROOT ({}) is inside a .claude directory; Claude Code will deny \
                 agent file writes there. Use a root outside .claude (default ~/.conductor).",
                config.root_dir.display()
            ));
        }
        let mut sigs = signals::listen(log);
        daemon.start();
        log(&format!(
            "{} → {} (root {}, {})",
            config.machine_id,
            config.orchestrator_url,
            config.root_dir.display(),
            if config.credential.is_some() { "enrolled" } else { "local mode" }
        ));
        let code = loop {
            tokio::select! {
                s = sigs.recv() => match s {
                    Some(ProcessSignal::Rescan) => daemon.rescan_inventory().await,
                    Some(ProcessSignal::Stop) | None => break 0,
                },
                Some(close) = fatal_rx.recv() => {
                    // TD-119: under launchd, boot the job out so KeepAlive doesn't restart a
                    // revoked machine (the bootout's SIGTERM is ignored: we are already exiting).
                    stop_supervised_job(env, machine::current_uid(), &mut |bin, args| {
                        let opts = CliOptions {
                            detached: true,
                            stdin: Some(StdioKind::Null),
                            stdout: Some(StdioKind::Null),
                            stderr: Some(StdioKind::Null),
                            ..CliOptions::default()
                        };
                        if let Err(e) = spawn_cli(bin, args, opts) {
                            log(&format!("{bin}: {e}"));
                        }
                    });
                    break fatal_exit_code(close);
                }
            }
        };
        daemon.stop(true);
        outcome_server.close().await;
        // Give killed children a moment to exit before the process does.
        tokio::time::sleep(Duration::from_millis(config.kill_grace_ms)).await;
        code
    });
    rt.shutdown_timeout(Duration::from_secs(1));
    code
}

fn main() {
    let mut env = process_env();
    // TD-117: the enrollment token never reaches a child process. `enroll` takes it from `env`
    // (and removes it there); this removes it from the process's own environment.
    // SAFETY: first thing in `main`, before any thread (or the tokio runtime) exists, so nothing
    // reads the environment concurrently.
    unsafe { std::env::remove_var(ENROLL_TOKEN_ENV) };
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let code = dispatch(args, &mut env, &mut StdOutput);
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::parse_claude_version;

    #[test]
    fn claude_version_is_the_first_semver_else_the_output() {
        assert_eq!(
            parse_claude_version("2.1.308 (Claude Code)\n").as_deref(),
            Some("2.1.308")
        );
        assert_eq!(parse_claude_version("v10.2.3.4").as_deref(), Some("10.2.3"));
        assert_eq!(
            parse_claude_version(" nightly \n").as_deref(),
            Some("nightly")
        );
        assert_eq!(parse_claude_version("  \n"), None);
    }
}
