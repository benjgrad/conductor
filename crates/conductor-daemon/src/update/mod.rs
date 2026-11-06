//! ADR-0021's updater (MR-T14a; no TS twin): the daemon updates itself to the build the
//! orchestrator announces, never cuts running work, and a bad build is rolled back by the
//! version-independent launcher and reported to a human.
//!
//! - [`contract`] — the announced build and the checks the zod schema makes (TD-196).
//! - [`layout`] — `<root>/daemon/{<version>,current,trial,bad-versions,bad-versions.reported}`.
//! - [`stage`] — download, size + SHA-256, unpack with every entry checked, `--version`, rename.
//! - [`policy`] — whether an announced build is acted on (opt-out, bad versions, drain bounds).
//! - [`switch`] — may this daemon switch (supervised, a trial-aware launcher), and the switch.
//! - [`commit`] — on `registered`, commit a trial, clean up old versions, find rollbacks to report.
//!
//! The drain itself (no `request_work`, `heartbeat.draining`, wait for idle, exit 75) is wired in
//! `daemon.rs`, which owns the state it needs. No OS `cfg` here (tests/seam.rs): the `current`
//! swap is `platform::fs::repoint_dir_link`.

pub mod commit;
pub mod contract;
pub mod layout;
pub mod policy;
pub mod stage;
pub mod switch;

pub use contract::{DaemonBuild, daemon_tarball_matches, version_ok};
pub use stage::{UpdateError, stage};

use conductor_protocol::UpdateFailedStage;

/// `alert update_failed.error`, cut to `UPDATE_FAILED_ERROR_MAX` characters and never empty.
pub fn alert_error(error: &str) -> String {
    let max = conductor_protocol::UPDATE_FAILED_ERROR_MAX;
    let t = error.trim();
    let t = if t.is_empty() { "unknown error" } else { t };
    t.chars().take(max).collect()
}

/// The `stage` an [`UpdateError`] is reported under, as the wire names it.
pub fn stage_name(s: UpdateFailedStage) -> &'static str {
    match s {
        UpdateFailedStage::Download => "download",
        UpdateFailedStage::Verify => "verify",
        UpdateFailedStage::Unpack => "unpack",
        UpdateFailedStage::DrainTimeout => "drain_timeout",
        UpdateFailedStage::Trial => "trial",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alert_errors_are_bounded_and_never_empty() {
        assert_eq!(alert_error("  "), "unknown error");
        assert_eq!(alert_error(&"é".repeat(600)).chars().count(), 500);
        assert_eq!(alert_error(" boom \n"), "boom");
    }

    #[test]
    fn stage_names_are_the_wire_names() {
        for s in [
            UpdateFailedStage::Download,
            UpdateFailedStage::Verify,
            UpdateFailedStage::Unpack,
            UpdateFailedStage::DrainTimeout,
            UpdateFailedStage::Trial,
        ] {
            assert_eq!(
                serde_json::to_value(s).unwrap(),
                serde_json::json!(stage_name(s))
            );
        }
    }
}
