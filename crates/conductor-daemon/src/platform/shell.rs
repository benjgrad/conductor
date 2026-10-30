//! Port of `packages/daemon/src/platform/shell.ts` (MR-T04). ADR-0024 §1 + §4: the shell that
//! runs workflow JSON commands. Workflow commands are POSIX `sh`, so one workflow runs on every
//! OS: `/bin/sh -c <cmd>` on POSIX, Git Bash `bash.exe -c <cmd>` on Windows (Claude Code on Windows
//! already requires Git for Windows).
//!
//! Git Bash is looked up in this order:
//!   1. CONDUCTOR_SHELL (an explicit override; must exist);
//!   2. CLAUDE_CODE_GIT_BASH_PATH (what Claude Code itself is told to use);
//!   3. relative to `git --exec-path` (`<git>\mingw64\libexec\git-core` → `<git>\bin\bash.exe`);
//!   4. the default install dirs: %ProgramFiles%\Git, %ProgramW6432%\Git,
//!      %ProgramFiles(x86)%\Git, %LOCALAPPDATA%\Programs\Git.
//!
//! `bin\bash.exe` is preferred over `usr\bin\bash.exe`: it is Git's launcher, which puts the MSYS
//! tools (`usr\bin`, `mingw64\bin`) on PATH. A bare `bash` from PATH is never used:
//! `C:\Windows\System32\bash.exe` is WSL, not Git Bash.

use super::spawn::{CliOptions, StdioKind, env_get, exec_file_cli_sync, process_env, real_is_file};
use super::{Platform, win_path};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// The program and argv that run one workflow command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowShell {
    pub file: PathBuf,
}

impl WorkflowShell {
    pub fn args(&self, cmd: &str) -> Vec<String> {
        vec!["-c".to_string(), cmd.to_string()]
    }
}

/// The OS facts the Git Bash lookup reads, injected so it is testable anywhere.
pub struct FindGitBashDeps<'a> {
    pub env: &'a [(String, String)],
    pub is_file: &'a dyn Fn(&str) -> bool,
    /// `git --exec-path`, or None when git isn't runnable.
    pub git_exec_path: &'a dyn Fn() -> Option<String>,
}

/// The Git root of an exec-path `<root>\{mingw64,mingw32,clangarm64,usr}\libexec\git-core[\]`,
/// either separator, any case. None for anything else.
fn git_root_of_exec_path(exec: &str) -> Option<&str> {
    let trimmed = exec.strip_suffix(['\\', '/']).unwrap_or(exec);
    let lower = trimmed.to_ascii_lowercase().replace('/', "\\");
    for prefix in ["mingw64", "mingw32", "clangarm64", "usr"] {
        let suffix = format!("\\{prefix}\\libexec\\git-core");
        if lower.ends_with(&suffix) {
            return Some(&trimmed[..trimmed.len() - suffix.len()]);
        }
    }
    None
}

fn bash_under(root: &str) -> [String; 2] {
    [
        win_path::join(&[root, "bin", "bash.exe"]),
        win_path::join(&[root, "usr", "bin", "bash.exe"]),
    ]
}

/// Git Bash candidates in lookup order (before checking they exist). Pure given `deps`.
pub fn git_bash_candidates(deps: &FindGitBashDeps<'_>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(claude) = env_get(deps.env, "CLAUDE_CODE_GIT_BASH_PATH").filter(|s| !s.is_empty()) {
        out.push(claude.to_string());
    }
    if let Some(exec) = (deps.git_exec_path)()
        && let Some(root) = git_root_of_exec_path(exec.trim())
    {
        out.extend(bash_under(&win_path::normalize(root)));
    }
    for (name, sub) in [
        ("ProgramFiles", "Git"),
        ("ProgramW6432", "Git"),
        ("ProgramFiles(x86)", "Git"),
        ("LOCALAPPDATA", "Programs\\Git"),
    ] {
        if let Some(base) = env_get(deps.env, name).filter(|s| !s.is_empty()) {
            out.extend(bash_under(&win_path::join(&[base, sub])));
        }
    }
    out
}

/// Find Git Bash (see the header). Errs with the places it looked if there is none.
pub fn find_git_bash(deps: &FindGitBashDeps<'_>) -> Result<String, String> {
    if let Some(over) = env_get(deps.env, "CONDUCTOR_SHELL").filter(|s| !s.is_empty()) {
        if (deps.is_file)(over) {
            return Ok(over.to_string());
        }
        return Err(format!("CONDUCTOR_SHELL={over} does not exist"));
    }
    let candidates = git_bash_candidates(deps);
    if let Some(hit) = candidates
        .iter()
        .find(|c| win_path::is_absolute(c) && (deps.is_file)(c))
    {
        return Ok(hit.clone());
    }
    let looked = if candidates.is_empty() {
        "(nothing)".to_string()
    } else {
        candidates.join(", ")
    };
    Err(format!(
        "Git Bash not found (install Git for Windows, or set CONDUCTOR_SHELL); looked in: {looked}"
    ))
}

fn git_exec_path() -> Option<String> {
    let opts = CliOptions {
        stdin: Some(StdioKind::Null),
        stdout: Some(StdioKind::Piped),
        stderr: Some(StdioKind::Null),
        timeout: Some(Duration::from_secs(10)),
        ..Default::default()
    };
    let out = exec_file_cli_sync("git", &["--exec-path".to_string()], &opts).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

static CACHED: Mutex<Option<WorkflowShell>> = Mutex::new(None);

/// The workflow shell for `platform`. On Windows the Git Bash lookup runs once per process (a miss
/// errs and is retried next call).
pub fn workflow_shell(platform: Platform) -> Result<WorkflowShell, String> {
    if platform == Platform::Posix {
        return Ok(WorkflowShell {
            file: PathBuf::from("/bin/sh"),
        });
    }
    let mut cached = CACHED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sh) = cached.as_ref() {
        return Ok(sh.clone());
    }
    let env = process_env();
    let file = find_git_bash(&FindGitBashDeps {
        env: &env,
        is_file: &real_is_file,
        git_exec_path: &git_exec_path,
    })?;
    let sh = WorkflowShell {
        file: PathBuf::from(file),
    };
    *cached = Some(sh.clone());
    Ok(sh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::spawn::exec_file_cli;
    use std::collections::HashSet;

    const PF_BASH: &str = "C:\\Program Files\\Git\\bin\\bash.exe";

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn find(e: &[(&str, &str)], files: &[&str], exec: Option<&str>) -> Result<String, String> {
        let env = env(e);
        let set: HashSet<&str> = files.iter().copied().collect();
        let is_file = |p: &str| set.contains(p);
        let exec = exec.map(str::to_string);
        let git = move || exec.clone();
        find_git_bash(&FindGitBashDeps {
            env: &env,
            is_file: &is_file,
            git_exec_path: &git,
        })
    }

    fn candidates(e: &[(&str, &str)], exec: Option<&str>) -> Vec<String> {
        let env = env(e);
        let exec = exec.map(str::to_string);
        let git = move || exec.clone();
        git_bash_candidates(&FindGitBashDeps {
            env: &env,
            is_file: &|_| false,
            git_exec_path: &git,
        })
    }

    #[test]
    fn workflow_shell_posix_is_bin_sh_c() {
        let sh = workflow_shell(Platform::Posix).unwrap();
        assert_eq!(sh.file, PathBuf::from("/bin/sh"));
        assert_eq!(sh.args("echo hi"), vec!["-c", "echo hi"]);
    }

    #[tokio::test]
    async fn workflow_shell_runs_a_posix_command_line_on_this_os() {
        let sh = workflow_shell(Platform::current()).unwrap();
        if cfg!(windows) {
            println!(
                "MW-T03: workflow_shell() on this runner = {}",
                sh.file.display()
            );
        }
        assert!(sh.file.exists());
        let out = exec_file_cli(
            &sh.file.to_string_lossy(),
            &sh.args("echo \"a  b\" 'c$d' && echo $((1+2))"),
            CliOptions::default(),
        )
        .await
        .unwrap();
        assert!(out.output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.output.stdout).replace("\r\n", "\n"),
            "a  b c$d\n3\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn win32_finds_git_bash_on_the_runner_not_wsl_bash() {
        let file = workflow_shell(Platform::Windows)
            .unwrap()
            .file
            .to_string_lossy()
            .to_lowercase();
        assert!(file.ends_with("bash.exe"), "{file}");
        assert!(!file.contains("system32"), "{file}");
    }

    #[test]
    fn find_git_bash_conductor_shell_wins_and_must_exist() {
        assert_eq!(
            find(
                &[("CONDUCTOR_SHELL", "D:\\sh.exe")],
                &["D:\\sh.exe", PF_BASH],
                None
            )
            .unwrap(),
            "D:\\sh.exe"
        );
        assert_eq!(
            find(&[("CONDUCTOR_SHELL", "D:\\nope.exe")], &[], None).unwrap_err(),
            "CONDUCTOR_SHELL=D:\\nope.exe does not exist"
        );
    }

    #[test]
    fn find_git_bash_then_claude_code_git_bash_path() {
        let e = [
            ("CLAUDE_CODE_GIT_BASH_PATH", "E:\\Git\\bin\\bash.exe"),
            ("ProgramFiles", "C:\\Program Files"),
        ];
        assert_eq!(
            find(&e, &["E:\\Git\\bin\\bash.exe", PF_BASH], None).unwrap(),
            "E:\\Git\\bin\\bash.exe"
        );
        // Set but missing: fall through to the next candidates.
        assert_eq!(find(&e, &[PF_BASH], None).unwrap(), PF_BASH);
    }

    #[test]
    fn find_git_bash_then_relative_to_git_exec_path() {
        let exec = Some("D:/Tools/Git/mingw64/libexec/git-core\n");
        assert_eq!(
            find(&[], &["D:\\Tools\\Git\\bin\\bash.exe"], exec).unwrap(),
            "D:\\Tools\\Git\\bin\\bash.exe"
        );
        assert_eq!(
            find(&[], &["D:\\Tools\\Git\\usr\\bin\\bash.exe"], exec).unwrap(),
            "D:\\Tools\\Git\\usr\\bin\\bash.exe"
        );
        assert_eq!(
            candidates(&[], Some("C:\\Git\\clangarm64\\libexec\\git-core"))[0],
            "C:\\Git\\bin\\bash.exe"
        );
        // An exec-path we don't recognise adds nothing.
        assert!(candidates(&[], Some("C:\\weird")).is_empty());
    }

    #[test]
    fn find_git_bash_then_the_default_install_dirs_in_order() {
        let e = [
            ("ProgramFiles", "C:\\Program Files"),
            ("ProgramFiles(x86)", "C:\\Program Files (x86)"),
            ("LOCALAPPDATA", "C:\\Users\\b\\AppData\\Local"),
        ];
        assert_eq!(
            candidates(&e, None),
            vec![
                PF_BASH,
                "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
                "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
                "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
                "C:\\Users\\b\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
                "C:\\Users\\b\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
            ]
        );
        let local = "C:\\Users\\b\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
        assert_eq!(find(&e, &[local], None).unwrap(), local);
    }

    #[test]
    fn find_git_bash_errs_with_the_places_it_looked() {
        let err = find(&[("ProgramFiles", "C:\\PF")], &[], None).unwrap_err();
        assert!(err.starts_with("Git Bash not found "), "{err}");
        assert!(err.contains("C:\\PF\\Git\\bin\\bash.exe"), "{err}");
        assert!(
            find(&[], &[], None)
                .unwrap_err()
                .ends_with("looked in: (nothing)")
        );
    }
}
