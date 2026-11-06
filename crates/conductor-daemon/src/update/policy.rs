//! Whether an announced build is acted on (ADR-0021 §2.5, §3, §4). Pure: the caller passes the
//! time (ms on any monotonic clock), the opt-out and the bad versions read from disk. The
//! counters live in memory, so they reset when the daemon restarts, as the ADR says.

use conductor_protocol::{UPDATE_DRAIN_COOLDOWN_MS, UPDATE_MAX_DRAIN_ATTEMPTS};

/// What to do with an `update_available`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Stage,
    /// Not now, and why (logged once per reason by the caller).
    Ignore(String),
}

/// The per-version bookkeeping.
#[derive(Debug, Default)]
pub struct Policy {
    /// The version the counters below are for; a different version resets them.
    version: Option<String>,
    /// Abandoned drains (and failed stagings) of `version`.
    abandoned: usize,
    /// No new attempt for `version` before this.
    cooldown_until: Option<u64>,
    /// Staging, draining or switching `version` right now.
    busy: bool,
}

impl Policy {
    pub fn new() -> Self {
        Policy::default()
    }

    /// Decide on an announced `version`. `own` is the running daemon's version.
    pub fn decide(
        &mut self,
        version: &str,
        own: &str,
        auto_update: bool,
        bad_versions: &[String],
        now_ms: u64,
    ) -> Decision {
        let ignore = |why: String| Decision::Ignore(why);
        if !auto_update {
            return ignore(format!(
                "update {version} available; auto-update is off (`conductor-daemon config auto-update on`)"
            ));
        }
        if version == own {
            return ignore(format!("already running {version}"));
        }
        if bad_versions.iter().any(|b| b == version) {
            return ignore(format!(
                "update {version} available; it was rolled back on this machine before, so it is skipped"
            ));
        }
        if self.version.as_deref() != Some(version) {
            // A newer build: a clean slate (a busy older update keeps its own course).
            if self.busy {
                return ignore(format!(
                    "update {version} available; still busy with {}",
                    self.version.as_deref().unwrap_or("another update")
                ));
            }
            *self = Policy {
                version: Some(version.to_string()),
                ..Policy::default()
            };
        }
        if self.busy {
            return ignore(format!("update {version} already in progress"));
        }
        if self.abandoned >= UPDATE_MAX_DRAIN_ATTEMPTS {
            return ignore(format!(
                "update {version} gave up {} times; not trying it again until a restart or a newer build",
                self.abandoned
            ));
        }
        if self.cooldown_until.is_some_and(|t| now_ms < t) {
            return ignore(format!(
                "update {version} is cooling down after a failed attempt"
            ));
        }
        self.busy = true;
        Decision::Stage
    }

    /// The attempt failed (a stage error, or a drain that hit its limit): count it and cool down.
    pub fn failed(&mut self, now_ms: u64) {
        self.busy = false;
        self.abandoned += 1;
        self.cooldown_until = Some(now_ms + UPDATE_DRAIN_COOLDOWN_MS);
    }

    /// The attempt ended without a failure (staged only, for an unsupervised daemon).
    pub fn idle(&mut self) {
        self.busy = false;
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u64 = 3_600_000;

    fn stage(p: &mut Policy, v: &str, now: u64) -> Decision {
        p.decide(v, "1.0.0", true, &[], now)
    }

    #[test]
    fn ignores_when_off_current_bad_or_busy() {
        let mut p = Policy::new();
        assert!(matches!(
            p.decide("2.0.0", "1.0.0", false, &[], 0),
            Decision::Ignore(w) if w.contains("auto-update is off")
        ));
        assert!(matches!(
            p.decide("1.0.0", "1.0.0", true, &[], 0),
            Decision::Ignore(w) if w.contains("already running")
        ));
        assert!(matches!(
            p.decide("2.0.0", "1.0.0", true, &["2.0.0".into()], 0),
            Decision::Ignore(w) if w.contains("rolled back")
        ));
        assert_eq!(stage(&mut p, "2.0.0", 0), Decision::Stage);
        assert!(p.is_busy());
        assert!(
            matches!(stage(&mut p, "2.0.0", 0), Decision::Ignore(w) if w.contains("in progress"))
        );
        assert!(
            matches!(stage(&mut p, "3.0.0", 0), Decision::Ignore(w) if w.contains("still busy"))
        );
    }

    #[test]
    fn a_failure_cools_down_for_an_hour_and_three_give_up() {
        let mut p = Policy::new();
        let mut now = 0;
        for i in 0..3 {
            assert_eq!(stage(&mut p, "2.0.0", now), Decision::Stage);
            p.failed(now);
            if i < 2 {
                assert!(
                    matches!(stage(&mut p, "2.0.0", now + H - 1), Decision::Ignore(w) if w.contains("cooling"))
                );
            }
            now += H;
        }
        assert!(
            matches!(stage(&mut p, "2.0.0", now + 10 * H), Decision::Ignore(w) if w.contains("gave up 3 times"))
        );
        // A newer build starts over.
        assert_eq!(stage(&mut p, "2.1.0", now), Decision::Stage);
    }

    #[test]
    fn an_idle_end_allows_the_next_announcement() {
        let mut p = Policy::new();
        assert_eq!(stage(&mut p, "2.0.0", 0), Decision::Stage);
        p.idle();
        assert_eq!(stage(&mut p, "2.0.0", 1), Decision::Stage);
    }
}
