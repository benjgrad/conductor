//! ADR-0021 §3 "Committing", "Reporting" and "Disk", run on every `registered`:
//! - a `trial` for this very version is the success signal: delete it (the update is committed),
//!   then delete versions older than the previous one;
//! - versions the launcher rolled back from (`bad-versions`) that no alert went out for yet are
//!   returned, for the caller to send `alert update_failed {stage: trial}` and mark reported.

use std::path::Path;

use super::contract::version_ok;
use super::layout::{
    Trial, bad_versions, current_version, daemon_dir, read_trial, remove_trial, reported_versions,
};

/// What [`on_registered`] did and found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Registered {
    /// The trial this start committed.
    pub committed: Option<Trial>,
    /// Version dirs deleted after the commit.
    pub removed: Vec<String>,
    /// Rolled-back versions not reported yet.
    pub to_report: Vec<String>,
}

/// Commit, clean up, and list the rollbacks to report, for the daemon at `root` running `own`.
pub fn on_registered(root: &Path, own: &str) -> Registered {
    let mut out = Registered::default();
    if let Some(t) = read_trial(root).filter(|t| t.to == own)
        && remove_trial(root).is_ok()
    {
        out.removed = clean_up(root, &[own, &t.from]);
        out.committed = Some(t);
    }
    let reported = reported_versions(root);
    out.to_report = bad_versions(root)
        .into_iter()
        .filter(|v| !reported.contains(v))
        .collect();
    out
}

/// Delete every `<root>/daemon/<version>` dir except `keep`, `current`'s target and whatever a
/// `trial` names. Links are never followed or removed (`current` is one); hidden entries
/// (`.staging-*`) are left to the startup sweep. Returns the names removed.
pub fn clean_up(root: &Path, keep: &[&str]) -> Vec<String> {
    let mut keep: Vec<String> = keep.iter().map(|s| s.to_string()).collect();
    keep.extend(current_version(root));
    if let Some(t) = read_trial(root) {
        keep.push(t.from);
        keep.push(t.to);
    }
    let mut removed = Vec::new();
    let Ok(rd) = std::fs::read_dir(daemon_dir(root)) else {
        return removed;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !version_ok(&name) || keep.contains(&name) {
            continue;
        }
        // symlink_metadata: a link is not a version dir, whatever it points at.
        let Ok(m) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if !m.is_dir() || crate::platform::fs::is_reparse_point(&m) {
            continue;
        }
        // Windows: a version whose exe still runs can't be deleted; it goes next time.
        if std::fs::remove_dir_all(e.path()).is_ok() {
            removed.push(name);
        }
    }
    removed.sort();
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform;
    use crate::update::layout::{CURRENT, add_bad_version, mark_reported, write_trial};

    fn root(versions: &[&str], current: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let d = daemon_dir(dir.path());
        for v in versions {
            std::fs::create_dir_all(d.join(v).join("bin")).unwrap();
        }
        platform::fs::repoint_dir_link(&d, CURRENT, current).unwrap();
        dir
    }

    fn trial(from: &str, to: &str) -> Trial {
        Trial {
            from: from.into(),
            to: to.into(),
            attempts: 1,
        }
    }

    #[test]
    fn a_trial_for_this_version_is_committed_and_old_versions_go() {
        let r = root(&["0.8.0", "0.9.0", "1.0.0", "2.0.0"], "2.0.0");
        std::fs::create_dir_all(daemon_dir(r.path()).join(".staging-x")).unwrap();
        write_trial(r.path(), &trial("1.0.0", "2.0.0")).unwrap();
        let got = on_registered(r.path(), "2.0.0");
        assert_eq!(got.committed, Some(trial("1.0.0", "2.0.0")));
        assert_eq!(got.removed, ["0.8.0", "0.9.0"]);
        assert_eq!(read_trial(r.path()), None);
        let d = daemon_dir(r.path());
        assert!(d.join("1.0.0").is_dir() && d.join("2.0.0").is_dir());
        assert!(d.join(".staging-x").is_dir());
        assert_eq!(current_version(r.path()).as_deref(), Some("2.0.0"));
    }

    #[test]
    fn a_trial_for_another_version_is_left_alone() {
        let r = root(&["0.9.0", "1.0.0", "2.0.0"], "2.0.0");
        write_trial(r.path(), &trial("1.0.0", "2.0.0")).unwrap();
        let got = on_registered(r.path(), "1.0.0");
        assert_eq!(got.committed, None);
        assert!(got.removed.is_empty());
        assert!(read_trial(r.path()).is_some());
        assert!(daemon_dir(r.path()).join("0.9.0").is_dir());
    }

    #[test]
    fn rollbacks_are_reported_once() {
        let r = root(&["1.0.0"], "1.0.0");
        assert!(on_registered(r.path(), "1.0.0").to_report.is_empty());
        add_bad_version(r.path(), "2.0.0").unwrap();
        add_bad_version(r.path(), "3.0.0").unwrap();
        assert_eq!(
            on_registered(r.path(), "1.0.0").to_report,
            ["2.0.0", "3.0.0"]
        );
        mark_reported(r.path(), "2.0.0").unwrap();
        assert_eq!(on_registered(r.path(), "1.0.0").to_report, ["3.0.0"]);
    }
}
