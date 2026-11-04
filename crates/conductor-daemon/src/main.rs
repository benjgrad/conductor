//! The `conductor-daemon` binary (port of `packages/daemon/src/main.ts`; MR-T13a): the clap CLI
//! and its subcommands `run` (default), `enroll`, `config`, `service`, `rescan`, `hook
//! edit-guard`, `help` and `--version`. The exit codes are the TS ones: 0 ok, 1 failed, 2 usage
//! (and `service status` 3 = not running). `run` (MR-T13b, `commands::run`) exits 0 on a signal,
//! 78 when the link fails for good, 1 when the daemon can't start.

use clap::{Parser, Subcommand};
use conductor_daemon::claude::edit_guard::{EDIT_GUARD_SUBCOMMAND, run_edit_guard_hook};
use conductor_daemon::commands::config::{CONFIG_USAGE, config_command};
use conductor_daemon::commands::enroll::{ENROLL_TOKEN_ENV, ENROLL_USAGE, run_enroll};
use conductor_daemon::commands::run::{RunDeps, run_daemon};
use conductor_daemon::commands::service::{SERVICE_USAGE, run_service_command};
use conductor_daemon::commands::{Output, StdOutput};
use conductor_daemon::config::{Env, daemon_version, process_env, root_dir_from};
use conductor_daemon::inventory::report::{request_rescan, rescan_trigger_path};
use conductor_daemon::platform::machine;
use conductor_daemon::platform::signals::daemon_signals;
use std::ffi::OsString;

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
        // As TS, anything after `run` is ignored.
        None | Some(Command::Run(_)) => run(env, io),
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

/// `run`: the daemon on a multi-thread runtime until a signal or a fatal close.
fn run(env: &Env, io: &mut dyn Output) -> i32 {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            io.err(&format!("cannot start the runtime: {e}"));
            return 1;
        }
    };
    let code = rt.block_on(async {
        let signals = match daemon_signals() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[conductor-daemon] cannot listen for signals: {e}");
                return 1;
            }
        };
        run_daemon(env, RunDeps::new(signals, machine::current_uid())).await
    });
    // Don't wait for blocking tasks (a probe, a git) still running: the process exits now.
    rt.shutdown_background();
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
