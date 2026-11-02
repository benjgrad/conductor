//! The `conductor-daemon` binary: `run`, `enroll`, `config`, `service`, `hook` (MR-T13).

fn main() {
    // MR-T08: only `hook edit-guard <worktree>` for now, so the edit guard's tests can run the real
    // executable as Claude Code does. MR-T13 replaces this with the clap CLI (and keeps calling
    // `run_edit_guard_hook`).
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let guard = conductor_daemon::claude::edit_guard::EDIT_GUARD_SUBCOMMAND;
    if args.len() >= 2 && args[0] == guard[0] && args[1] == guard[1] {
        let code = conductor_daemon::claude::edit_guard::run_edit_guard_hook(
            &args[2..],
            &mut std::io::stdin().lock(),
            &mut std::io::stderr().lock(),
        );
        std::process::exit(code);
    }
}
