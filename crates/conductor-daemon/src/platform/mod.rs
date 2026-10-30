//! Port of `packages/daemon/src/platform/index.ts` (MR-T04).
//!
//! The only place OS-specific code (`cfg(windows)`, `cfg(unix)`, `cfg(target_os = …)`) may live
//! (tests/seam.rs). Call sites use what is re-exported here instead of branching on the OS.
//!
//! Pure logic (win32 path resolution, cmd.exe escaping, command-line parsing, ACL decisions) is
//! never behind a `cfg`: it takes a [`Platform`] or injected OS facts, so the Windows rules are
//! tested on every OS. Only the syscalls are.
//!
//! Declared up front (MR-T02); `win_path` was added by MR-T04, which owns `platform/`.

pub mod acl;
pub mod fs;
pub mod git;
pub mod hook;
pub mod kill_tree;
pub mod procinfo;
pub mod shell;
pub mod spawn;
pub mod sysres;
pub mod win_path;

pub use acl::{
    AclError, AclKind, AclRefusal, AssertOwnerOnlyOptions, PrivateError, assert_owner_only,
    current_user_sid, mkdir_private, write_private_file,
};
pub use fs::same_path;
pub use git::{git_hooks_off_args, git_system_config_env, null_device};
pub use hook::{WIN_HOOK_UNSAFE, hook_command};
pub use kill_tree::{
    KillTarget, KillTreeHandle, KillTreeOptions, Signal, kill_tree, killed_exit, signal_tree,
};
pub use procinfo::{ProcInfo, exe_name, read_proc_info, same_executable};
pub use shell::{WorkflowShell, workflow_shell};
pub use spawn::{
    CliChild, CliOptions, CliOutput, SpawnError, StdioKind, TreeHandle, exec_file_cli,
    exec_file_cli_sync, is_on_path, native_exe_problem, spawn_cli,
};

/// The OS family a rule is evaluated for. Production code uses [`Platform::current`]; tests pass
/// the other one to exercise its rules (the TS `platform` / `deps.platform` parameters).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// Linux, macOS and the other unixes.
    Posix,
    Windows,
}

impl Platform {
    /// The OS this binary was built for.
    pub const fn current() -> Self {
        #[cfg(windows)]
        {
            Platform::Windows
        }
        #[cfg(not(windows))]
        {
            Platform::Posix
        }
    }

    /// `PATH`'s separator (`path.delimiter`).
    pub const fn path_delimiter(self) -> char {
        match self {
            Platform::Posix => ':',
            Platform::Windows => ';',
        }
    }

    /// The suffix of an executable file name.
    pub const fn exe_suffix(self) -> &'static str {
        match self {
            Platform::Posix => "",
            Platform::Windows => ".exe",
        }
    }

    pub const fn is_windows(self) -> bool {
        matches!(self, Platform::Windows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_the_platform_modules() {
        // The Rust twin of "exports the MW-T03 modules": the seam's entry points exist with these
        // shapes (a compile-time check, run as a test).
        let _: fn(&str, &[String], CliOptions) -> Result<CliChild, SpawnError> = spawn_cli;
        let _: fn(&str, &[String], &CliOptions) -> Result<std::process::Output, SpawnError> =
            exec_file_cli_sync;
        let _: fn(KillTarget<'_>, KillTreeOptions) -> Result<KillTreeHandle, kill_tree::BadPid> =
            kill_tree;
        let _: fn(Platform) -> Result<WorkflowShell, String> = workflow_shell;
        let _: fn(u32) -> Option<ProcInfo> = read_proc_info;
        let _ = Platform::current().path_delimiter();
    }

    #[test]
    fn current_platform_matches_the_build() {
        assert_eq!(Platform::current().is_windows(), cfg!(windows));
        assert_eq!(Platform::Windows.path_delimiter(), ';');
        assert_eq!(Platform::Posix.exe_suffix(), "");
    }

    /// U-107 / spike N8: does lstat report a junction as a symbolic link? The edit guard and the
    /// "never follow a symlink" checks rely on it. The value is printed for the record.
    #[cfg(windows)]
    #[test]
    fn u107_lstat_on_a_junction() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        fs::tests_support::make_junction(&link, &target);
        let st = std::fs::symlink_metadata(&link).unwrap();
        println!(
            "U-107: symlink_metadata(junction).is_symlink() = {}, is_dir() = {}, read_link = {:?}",
            st.file_type().is_symlink(),
            st.is_dir(),
            std::fs::read_link(&link)
        );
        assert!(st.file_type().is_symlink() || fs::is_reparse_point(&st));
    }
}
