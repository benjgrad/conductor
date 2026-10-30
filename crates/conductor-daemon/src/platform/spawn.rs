//! Port of `packages/daemon/src/platform/spawn.ts` (MR-T04). ADR-0024 §1: run a CLI (`claude`,
//! `gh`, `git`, `az`) without a shell on every OS.
//!
//! POSIX: the program as given, through PATH. `detached` starts it in a new session (`setsid`, what
//! Node's `detached: true` does), so it leads its own process group, which `kill_tree` signals.
//!
//! Windows:
//! - `bin` is resolved through PATH and PATHEXT here, never by the OS: a bare-name lookup may search
//!   the child's cwd, which is usually an agent-writable worktree (a planted `git.exe` would run).
//!   PATH entries that are relative are skipped for the same reason.
//! - An `.exe`/`.com` is spawned directly by its absolute path.
//! - Anything else (`az.cmd`, test fakes; U-110: never npm's `claude.cmd`) runs as
//!   `cmd.exe /d /v:off /s /c "<line>"` with verbatim arguments. AutoRun and delayed expansion are
//!   off, and the batch file's own bare-name lookups skip the cwd
//!   (NoDefaultCurrentDirectoryInExePath). The line is escaped like cross-spawn does (plus `:`,
//!   see CMD_META), and the metacharacters are always escaped twice: every batch file we run
//!   forwards `%*` to a real program, and `%*` is parsed a second time by cmd.
//! - cmd.exe can't carry CR/LF/NUL inside an argument (a newline ends the command), so such an
//!   argument is refused with an error rather than truncated or reinterpreted.
//! - Always `CREATE_NO_WINDOW` (Node's `windowsHide`); never detached; never a shell.
//! - Every `spawn_cli` child starts suspended, is put in its own kill-on-close Job Object, then
//!   resumed (MR-T01 finding 6: assignment after the start lets cmd start node outside the job).
//!   `kill_tree` terminates the job, which takes reparented grandchildren with it (U-116). When
//!   the job can't be made or assigned the child still runs, and `kill_tree` falls back to
//!   `taskkill /T /F`.

use super::{Platform, win_path};
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{ExitStatus, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

/// An environment, in order. Lookups by name are case-insensitive on Windows ([`env_get`]).
pub type Env = Vec<(String, String)>;

const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// cross-spawn's set (cmd.exe metacharacters plus space, which separates tokens, and `"`) plus
/// `:`. Percent expansion runs before caret removal, and a variable name ends at `:`, so an
/// unescaped `%PATH:a=b%` or `%SECRET:~0%` would expand (substitution syntax) and paste env values
/// into argv. With `:` caret-escaped the name always ends in `^` (`PATH^^^`), which no variable is
/// called, and cmd leaves an undefined `%…%` span as typed.
const CMD_META: &[char] = &[
    '(', ')', ']', '[', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?', ':',
];

/// cmd.exe's command-line limit (characters), `/d /v:off /s /c "…"` included.
pub const CMD_MAX_LINE: usize = 8191;

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    /// The program can't be found (Node's `ENOENT`). The same on every OS.
    #[error("spawn {bin} ENOENT")]
    NotFound { bin: String, args: Vec<String> },
    /// An argument cmd.exe can't carry, or a line over its limit (`ERR_CMD_UNSAFE_ARG`).
    #[error("{0}")]
    CmdUnsafeArg(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl SpawnError {
    /// The Node error code callers match on.
    pub fn code(&self) -> &'static str {
        match self {
            SpawnError::NotFound { .. } => "ENOENT",
            SpawnError::CmdUnsafeArg(_) => "ERR_CMD_UNSAFE_ARG",
            SpawnError::Io(e) if e.kind() == io::ErrorKind::TimedOut => "ETIMEDOUT",
            SpawnError::Io(_) => "EIO",
        }
    }
}

/// One stdio stream of the child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioKind {
    Inherit,
    Piped,
    Null,
}

impl StdioKind {
    fn to_stdio(self) -> Stdio {
        match self {
            StdioKind::Inherit => Stdio::inherit(),
            StdioKind::Piped => Stdio::piped(),
            StdioKind::Null => Stdio::null(),
        }
    }
}

/// `spawn` options minus `shell`, which is never allowed.
#[derive(Debug, Clone, Default)]
pub struct CliOptions {
    pub cwd: Option<PathBuf>,
    /// None: inherit this process's environment. Some: exactly this environment.
    pub env: Option<Env>,
    /// POSIX: a new session and process group (Node `detached`). Ignored on Windows.
    pub detached: bool,
    /// None: the call's default (spawn: inherit; exec: stdin null, stdout and stderr piped).
    pub stdin: Option<StdioKind>,
    pub stdout: Option<StdioKind>,
    pub stderr: Option<StdioKind>,
    /// `exec_file_cli*` only: kill the child (its tree, for the async one) after this long.
    pub timeout: Option<Duration>,
}

/// What to hand to the OS: the resolved program, its argv and the adjusted options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedCli {
    pub file: String,
    pub args: Vec<String>,
    /// Windows: pass `args` as they are, unquoted (Node's `windowsVerbatimArguments`).
    pub verbatim: bool,
    /// Windows: no console window (Node's `windowsHide`).
    pub hide: bool,
    pub detached: bool,
    /// Added on top of the options' (or the inherited) environment.
    pub extra_env: Env,
}

/// Case-insensitive env lookup (Windows env names are), first match wins.
pub fn env_get<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// This process's environment, in the order the OS gives it.
pub fn process_env() -> Env {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// `%SystemRoot%\System32\<exe>`: system tools are never looked up through PATH or the cwd.
pub fn system32(exe: &str, env: &[(String, String)]) -> String {
    let root = env_get(env, "SystemRoot")
        .or_else(|| env_get(env, "windir"))
        .unwrap_or("C:\\Windows");
    win_path::join(&[root, "System32", exe])
}

/// `is_file` backed by the real file system.
pub fn real_is_file(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// Resolve a Windows command name to an absolute file, like cmd.exe would but without the cwd:
/// - a name with a directory part (`.\x`, `C:\x\y`) resolves against `cwd` only;
/// - a bare name is searched in the absolute PATH entries, in order;
/// - a name whose extension is in PATHEXT is tried as-is, otherwise each PATHEXT extension is
///   appended in order.
///
/// None when nothing matches. Pure given `is_file`.
pub fn resolve_windows_bin(
    bin: &str,
    env: &[(String, String)],
    cwd: Option<&str>,
    is_file: &dyn Fn(&str) -> bool,
) -> Option<String> {
    let exts: Vec<String> = env_get(env, "PATHEXT")
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(|e| e.trim().to_lowercase()) // the file system ignores case; lower reads better
        .filter(|e| e.starts_with('.'))
        .collect();
    let ext = win_path::extname(bin).to_lowercase();
    let candidates = |base: &str| -> Vec<String> {
        if !ext.is_empty() && exts.contains(&ext) {
            vec![base.to_string()]
        } else {
            exts.iter().map(|e| format!("{base}{e}")).collect()
        }
    };

    if bin.contains(['\\', '/']) || win_path::is_absolute(bin) {
        let base = win_path::resolve(cwd.unwrap_or(""), bin);
        return candidates(&base).into_iter().find(|c| is_file(c));
    }
    for raw in env_get(env, "PATH").unwrap_or("").split(';') {
        let dir = raw.trim();
        let dir = if dir.len() >= 2 && dir.starts_with('"') && dir.ends_with('"') {
            &dir[1..dir.len() - 1]
        } else {
            dir
        };
        if dir.is_empty() || !win_path::is_absolute(dir) {
            continue;
        }
        if let Some(hit) = candidates(&win_path::join(&[dir, bin]))
            .into_iter()
            .find(|c| is_file(c))
        {
            return Some(hit);
        }
    }
    None
}

fn caret_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if CMD_META.contains(&c) {
            out.push('^');
        }
        out.push(c);
    }
    out
}

/// cross-spawn's `escapeCommand`: caret-escape the program path (it is not quoted).
pub fn escape_cmd_command(file: &str) -> String {
    caret_escape(file)
}

/// Quote one argument for the program's own (MSVCRT / CommandLineToArgvW) parser, then
/// caret-escape every cmd metacharacter, including the quotes, twice (see the header): once for
/// `cmd /c` and once for the batch file's `%*`.
pub fn escape_cmd_arg(arg: &str) -> Result<String, SpawnError> {
    if arg.contains(['\r', '\n', '\0']) {
        return Err(SpawnError::CmdUnsafeArg(
            "spawnCli: an argument for a .cmd/.bat contains CR, LF or NUL".to_string(),
        ));
    }
    // Backslashes before a quote are doubled and the quote escaped; trailing backslashes are
    // doubled (the closing quote follows them).
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    Ok(caret_escape(&caret_escape(&quoted)))
}

/// The `/c` payload for running `file args…` through cmd.exe. Pure. Errs with
/// [`SpawnError::CmdUnsafeArg`] when the whole cmd.exe line would exceed [`CMD_MAX_LINE`], rather
/// than let cmd fail with a generic error (TD-192).
pub fn build_cmd_line(file: &str, args: &[String]) -> Result<String, SpawnError> {
    let mut parts = vec![escape_cmd_command(&win_path::normalize(file))];
    for a in args {
        parts.push(escape_cmd_arg(a)?);
    }
    let line = parts.join(" ");
    // + `cmd.exe /d /v:off /s /c "` and the closing quote.
    if line.encode_utf16().count() + "cmd.exe /d /v:off /s /c \"\"".len() > CMD_MAX_LINE {
        return Err(SpawnError::CmdUnsafeArg(format!(
            "spawnCli: the command line for {file} is over {CMD_MAX_LINE} characters"
        )));
    }
    Ok(line)
}

fn is_direct_exec(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    lower.ends_with(".exe") || lower.ends_with(".com")
}

/// Work out what to spawn. `Ok(None)` on Windows when `bin` doesn't resolve (the caller reports
/// ENOENT). Errs for an argument cmd.exe can't carry. Pure given `platform` and `is_file`.
pub fn prepare_cli(
    bin: &str,
    args: &[String],
    opts: &CliOptions,
    platform: Platform,
    is_file: &dyn Fn(&str) -> bool,
) -> Result<Option<PreparedCli>, SpawnError> {
    if platform == Platform::Posix {
        return Ok(Some(PreparedCli {
            file: bin.to_string(),
            args: args.to_vec(),
            verbatim: false,
            hide: false,
            detached: opts.detached,
            extra_env: Vec::new(),
        }));
    }
    let inherited;
    let env: &[(String, String)] = match &opts.env {
        Some(e) => e,
        None => {
            inherited = process_env();
            &inherited
        }
    };
    let cwd = opts.cwd.as_ref().map(|c| c.to_string_lossy().into_owned());
    let Some(file) = resolve_windows_bin(bin, env, cwd.as_deref(), is_file) else {
        return Ok(None);
    };
    if is_direct_exec(&file) {
        return Ok(Some(PreparedCli {
            file,
            args: args.to_vec(),
            verbatim: false,
            hide: true,
            detached: false,
            extra_env: Vec::new(),
        }));
    }
    let line = build_cmd_line(&file, args)?;
    Ok(Some(PreparedCli {
        file: system32("cmd.exe", env),
        // /d: no AutoRun; /v:off: no `!VAR!` delayed expansion whatever the registry says.
        args: ["/d", "/v:off", "/s", "/c"]
            .iter()
            .map(|s| s.to_string())
            .chain([format!("\"{line}\"")])
            .collect(),
        verbatim: true,
        hide: true,
        detached: false,
        // The batch file runs bare names (`node`, `python`), and cmd looks in the cwd before PATH
        // unless this is set: same hijack as above, one level down.
        extra_env: vec![("NoDefaultCurrentDirectoryInExePath".into(), "1".into())],
    }))
}

fn prepare_here(bin: &str, args: &[String], opts: &CliOptions) -> Result<PreparedCli, SpawnError> {
    prepare_cli(bin, args, opts, Platform::current(), &real_is_file)?.ok_or_else(|| {
        SpawnError::NotFound {
            bin: bin.to_string(),
            args: args.to_vec(),
        }
    })
}

/// Map a spawn failure: a missing program is [`SpawnError::NotFound`] on every OS.
fn spawn_failed(e: io::Error, bin: &str, args: &[String]) -> SpawnError {
    if e.kind() == io::ErrorKind::NotFound {
        SpawnError::NotFound {
            bin: bin.to_string(),
            args: args.to_vec(),
        }
    } else {
        SpawnError::Io(e)
    }
}

/// A std `Command` for a prepared CLI, without its stdio.
fn std_command(p: &PreparedCli, opts: &CliOptions) -> std::process::Command {
    let mut cmd = std::process::Command::new(&p.file);
    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &opts.env {
        cmd.env_clear();
        cmd.envs(env.iter().map(|(k, v)| (k, v)));
    }
    cmd.envs(p.extra_env.iter().map(|(k, v)| (k, v)));
    imp::configure(&mut cmd, p);
    cmd
}

/// A spawned child's tree: what `kill_tree` needs, cheap to clone and to hand to another task.
///
/// Windows: holds the child's kill-on-close Job Object. **When the last clone is dropped the job
/// handle closes and the OS kills the whole tree** (as it does when the daemon dies), so keep one
/// for as long as the child is meant to run.
#[derive(Debug, Clone)]
pub struct TreeHandle {
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    pub(crate) job: Option<Arc<imp::Job>>,
}

impl TreeHandle {
    /// A tree for a bare pid we did not spawn (no job, never marked exited).
    pub fn for_pid(pid: u32) -> Self {
        TreeHandle {
            pid: Some(pid),
            exited: Arc::new(AtomicBool::new(false)),
            job: None,
        }
    }

    /// A child that never spawned: `kill_tree` ignores it.
    pub fn never_spawned() -> Self {
        TreeHandle {
            pid: None,
            exited: Arc::new(AtomicBool::new(true)),
            job: None,
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Has the root process been reaped (its pid may now be someone else's)?
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// Record that the root process was reaped. [`CliChild::wait`] does it.
    pub fn mark_exited(&self) {
        self.exited.store(true, Ordering::SeqCst);
    }

    /// Windows: is the child in its own Job Object (so `kill_tree` needs no taskkill)?
    pub fn has_job(&self) -> bool {
        self.job.is_some()
    }
}

/// A child started by [`spawn_cli`].
#[derive(Debug)]
pub struct CliChild {
    pub child: tokio::process::Child,
    pub tree: TreeHandle,
}

impl CliChild {
    pub fn pid(&self) -> Option<u32> {
        self.tree.pid()
    }

    /// Wait for the child, then mark its tree exited.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait().await;
        self.tree.mark_exited();
        status
    }
}

/// `child_process.spawn` for a CLI, safe on every OS (see the header). A program that can't be
/// found fails the same way on every OS: [`SpawnError::NotFound`]. Needs a tokio runtime.
pub fn spawn_cli(bin: &str, args: &[String], opts: CliOptions) -> Result<CliChild, SpawnError> {
    let p = prepare_here(bin, args, &opts)?;
    let mut std_cmd = std_command(&p, &opts);
    std_cmd.stdin(opts.stdin.unwrap_or(StdioKind::Inherit).to_stdio());
    std_cmd.stdout(opts.stdout.unwrap_or(StdioKind::Inherit).to_stdio());
    std_cmd.stderr(opts.stderr.unwrap_or(StdioKind::Inherit).to_stdio());
    let mut cmd = tokio::process::Command::from(std_cmd);
    imp::configure_async(&mut cmd, &p);
    let child = cmd.spawn().map_err(|e| spawn_failed(e, bin, args))?;
    let pid = child.id();
    let job = imp::after_spawn(&child)?;
    Ok(CliChild {
        child,
        tree: TreeHandle {
            pid,
            exited: Arc::new(AtomicBool::new(false)),
            job,
        },
    })
}

/// Run `cmd` to completion with stdin null and stdout/stderr captured; kill it after `timeout`
/// (an `ErrorKind::TimedOut` error).
pub(crate) fn output_with_timeout(
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> io::Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let drain = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let err = drain(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// `child_process.execFileSync` for a CLI, with `spawn_cli`'s resolution and escaping (no Job
/// Object: for short-lived tools). Stdin is null and the output captured unless the options say
/// otherwise; with `opts.timeout` the child is killed at the deadline (`ErrorKind::TimedOut`).
pub fn exec_file_cli_sync(
    bin: &str,
    args: &[String],
    opts: &CliOptions,
) -> Result<Output, SpawnError> {
    let p = prepare_here(bin, args, opts)?;
    let mut cmd = std_command(&p, opts);
    if let Some(t) = opts.timeout {
        return output_with_timeout(&mut cmd, t).map_err(|e| spawn_failed(e, bin, args));
    }
    cmd.stdin(opts.stdin.unwrap_or(StdioKind::Null).to_stdio());
    cmd.stdout(opts.stdout.unwrap_or(StdioKind::Piped).to_stdio());
    cmd.stderr(opts.stderr.unwrap_or(StdioKind::Piped).to_stdio());
    cmd.output().map_err(|e| spawn_failed(e, bin, args))
}

/// What [`exec_file_cli`] returns.
#[derive(Debug)]
pub struct CliOutput {
    pub output: Output,
    /// The timeout fired and the tree was killed.
    pub timed_out: bool,
}

/// `child_process.execFile` for a CLI: [`spawn_cli`] with stdin null and the output captured.
/// With `opts.timeout` the whole tree is killed (SIGKILL) at the deadline.
pub async fn exec_file_cli(
    bin: &str,
    args: &[String],
    opts: CliOptions,
) -> Result<CliOutput, SpawnError> {
    let timeout = opts.timeout;
    let opts = CliOptions {
        stdin: Some(opts.stdin.unwrap_or(StdioKind::Null)),
        stdout: Some(StdioKind::Piped),
        stderr: Some(StdioKind::Piped),
        ..opts
    };
    let mut child = spawn_cli(bin, args, opts)?;
    type Stream = Box<dyn tokio::io::AsyncRead + Send + Unpin>;
    let read = |s: Option<Stream>| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut s) = s {
                let _ = s.read_to_end(&mut buf).await;
            }
            buf
        })
    };
    let out = read(child.child.stdout.take().map(|s| Box::new(s) as Stream));
    let err = read(child.child.stderr.take().map(|s| Box::new(s) as Stream));
    let mut timed_out = false;
    let status = match timeout {
        None => child.wait().await?,
        Some(t) => match tokio::time::timeout(t, child.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                timed_out = true;
                let tree = child.tree.clone();
                if let Ok(h) = super::kill_tree::kill_tree(
                    super::kill_tree::KillTarget::Child(&tree),
                    super::kill_tree::KillTreeOptions {
                        signal: Some(super::kill_tree::Signal::Kill),
                        grace: None,
                    },
                ) {
                    h.settled().await;
                }
                child.wait().await?
            }
        },
    };
    Ok(CliOutput {
        output: Output {
            status,
            stdout: out.await.unwrap_or_default(),
            stderr: err.await.unwrap_or_default(),
        },
        timed_out,
    })
}

/// Whether `bin` (a bare name) would be found on `path_value`: POSIX, a regular file with an exec
/// bit in some PATH dir; Windows, what `spawn_cli` would resolve (absolute PATH dirs × PATHEXT).
pub fn is_on_path(bin: &str, path_value: &str, env: &[(String, String)]) -> bool {
    match Platform::current() {
        Platform::Windows => {
            let mut lookup: Env = vec![("PATH".into(), path_value.into())];
            if let Some(ext) = env_get(env, "PATHEXT") {
                lookup.push(("PATHEXT".into(), ext.into()));
            }
            resolve_windows_bin(bin, &lookup, None, &real_is_file).is_some()
        }
        Platform::Posix => path_value
            .split(':')
            .filter(|d| !d.is_empty())
            .any(|d| imp::is_executable_file(&std::path::Path::new(d).join(bin))),
    }
}

/// U-110 (Ben): on Windows `claude` must be the native `claude.exe`. npm's `claude.cmd` shim can
/// only be started through cmd.exe, which can't carry the multi-line `--append-system-prompt`.
/// A message when `bin` resolves to something other than an `.exe`/`.com`; None when it is fine,
/// when it doesn't resolve at all (the spawn reports ENOENT), and always on POSIX.
pub fn native_exe_problem_for(
    bin: &str,
    env: &[(String, String)],
    cwd: Option<&str>,
    platform: Platform,
    is_file: &dyn Fn(&str) -> bool,
) -> Option<String> {
    if platform == Platform::Posix {
        return None;
    }
    let file = resolve_windows_bin(bin, env, cwd, is_file)?;
    if is_direct_exec(&file) {
        return None;
    }
    Some(format!(
        "{bin} resolves to {file}, not a native .exe: conductor needs the native Claude Code \
         (claude.exe) on Windows. Install it with the native installer \
         (https://docs.anthropic.com/en/docs/claude-code/setup) or point CONDUCTOR_CLAUDE_BIN at claude.exe"
    ))
}

/// [`native_exe_problem_for`] on this OS and file system.
pub fn native_exe_problem(
    bin: &str,
    env: &[(String, String)],
    cwd: Option<&str>,
) -> Option<String> {
    native_exe_problem_for(bin, env, cwd, Platform::current(), &real_is_file)
}

#[cfg(unix)]
pub(crate) mod imp {
    use super::PreparedCli;
    use std::io;
    use std::os::unix::process::CommandExt;

    /// Never constructed on POSIX: process groups do the job.
    #[derive(Debug)]
    pub struct Job;

    pub fn configure(cmd: &mut std::process::Command, p: &PreparedCli) {
        cmd.args(&p.args);
        if p.detached {
            // Node's `detached: true`: a new session, so the child leads its own process group
            // and has no controlling terminal (a tty read can't stop it).
            // SAFETY: setsid is async-signal-safe and touches no memory of the parent.
            unsafe {
                cmd.pre_exec(|| nix::unistd::setsid().map(|_| ()).map_err(io::Error::from));
            }
        }
    }

    pub fn configure_async(_cmd: &mut tokio::process::Command, _p: &PreparedCli) {}

    pub fn after_spawn(
        _child: &tokio::process::Child,
    ) -> Result<Option<std::sync::Arc<Job>>, super::SpawnError> {
        Ok(None)
    }

    pub fn is_executable_file(p: &std::path::Path) -> bool {
        std::fs::metadata(p).is_ok_and(|m| m.is_file())
            && nix::unistd::access(p, nix::unistd::AccessFlags::X_OK).is_ok()
    }
}

#[cfg(windows)]
pub(crate) mod imp {
    use super::{PreparedCli, SpawnError};
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        TerminateProcess,
    };

    /// A kill-on-close Job Object. Closing the handle (Drop) kills every process still in it.
    #[derive(Debug)]
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used and closed from any thread.
    unsafe impl Send for Job {}
    // SAFETY: TerminateJobObject / QueryInformationJobObject are thread-safe.
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: our handle, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Job {
        fn kill_on_close() -> io::Result<Self> {
            // SAFETY: plain Win32 calls; the handle is owned by `Job` as soon as it exists.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        /// Terminate every process in the job (exit code 1, as taskkill leaves).
        pub fn terminate(&self) -> bool {
            // SAFETY: our live job handle.
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }

        /// How many processes are still in the job (None: can't tell).
        pub fn active_processes(&self) -> Option<u32> {
            // SAFETY: an out buffer of the size we pass.
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                );
                (ok != 0).then_some(info.ActiveProcesses)
            }
        }
    }

    pub fn configure(cmd: &mut std::process::Command, p: &PreparedCli) {
        if p.verbatim {
            for a in &p.args {
                cmd.raw_arg(a);
            }
        } else {
            cmd.args(&p.args);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /// `spawn_cli` only: start suspended, so the child is in its job before it runs anything.
    pub fn configure_async(cmd: &mut tokio::process::Command, _p: &PreparedCli) {
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    /// Resume every thread of a suspended `pid` (a new process has exactly one).
    fn resume(pid: u32) -> io::Result<()> {
        // SAFETY: plain Win32 calls; every handle is closed before returning.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut resumed = 0;
            let mut more = Thread32First(snap, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    let t = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !t.is_null() {
                        if ResumeThread(t) != u32::MAX {
                            resumed += 1;
                        }
                        CloseHandle(t);
                    }
                }
                more = Thread32Next(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
            if resumed == 0 {
                return Err(io::Error::other(format!(
                    "could not resume the main thread of pid {pid}"
                )));
            }
            Ok(())
        }
    }

    /// Put the suspended child in a new kill-on-close job, then resume it. A job failure leaves
    /// the child running without one (kill_tree falls back to taskkill); a resume failure kills it.
    pub fn after_spawn(child: &tokio::process::Child) -> Result<Option<Arc<Job>>, SpawnError> {
        let (Some(pid), Some(handle)) = (child.id(), child.raw_handle()) else {
            return Ok(None);
        };
        let job = match Job::kill_on_close() {
            // SAFETY: the child's live process handle and our job handle.
            Ok(job) if unsafe { AssignProcessToJobObject(job.0, handle) } != 0 => {
                Some(Arc::new(job))
            }
            Ok(_) => {
                let e = io::Error::last_os_error();
                tracing::warn!(
                    pid,
                    "cannot put the child in a Job Object ({e}); kill falls back to taskkill /T"
                );
                None
            }
            Err(e) => {
                tracing::warn!(
                    pid,
                    "cannot create a Job Object ({e}); kill falls back to taskkill /T"
                );
                None
            }
        };
        if let Err(e) = resume(pid) {
            // SAFETY: the child's live process handle.
            unsafe { TerminateProcess(handle, 1) };
            return Err(SpawnError::Io(e));
        }
        Ok(job)
    }

    pub fn is_executable_file(p: &std::path::Path) -> bool {
        std::fs::metadata(p).is_ok_and(|m| m.is_file())
    }
}

/// Test helpers shared by the platform tests.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;

    /// The `node` the tests run (on every runner and dev machine).
    pub fn node_bin() -> String {
        let env = process_env();
        let path = env_get(&env, "PATH").unwrap_or("").to_string();
        let delim = Platform::current().path_delimiter();
        for dir in path.split(delim).filter(|d| !d.is_empty()) {
            let cand =
                std::path::Path::new(dir).join(format!("node{}", Platform::current().exe_suffix()));
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
        panic!("node not found on PATH");
    }

    /// The env with PATH replaced (whatever its case) by `dirs` + node's dir.
    pub fn env_with_path(dirs: &[&std::path::Path]) -> Env {
        let node = node_bin();
        let node_dir = std::path::Path::new(&node).parent().unwrap().to_path_buf();
        let mut env: Env = process_env()
            .into_iter()
            .filter(|(k, _)| !k.eq_ignore_ascii_case("path"))
            .collect();
        let mut parts: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        parts.push(node_dir.to_string_lossy().into_owned());
        env.push((
            "PATH".into(),
            parts.join(&Platform::current().path_delimiter().to_string()),
        ));
        env
    }

    pub fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::*;
    use super::*;
    use crate::platform::procinfo::parse_windows_command_line;
    use crate::test_support::fake_bin::write_fake_bin;
    use std::collections::HashSet;

    // Args that break naive quoting: cmd metacharacters, quotes, backslashes before quotes and at
    // the end, percent signs that look like variables, delayed-expansion bangs, unicode, "".
    const NASTY: &[&str] = &[
        "plain",
        "a b",
        "x&y",
        "c^d",
        "%PATH%",
        "%PATH:a=b%",
        "%PATH:~0,3%",
        "%=C:%",
        "%:%",
        "%",
        "q\"uote",
        "q\"&calc",
        "trail\\",
        "back\\\"slash",
        "two\\\\\"q",
        "!bang!",
        "!PATH!",
        "<in>|out",
        "(paren)",
        "",
        " ",
        "semi;colon,comma",
        "`tick`",
        "*?[]",
        "C:\\Program Files\\x y\\",
        "é ü 日本",
    ];

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn files(set: &[&str]) -> impl Fn(&str) -> bool + use<> {
        let set: HashSet<String> = set.iter().map(|s| s.to_string()).collect();
        move |p: &str| set.contains(p)
    }

    // ------------------------------------------------------------ resolve_windows_bin

    const RESOLVE_FILES: &[&str] = &[
        "C:\\npm\\claude.cmd",
        "C:\\npm\\claude.ps1",
        "C:\\bin\\claude.exe",
        "C:\\bin\\claude.cmd",
        "C:\\Git\\cmd\\git.exe",
        "D:\\w\\tools\\run.bat",
        "C:\\Program Files\\Az\\az.cmd",
    ];

    fn resolve_env() -> Env {
        env(&[(
            "Path",
            "rel\\dir;C:\\npm;\"C:\\Program Files\\Az\";;C:\\bin;C:\\Git\\cmd",
        )])
    }

    #[test]
    fn resolve_searches_absolute_path_entries_in_order_with_pathext_order() {
        let f = files(RESOLVE_FILES);
        let e = resolve_env();
        assert_eq!(
            resolve_windows_bin("claude", &e, None, &f).as_deref(),
            Some("C:\\npm\\claude.cmd")
        );
        assert_eq!(
            resolve_windows_bin("git", &e, None, &f).as_deref(),
            Some("C:\\Git\\cmd\\git.exe")
        );
        assert_eq!(
            resolve_windows_bin("az", &e, None, &f).as_deref(),
            Some("C:\\Program Files\\Az\\az.cmd")
        );
    }

    #[test]
    fn resolve_honours_pathext_order_and_an_explicit_extension() {
        let f = files(RESOLVE_FILES);
        // PATH order wins over PATHEXT order; within one dir, PATHEXT order decides.
        assert_eq!(
            resolve_windows_bin("claude", &env(&[("PATH", "C:\\bin")]), None, &f).as_deref(),
            Some("C:\\bin\\claude.exe")
        );
        let cmd_first = env(&[("PATH", "C:\\bin"), ("PATHEXT", ".CMD;.EXE")]);
        assert_eq!(
            resolve_windows_bin("claude", &cmd_first, None, &f).as_deref(),
            Some("C:\\bin\\claude.cmd")
        );
        assert_eq!(
            resolve_windows_bin("claude.exe", &resolve_env(), None, &f).as_deref(),
            Some("C:\\bin\\claude.exe")
        );
        // .ps1 isn't in PATHEXT, so it isn't runnable and gets extensions appended (none match).
        assert_eq!(
            resolve_windows_bin("claude.ps1", &resolve_env(), None, &f),
            None
        );
    }

    #[test]
    fn resolve_never_looks_in_the_cwd_for_a_bare_name_and_skips_relative_path_entries() {
        let f = files(&[
            "D:\\w\\git.exe",
            "D:\\w\\rel\\dir\\gh.exe",
            "rel\\dir\\gh.exe",
        ]);
        assert_eq!(
            resolve_windows_bin("git", &resolve_env(), Some("D:\\w"), &f),
            None
        );
        assert_eq!(
            resolve_windows_bin("gh", &resolve_env(), Some("D:\\w"), &f),
            None
        );
    }

    #[test]
    fn resolve_a_name_with_a_directory_part_against_cwd_only() {
        let f = files(RESOLVE_FILES);
        assert_eq!(
            resolve_windows_bin("tools\\run", &resolve_env(), Some("D:\\w"), &f).as_deref(),
            Some("D:\\w\\tools\\run.bat")
        );
        assert_eq!(
            resolve_windows_bin("C:\\npm\\claude", &[], None, &f).as_deref(),
            Some("C:\\npm\\claude.cmd")
        );
        assert_eq!(
            resolve_windows_bin("C:\\nope\\claude", &resolve_env(), None, &f),
            None
        );
    }

    #[test]
    fn resolve_returns_none_when_nothing_matches() {
        let f = files(RESOLVE_FILES);
        assert_eq!(resolve_windows_bin("nope", &resolve_env(), None, &f), None);
        assert_eq!(resolve_windows_bin("claude", &[], None, &f), None);
    }

    // ------------------------------------------------------------ escaping

    #[test]
    fn escape_cmd_arg_quotes_for_msvcrt_and_caret_escapes_twice() {
        let e = |a: &str| escape_cmd_arg(a).unwrap();
        assert_eq!(e("ab"), "^^^\"ab^^^\"");
        assert_eq!(e("a b"), "^^^\"a^^^ b^^^\"");
        assert_eq!(e("a\"b"), "^^^\"a\\^^^\"b^^^\"");
        assert_eq!(e("x&y"), "^^^\"x^^^&y^^^\"");
        assert_eq!(e("d\\"), "^^^\"d\\\\^^^\"");
        assert_eq!(e(""), "^^^\"^^^\"");
    }

    #[test]
    fn escape_cmd_arg_refuses_cr_lf_and_nul() {
        for a in ["a\nb", "a\rb", "a\0b"] {
            let err = escape_cmd_arg(a).unwrap_err();
            assert!(err.to_string().contains("CR, LF or NUL"), "{err}");
            assert_eq!(err.code(), "ERR_CMD_UNSAFE_ARG");
        }
    }

    /// A model of what cmd.exe does to a line in its special-character phase: outside quotes `^x`
    /// is `x` and `&|<>` would split the command (flagged); inside quotes everything is literal and
    /// `"` toggles. Enough to check the escaping survives two passes (cmd /c, then the `%*`).
    fn cmd_pass(line: &str) -> String {
        let chars: Vec<char> = line.chars().collect();
        let mut out = String::new();
        let mut quoted = false;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '"' {
                quoted = !quoted;
            }
            if !quoted && c == '^' {
                i += 1;
                if let Some(n) = chars.get(i) {
                    out.push(*n);
                }
                i += 1;
                continue;
            }
            assert!(quoted || !"&|<>".contains(c), "unescaped {c} in {line}");
            out.push(c);
            i += 1;
        }
        out
    }

    #[test]
    fn build_cmd_line_refuses_a_line_over_8191_characters() {
        let err = build_cmd_line("C:\\x\\a.cmd", &["a".repeat(9_000)]).unwrap_err();
        assert_eq!(err.code(), "ERR_CMD_UNSAFE_ARG");
        // Quotes double in size once escaped: 2,000 of them is over the limit too.
        let err = build_cmd_line("C:\\x\\a.cmd", &["\"".repeat(2_000)]).unwrap_err();
        assert!(err.to_string().contains("over 8191"));
        assert!(
            build_cmd_line("C:\\x\\a.cmd", &["a".repeat(7_000)])
                .unwrap()
                .contains(&"a".repeat(7_000))
        );
    }

    #[test]
    fn build_cmd_line_delivers_every_nasty_arg_through_cmd_and_a_batch_shim() {
        let file = "C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd";
        let payload = build_cmd_line(file, &strings(NASTY)).unwrap();
        // cmd /d /s /c "<payload>": /s strips the outer quotes, then pass 1.
        let pass1 = cmd_pass(&payload);
        assert_eq!(cmd_pass(&build_cmd_line(file, &[]).unwrap()), file);
        assert!(pass1.starts_with(&format!("{file} ")));
        // The shim runs `node "<script>" %*`: %* is the text after the program, parsed again.
        let pass2 = cmd_pass(&pass1[file.len() + 1..]);
        let argv = parse_windows_command_line(&format!("node.exe script.mjs {pass2}"));
        assert_eq!(argv[2..], strings(NASTY)[..]);
    }

    #[test]
    fn build_cmd_line_caret_escapes_the_program_path() {
        assert_eq!(
            build_cmd_line("C:/Program Files (x86)/a.cmd", &[]).unwrap(),
            "C^:\\Program^ Files^ ^(x86^)\\a.cmd"
        );
    }

    #[test]
    fn escape_leaves_no_percent_span_naming_a_real_variable() {
        for a in [
            "%PATH%",
            "%PATH:a=b%",
            "%PATH:~0,3%",
            "%=C:%",
            "x%PATH%y%HOME:~1%",
        ] {
            let line = escape_cmd_arg(a).unwrap();
            // cmd's percent phase: a name runs from `%` to the next `%` or `:`.
            let mut rest = line.as_str();
            while let Some(i) = rest.find('%') {
                let after = &rest[i + 1..];
                let Some(j) = after.find(['%', ':']) else {
                    break;
                };
                let name = &after[..j];
                assert!(name.is_empty() || name.ends_with('^'), "{name:?} in {line}");
                rest = &after[j..];
            }
        }
    }

    // ------------------------------------------------------------ prepare_cli

    fn win_files() -> impl Fn(&str) -> bool {
        files(&["C:\\bin\\gh.exe", "C:\\npm\\claude.cmd", "C:\\npm\\az.bat"])
    }

    fn win_env() -> Env {
        env(&[("PATH", "C:\\bin;C:\\npm"), ("SystemRoot", "C:\\WINDOWS")])
    }

    #[test]
    fn prepare_posix_spawns_as_given_and_keeps_detached() {
        let opts = CliOptions {
            detached: true,
            cwd: Some("/w".into()),
            ..Default::default()
        };
        let p = prepare_cli(
            "claude",
            &strings(&["-p", "a b"]),
            &opts,
            Platform::Posix,
            &|_| false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            p,
            PreparedCli {
                file: "claude".into(),
                args: strings(&["-p", "a b"]),
                verbatim: false,
                hide: false,
                detached: true,
                extra_env: vec![],
            }
        );
    }

    #[test]
    fn prepare_win32_exe_directly_by_absolute_path_hidden_never_detached() {
        let opts = CliOptions {
            env: Some(win_env()),
            detached: true,
            ..Default::default()
        };
        let p = prepare_cli(
            "gh",
            &strings(&["pr", "view"]),
            &opts,
            Platform::Windows,
            &win_files(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            p,
            PreparedCli {
                file: "C:\\bin\\gh.exe".into(),
                args: strings(&["pr", "view"]),
                verbatim: false,
                hide: true,
                detached: false,
                extra_env: vec![],
            }
        );
    }

    #[test]
    fn prepare_win32_cmd_runs_via_system32_cmd_with_verbatim_arguments() {
        let opts = CliOptions {
            env: Some(win_env()),
            cwd: Some("D:\\w".into()),
            ..Default::default()
        };
        let args = strings(&["--resume", "x&y"]);
        let p = prepare_cli("claude", &args, &opts, Platform::Windows, &win_files())
            .unwrap()
            .unwrap();
        assert_eq!(p.file, "C:\\WINDOWS\\System32\\cmd.exe");
        assert_eq!(p.args[..4], strings(&["/d", "/v:off", "/s", "/c"])[..]);
        assert_eq!(
            p.args[4],
            format!(
                "\"{}\"",
                build_cmd_line("C:\\npm\\claude.cmd", &args).unwrap()
            )
        );
        assert!(p.verbatim && p.hide && !p.detached);
        assert_eq!(
            p.extra_env,
            vec![(
                "NoDefaultCurrentDirectoryInExePath".to_string(),
                "1".to_string()
            )]
        );
        let opts = CliOptions {
            env: Some(win_env()),
            ..Default::default()
        };
        let az = prepare_cli("az", &[], &opts, Platform::Windows, &win_files())
            .unwrap()
            .unwrap();
        assert_eq!(az.args[4], "\"C^:\\npm\\az.bat\"");
    }

    #[test]
    fn prepare_win32_unresolvable_bin_is_none() {
        let opts = CliOptions {
            env: Some(win_env()),
            ..Default::default()
        };
        assert_eq!(
            prepare_cli("nope", &[], &opts, Platform::Windows, &win_files()).unwrap(),
            None
        );
    }

    #[test]
    fn prepare_win32_multi_line_argument_for_a_cmd_errs() {
        let opts = CliOptions {
            env: Some(win_env()),
            ..Default::default()
        };
        let err = prepare_cli(
            "claude",
            &strings(&["a\nb"]),
            &opts,
            Platform::Windows,
            &win_files(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("CR, LF or NUL"));
        // An .exe gets it intact (std quotes it; no cmd.exe involved).
        let p = prepare_cli(
            "gh",
            &strings(&["a\nb"]),
            &opts,
            Platform::Windows,
            &win_files(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(p.args, strings(&["a\nb"]));
    }

    #[test]
    fn native_exe_problem_is_windows_only_and_names_the_shim() {
        let f = files(RESOLVE_FILES);
        assert_eq!(
            native_exe_problem_for("claude", &resolve_env(), None, Platform::Posix, &f),
            None
        );
        let msg =
            native_exe_problem_for("claude", &resolve_env(), None, Platform::Windows, &f).unwrap();
        assert!(msg.starts_with("claude resolves to C:\\npm\\claude.cmd, not a native .exe"));
        let e = env(&[("PATH", "C:\\bin")]);
        assert_eq!(
            native_exe_problem_for("claude", &e, None, Platform::Windows, &f),
            None
        );
        assert_eq!(
            native_exe_problem_for("nope", &e, None, Platform::Windows, &f),
            None
        );
    }

    // ------------------------------------------------------------ real processes

    const ECHO_ARGS: &str = "process.stdout.write(JSON.stringify(process.argv.slice(2)));";

    async fn run(bin: &str, args: &[String], opts: CliOptions) -> Result<String, SpawnError> {
        let out = exec_file_cli(bin, args, opts).await?;
        assert!(
            out.output.status.success(),
            "exit {:?}: {}",
            out.output.status,
            String::from_utf8_lossy(&out.output.stderr)
        );
        Ok(String::from_utf8(out.output.stdout).unwrap())
    }

    fn json_args(out: &str) -> Vec<String> {
        serde_json::from_str(out).unwrap()
    }

    fn echo_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write_fake_bin(dir.path(), "echo-args", ECHO_ARGS, Platform::current()).unwrap();
        dir
    }

    #[tokio::test]
    async fn spawn_bare_name_resolves_through_path_with_metachar_args_intact() {
        let dir = echo_dir();
        let opts = CliOptions {
            env: Some(env_with_path(&[dir.path()])),
            ..Default::default()
        };
        let out = run("echo-args", &strings(NASTY), opts).await.unwrap();
        assert_eq!(json_args(&out), strings(NASTY));
    }

    #[test]
    fn exec_file_cli_sync_does_the_same_synchronously() {
        let dir = echo_dir();
        let opts = CliOptions {
            env: Some(env_with_path(&[dir.path()])),
            ..Default::default()
        };
        let args = strings(&["x&y", "q\"uote", "%PATH%"]);
        let out = exec_file_cli_sync("echo-args", &args, &opts).unwrap();
        assert_eq!(json_args(&String::from_utf8(out.stdout).unwrap()), args);
        // With a timeout, too.
        let opts = CliOptions {
            timeout: Some(Duration::from_secs(30)),
            ..opts
        };
        let out = exec_file_cli_sync("echo-args", &args, &opts).unwrap();
        assert_eq!(json_args(&String::from_utf8(out.stdout).unwrap()), args);
    }

    #[tokio::test]
    async fn spawn_runs_an_absolute_binary_directly() {
        let echo = "process.stdout.write(JSON.stringify(process.argv.slice(1)));"; // -e: no script
        let out = run(
            &node_bin(),
            &strings(&["-e", echo, "a b", "x\"y"]),
            CliOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(json_args(&out), strings(&["a b", "x\"y"]));
    }

    #[tokio::test]
    async fn spawn_a_missing_bin_fails_with_enoent_and_no_pid() {
        let dir = echo_dir();
        let opts = CliOptions {
            env: Some(env_with_path(&[dir.path()])),
            ..Default::default()
        };
        let err = spawn_cli("conductor-no-such-bin", &strings(&["a"]), opts.clone()).unwrap_err();
        assert_eq!(err.code(), "ENOENT");
        assert!(matches!(err, SpawnError::NotFound { .. }));
        let err = exec_file_cli_sync("conductor-no-such-bin", &[], &opts).unwrap_err();
        assert_eq!(err.code(), "ENOENT");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn win32_a_node_cmd_planted_in_the_cwd_is_not_run_by_the_shim() {
        let dir = echo_dir();
        let cwd = tempfile::tempdir().unwrap();
        for ext in ["cmd", "bat", "exe"] {
            std::fs::write(cwd.path().join(format!("node.{ext}")), "@echo PLANTED\r\n").unwrap();
        }
        let opts = CliOptions {
            cwd: Some(cwd.path().to_path_buf()),
            env: Some(env_with_path(&[dir.path()])),
            ..Default::default()
        };
        let out = run("echo-args", &strings(&["a b", "!PATH!"]), opts)
            .await
            .unwrap();
        assert!(!out.contains("PLANTED"));
        assert_eq!(json_args(&out), strings(&["a b", "!PATH!"]));
    }

    #[cfg(windows)]
    #[test]
    fn win32_a_program_planted_in_the_cwd_is_not_run_for_a_bare_name() {
        let dir = echo_dir();
        let cwd = tempfile::tempdir().unwrap();
        std::fs::copy(node_bin(), cwd.path().join("conductor-planted.exe")).unwrap();
        let opts = CliOptions {
            cwd: Some(cwd.path().to_path_buf()),
            env: Some(env_with_path(&[dir.path()])),
            ..Default::default()
        };
        let err =
            exec_file_cli_sync("conductor-planted", &strings(&["-e", "0"]), &opts).unwrap_err();
        assert_eq!(err.code(), "ENOENT");
    }

    #[tokio::test]
    async fn exec_file_cli_times_out_and_kills_the_child() {
        let opts = CliOptions {
            timeout: Some(Duration::from_millis(300)),
            ..Default::default()
        };
        let out = exec_file_cli(
            &node_bin(),
            &strings(&["-e", "setInterval(()=>{},1000)"]),
            opts,
        )
        .await
        .unwrap();
        assert!(out.timed_out);
        assert!(!out.output.status.success());
    }

    #[test]
    fn is_on_path_finds_executables_only() {
        let dir = echo_dir();
        let p = dir.path().to_string_lossy().into_owned();
        assert!(is_on_path("echo-args", &p, &process_env()));
        assert!(!is_on_path("conductor-no-such-bin", &p, &process_env()));
    }
}
