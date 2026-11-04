//! See the crate docs (`lib.rs`): runs the program its sidecar names, with its own args appended.

use std::process::{Command, ExitCode};

use conductor_e2e_launcher::{parse_sidecar, sidecar_path};

/// What a launcher that can't start its program exits with (as a shell's "command not found").
const LAUNCH_FAILED: u8 = 127;

fn main() -> ExitCode {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return fail(&format!("cannot locate the launcher: {e}")),
    };
    let sidecar = sidecar_path(&exe);
    let text = match std::fs::read_to_string(&sidecar) {
        Ok(t) => t,
        Err(e) => return fail(&format!("cannot read {}: {e}", sidecar.display())),
    };
    let (program, prefix) = match parse_sidecar(&text) {
        Ok(v) => v,
        Err(e) => return fail(&format!("{}: {e}", sidecar.display())),
    };
    // stdio and env are inherited (Command's defaults for status()).
    match Command::new(&program)
        .args(prefix)
        .args(std::env::args_os().skip(1))
        .status()
    {
        // The child's full code; one killed without a code (a POSIX signal) reports 1, as a
        // terminated Windows process does.
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => fail(&format!("cannot run {}: {e}", program.to_string_lossy())),
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("conductor-e2e-launcher: {msg}");
    ExitCode::from(LAUNCH_FAILED)
}
