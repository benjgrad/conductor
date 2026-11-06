//! The files ADR-0021 keeps under `<root>/daemon` (10-contracts §Daemon auto-update):
//!
//! - `<version>/`: one unpacked build each (`bin/conductor-daemon`, `assets/…`, `VERSION`);
//! - `current`: a symlink (POSIX, relative: `<version>`) or a junction (Windows) to one of them;
//! - `trial`: `from=<v>\nto=<v>\nattempts=<n>\n` while a switched-to version hasn't registered.
//!   The launcher increments `attempts` on each start and rolls back past
//!   `UPDATE_MAX_TRIAL_ATTEMPTS`; the new version deletes it on its first `registered`;
//! - `bad-versions`: versions the launcher rolled back from, one per line;
//! - `bad-versions.reported`: those this daemon has already sent `alert update_failed` for;
//! - `.staging-<random>/`: a download being staged (removed on failure, swept at startup).
//!
//! Every version read from disk is checked with [`version_ok`] before it is used in a path.

use std::io;
use std::path::{Path, PathBuf};

use super::contract::version_ok;

pub const CURRENT: &str = "current";
pub const TRIAL: &str = "trial";
pub const BAD_VERSIONS: &str = "bad-versions";
pub const BAD_VERSIONS_REPORTED: &str = "bad-versions.reported";
pub const STAGING_PREFIX: &str = ".staging-";

/// `<root>/daemon`.
pub fn daemon_dir(root: &Path) -> PathBuf {
    root.join("daemon")
}

/// `<root>/daemon/<version>`.
pub fn version_dir(root: &Path, version: &str) -> PathBuf {
    daemon_dir(root).join(version)
}

/// The version `<root>/daemon/current` points at (its target's last component), if valid.
pub fn current_version(root: &Path) -> Option<String> {
    let target = std::fs::read_link(daemon_dir(root).join(CURRENT)).ok()?;
    let name = target.file_name()?.to_string_lossy().into_owned();
    version_ok(&name).then_some(name)
}

/// A switch in progress (`<root>/daemon/trial`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trial {
    pub from: String,
    pub to: String,
    pub attempts: u32,
}

impl Trial {
    /// The file's text, exactly what the launchers parse.
    pub fn text(&self) -> String {
        format!(
            "from={}\nto={}\nattempts={}\n",
            self.from, self.to, self.attempts
        )
    }

    /// Parse the file; None when a field is missing or a version is unsafe. Accepts `\r\n`
    /// (the Windows launcher may write it).
    pub fn parse(text: &str) -> Option<Trial> {
        let field = |k: &str| {
            text.lines()
                .find_map(|l| l.trim_end_matches('\r').strip_prefix(&format!("{k}=")))
                .map(str::to_string)
        };
        let from = field("from")?;
        let to = field("to")?;
        let attempts = field("attempts")
            .and_then(|a| a.trim().parse().ok())
            .unwrap_or(0);
        (version_ok(&from) && version_ok(&to)).then_some(Trial { from, to, attempts })
    }
}

/// `<root>/daemon/trial`, if present and valid.
pub fn read_trial(root: &Path) -> Option<Trial> {
    let text = std::fs::read_to_string(daemon_dir(root).join(TRIAL)).ok()?;
    Trial::parse(&text)
}

/// Write `<root>/daemon/trial` atomically (a temp file renamed over it).
pub fn write_trial(root: &Path, t: &Trial) -> io::Result<()> {
    write_atomic(&daemon_dir(root).join(TRIAL), t.text().as_bytes())
}

/// Delete `<root>/daemon/trial` (missing is fine).
pub fn remove_trial(root: &Path) -> io::Result<()> {
    match std::fs::remove_file(daemon_dir(root).join(TRIAL)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn read_versions(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for l in text.lines() {
        let v = l.trim();
        if version_ok(v) && !out.iter().any(|o| o == v) {
            out.push(v.to_string());
        }
    }
    out
}

fn append_version(path: &Path, v: &str) -> io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{v}")
}

/// The versions the launcher rolled back from.
pub fn bad_versions(root: &Path) -> Vec<String> {
    read_versions(&daemon_dir(root).join(BAD_VERSIONS))
}

/// Record a bad version (the launcher does this; the daemon only in tests and for symmetry).
pub fn add_bad_version(root: &Path, v: &str) -> io::Result<()> {
    append_version(&daemon_dir(root).join(BAD_VERSIONS), v)
}

/// The bad versions this daemon has already reported.
pub fn reported_versions(root: &Path) -> Vec<String> {
    read_versions(&daemon_dir(root).join(BAD_VERSIONS_REPORTED))
}

/// Record that `v`'s rollback was reported.
pub fn mark_reported(root: &Path, v: &str) -> io::Result<()> {
    append_version(&daemon_dir(root).join(BAD_VERSIONS_REPORTED), v)
}

/// Write `path` via `<path>.tmp` + rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Remove every `.staging-*` dir under `<root>/daemon` (a crash mid-download leaves one).
pub fn sweep_staging(root: &Path) {
    let Ok(rd) = std::fs::read_dir(daemon_dir(root)) else {
        return;
    };
    for e in rd.flatten() {
        if e.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trial_round_trips_and_refuses_unsafe_versions() {
        let t = Trial {
            from: "1.0.0".into(),
            to: "1.1.0+abc".into(),
            attempts: 2,
        };
        assert_eq!(t.text(), "from=1.0.0\nto=1.1.0+abc\nattempts=2\n");
        assert_eq!(Trial::parse(&t.text()), Some(t.clone()));
        assert_eq!(
            Trial::parse("from=1.0.0\r\nto=1.1.0+abc\r\nattempts=2\r\n"),
            Some(t)
        );
        assert_eq!(Trial::parse("from=..\nto=1\nattempts=0\n"), None);
        assert_eq!(Trial::parse("from=1\nattempts=0\n"), None);
        assert_eq!(Trial::parse("from=1\nto=2\n").map(|t| t.attempts), Some(0));
    }

    #[test]
    fn trial_files_and_version_lists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(daemon_dir(root)).unwrap();
        assert_eq!(read_trial(root), None);
        let t = Trial {
            from: "1".into(),
            to: "2".into(),
            attempts: 0,
        };
        write_trial(root, &t).unwrap();
        assert_eq!(read_trial(root), Some(t));
        remove_trial(root).unwrap();
        remove_trial(root).unwrap();
        assert_eq!(read_trial(root), None);

        assert!(bad_versions(root).is_empty());
        add_bad_version(root, "2").unwrap();
        add_bad_version(root, "2").unwrap();
        std::fs::write(daemon_dir(root).join(BAD_VERSIONS), "2\n2\n../x\n\n3\n").unwrap();
        assert_eq!(bad_versions(root), vec!["2", "3"]);
        mark_reported(root, "2").unwrap();
        assert_eq!(reported_versions(root), vec!["2"]);
    }

    #[test]
    fn staging_dirs_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(daemon_dir(root).join(".staging-abc/x")).unwrap();
        std::fs::create_dir_all(daemon_dir(root).join("1.0.0")).unwrap();
        sweep_staging(root);
        assert!(!daemon_dir(root).join(".staging-abc").exists());
        assert!(daemon_dir(root).join("1.0.0").exists());
    }
}
