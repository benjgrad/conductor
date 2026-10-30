//! Port of `packages/daemon/src/platform/git.ts` (MR-T04). ADR-0024 §5: how the daemon runs git
//! on each OS.
//!
//! - Hooks off: `core.hooksPath` points at the null device, where no hook file can exist. On
//!   Windows that must be `NUL`: Git for Windows reads `/dev/null` as the drive-relative
//!   `C:\dev\null`, which any local user may create, so a planted `C:\dev\null\pre-push` would run.
//! - System config: POSIX drops it (`GIT_CONFIG_NOSYSTEM`). Windows keeps it: it lives under
//!   Program Files (admin-writable only) and carries Git for Windows' `credential.helper=manager`,
//!   `http.sslBackend=schannel` and corporate CAs, without which `open_pr` can't push.

use super::Platform;

/// The null device for `core.hooksPath` on `platform`.
pub fn null_device_for(platform: Platform) -> &'static str {
    match platform {
        Platform::Windows => "NUL",
        Platform::Posix => "/dev/null",
    }
}

/// The null device for `core.hooksPath`: `NUL` on Windows, `/dev/null` elsewhere.
pub fn null_device() -> &'static str {
    null_device_for(Platform::current())
}

/// `git -c` args that turn every hook off.
pub fn git_hooks_off_args() -> Vec<String> {
    vec![
        "-c".to_string(),
        format!("core.hooksPath={}", null_device()),
    ]
}

/// Env added to every daemon git/gh run on `platform`.
pub fn git_system_config_env_for(platform: Platform) -> Vec<(String, String)> {
    match platform {
        Platform::Windows => Vec::new(),
        Platform::Posix => vec![("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string())],
    }
}

/// Env added to every daemon git/gh run: drop the system gitconfig on POSIX only.
pub fn git_system_config_env() -> Vec<(String, String)> {
    git_system_config_env_for(Platform::current())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_device_and_system_config_per_os() {
        assert_eq!(null_device_for(Platform::Windows), "NUL");
        assert_eq!(null_device_for(Platform::Posix), "/dev/null");
        assert_eq!(
            git_hooks_off_args()[1],
            format!("core.hooksPath={}", null_device())
        );
        assert!(git_system_config_env_for(Platform::Windows).is_empty());
        assert_eq!(
            git_system_config_env_for(Platform::Posix),
            vec![("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string())]
        );
    }
}
