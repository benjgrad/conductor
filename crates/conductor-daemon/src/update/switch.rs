//! ADR-0021 §2.4 "Switch" and §2.6 "Not supervised".
//!
//! A daemon only switches `current` when something will restart it (a service manager:
//! `CONDUCTOR_SUPERVISED` set by the unit) **and** the installed launcher knows the trial and
//! rollback protocol ([`LAUNCHER_MARKER`]). A machine still on M2-T18's plain launcher has no
//! rollback, so switching there could strand it on a bad build: it stages the build and logs
//! that re-running the install command enables automatic updates.

use std::io;
use std::path::{Path, PathBuf};

use super::layout::{CURRENT, Trial, current_version, daemon_dir, remove_trial, write_trial};
use crate::commands::service::{launcher_path, launcher_ps1_path};
use crate::platform::{self, Platform};

/// The line a trial-aware launcher (both `assets/conductor-launch.sh` and `.ps1`) carries.
pub const LAUNCHER_MARKER: &str = "# conductor-launch: trial-v1";

/// The installed launcher for this OS.
pub fn installed_launcher(root: &Path) -> PathBuf {
    let r = root.to_string_lossy();
    if Platform::current().is_windows() {
        PathBuf::from(launcher_ps1_path(&r))
    } else {
        PathBuf::from(launcher_path(&r))
    }
}

/// Why this daemon must not switch (stage only), or the version `current` points at now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanSwitch {
    /// Switch away from this version.
    Yes { from: String },
    /// Stage only; the message for the log.
    No(String),
}

/// May the daemon in `root` switch to `version`? `supervised` is `CONDUCTOR_SUPERVISED`.
pub fn can_switch(supervised: Option<&str>, root: &Path, version: &str) -> CanSwitch {
    if supervised.is_none_or(|s| s.trim().is_empty()) {
        return CanSwitch::No(format!(
            "update {version} staged; restart conductor-daemon to use it"
        ));
    }
    let launcher = installed_launcher(root);
    let aware = std::fs::read_to_string(&launcher)
        .is_ok_and(|t| t.lines().any(|l| l.trim_end() == LAUNCHER_MARKER));
    if !aware {
        return CanSwitch::No(format!(
            "update {version} staged; {} can't roll a bad update back, so it isn't switched to \
             automatically. Re-run the install command to enable automatic updates",
            launcher.display()
        ));
    }
    match current_version(root) {
        Some(from) => CanSwitch::Yes { from },
        None => CanSwitch::No(format!(
            "update {version} staged; {} is not a link to a version, so it isn't switched",
            daemon_dir(root).join(CURRENT).display()
        )),
    }
}

/// Write `trial` (`attempts=0`) and point `current` at `to`. The caller then exits with
/// `EXIT_RESTART_FOR_UPDATE`. On failure `trial` is removed and `current` is unchanged.
pub fn switch(root: &Path, from: &str, to: &str) -> io::Result<()> {
    write_trial(
        root,
        &Trial {
            from: from.to_string(),
            to: to.to_string(),
            attempts: 0,
        },
    )?;
    platform::fs::repoint_dir_link(&daemon_dir(root), CURRENT, to).inspect_err(|_| {
        let _ = remove_trial(root);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::service::{LAUNCHER, LAUNCHER_PS1};
    use crate::update::layout::read_trial;

    fn root_with(
        versions: &[&str],
        current: Option<&str>,
        launcher: Option<&str>,
    ) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let d = daemon_dir(dir.path());
        for v in versions {
            std::fs::create_dir_all(d.join(v)).unwrap();
        }
        if let Some(c) = current {
            platform::fs::repoint_dir_link(&d, CURRENT, c).unwrap();
        }
        if let Some(l) = launcher {
            let p = installed_launcher(dir.path());
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, l).unwrap();
        }
        dir
    }

    #[test]
    fn both_shipped_launchers_carry_the_marker() {
        for l in [LAUNCHER, LAUNCHER_PS1] {
            assert!(l.lines().any(|x| x.trim_end() == LAUNCHER_MARKER));
        }
    }

    #[test]
    fn unsupervised_or_an_old_launcher_only_stages() {
        let shipped = if Platform::current().is_windows() {
            LAUNCHER_PS1
        } else {
            LAUNCHER
        };
        let r = root_with(&["1.0.0"], Some("1.0.0"), Some(shipped));
        assert!(matches!(
            can_switch(None, r.path(), "2.0.0"),
            CanSwitch::No(m) if m.contains("restart conductor-daemon to use it")
        ));
        assert_eq!(
            can_switch(Some("systemd"), r.path(), "2.0.0"),
            CanSwitch::Yes {
                from: "1.0.0".into()
            }
        );
        let old = root_with(&["1.0.0"], Some("1.0.0"), Some("#!/bin/sh\nexec x\n"));
        assert!(matches!(
            can_switch(Some("systemd"), old.path(), "2.0.0"),
            CanSwitch::No(m) if m.contains("Re-run the install command")
        ));
        let none = root_with(&["1.0.0"], Some("1.0.0"), None);
        assert!(matches!(
            can_switch(Some("launchd"), none.path(), "2.0.0"),
            CanSwitch::No(_)
        ));
        let no_current = root_with(&["1.0.0"], None, Some(shipped));
        assert!(matches!(
            can_switch(Some("launchd"), no_current.path(), "2.0.0"),
            CanSwitch::No(m) if m.contains("not a link")
        ));
    }

    #[test]
    fn switch_writes_the_trial_and_moves_current() {
        let r = root_with(&["1.0.0", "2.0.0"], Some("1.0.0"), None);
        switch(r.path(), "1.0.0", "2.0.0").unwrap();
        assert_eq!(current_version(r.path()).as_deref(), Some("2.0.0"));
        assert_eq!(
            read_trial(r.path()),
            Some(Trial {
                from: "1.0.0".into(),
                to: "2.0.0".into(),
                attempts: 0
            })
        );
        // A missing target: nothing changes.
        assert!(switch(r.path(), "2.0.0", "3.0.0").is_err());
        assert_eq!(read_trial(r.path()), None);
        assert_eq!(current_version(r.path()).as_deref(), Some("2.0.0"));
    }
}
