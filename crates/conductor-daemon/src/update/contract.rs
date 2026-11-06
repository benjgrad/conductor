//! The announced build (`update_available`, ADR-0021 §1) and the checks the zod schema makes but
//! the generated Rust types don't (TD-196): `file` names exactly `version`.

use std::sync::LazyLock;

use conductor_protocol::{
    DAEMON_TARBALL_MAX_BYTES, DAEMON_TARBALL_RE, DAEMON_TARGET_RE, DAEMON_VERSION_RE,
    UpdateAvailablePayload,
};
use regress::Regex;

static TARBALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(DAEMON_TARBALL_RE).unwrap());
static TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(DAEMON_TARGET_RE).unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(DAEMON_VERSION_RE).unwrap());

fn full(re: &Regex, s: &str) -> bool {
    re.find(s).is_some()
}

/// A daemon version (`DAEMON_VERSION_RE`): also what makes it safe as a path segment. `.` and
/// `..` match the pattern, so they are refused here.
pub fn version_ok(v: &str) -> bool {
    full(&VERSION, v) && v != "." && v != ".."
}

/// The port of `daemonTarballMatches` (shared/src/machines/update.ts): `file` is
/// `conductor-daemon-<version>.tgz` or `conductor-daemon-<version>-<target>.tgz`.
pub fn daemon_tarball_matches(file: &str, version: &str) -> bool {
    if !full(&TARBALL, file) || !version_ok(version) {
        return false;
    }
    let prefix = format!("conductor-daemon-{version}");
    if file == format!("{prefix}.tgz") {
        return true;
    }
    let Some(rest) = file.strip_prefix(&format!("{prefix}-")) else {
        return false;
    };
    let Some(target) = rest.strip_suffix(".tgz") else {
        return false;
    };
    full(&TARGET, target)
}

/// One served build: `{version, file, sha256, size}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonBuild {
    pub version: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

impl DaemonBuild {
    /// Why this build can't be fetched, if it can't.
    pub fn problem(&self) -> Option<String> {
        if !daemon_tarball_matches(&self.file, &self.version) {
            return Some(format!(
                "{} is not a daemon tarball for {}",
                self.file, self.version
            ));
        }
        if self.size == 0 || self.size > DAEMON_TARBALL_MAX_BYTES as u64 {
            return Some(format!("bad size {}", self.size));
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Some("bad sha256".into());
        }
        None
    }
}

impl From<&UpdateAvailablePayload> for DaemonBuild {
    fn from(p: &UpdateAvailablePayload) -> Self {
        DaemonBuild {
            version: p.version.to_string(),
            file: p.file.to_string(),
            sha256: p.sha256.to_string(),
            size: p.size.get(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vectors of `update.test.ts › daemonTarballMatches`.
    #[test]
    fn tarball_names_match_the_ts_vectors() {
        for (file, version, ok) in [
            ("conductor-daemon-0.3.0.tgz", "0.3.0", true),
            ("conductor-daemon-0.3.0+abc1234.tgz", "0.3.0+abc1234", true),
            (
                "conductor-daemon-0.3.0-x86_64-unknown-linux-gnu.tgz",
                "0.3.0",
                true,
            ),
            (
                "conductor-daemon-0.3.0-rc.1-aarch64-apple-darwin.tgz",
                "0.3.0-rc.1",
                true,
            ),
            (
                "conductor-daemon-0.3.0-x86_64-pc-windows-msvc.tgz",
                "0.3.0",
                true,
            ),
            ("conductor-daemon-1.2.30.tgz", "1.2.3", false),
            ("conductor-daemon-1.2-3.tgz", "1.2", false),
            (
                "conductor-daemon-0.3.0-X86_64-Apple-Darwin.tgz",
                "0.3.0",
                false,
            ),
            ("conductor-daemon-0.3.0.tar.gz", "0.3.0", false),
            ("conductor-daemon-0.4.0.tgz", "0.3.0", false),
            ("../conductor-daemon-0.3.0.tgz", "0.3.0", false),
            ("conductor-daemon-0.3.0.tgz", "0.3.0/..", false),
        ] {
            assert_eq!(
                daemon_tarball_matches(file, version),
                ok,
                "{file} {version}"
            );
        }
    }

    #[test]
    fn versions_are_safe_path_segments() {
        assert!(version_ok("0.3.0+abc1234"));
        assert!(!version_ok(".."));
        assert!(!version_ok("."));
        assert!(!version_ok("a/b"));
        assert!(!version_ok("a\\b"));
        assert!(!version_ok(""));
    }

    #[test]
    fn a_build_with_a_bad_size_or_sha_has_a_problem() {
        let ok = DaemonBuild {
            version: "1.0.0".into(),
            file: "conductor-daemon-1.0.0.tgz".into(),
            sha256: "a".repeat(64),
            size: 10,
        };
        assert_eq!(ok.problem(), None);
        assert!(
            DaemonBuild {
                size: 0,
                ..ok.clone()
            }
            .problem()
            .is_some()
        );
        assert!(
            DaemonBuild {
                size: DAEMON_TARBALL_MAX_BYTES as u64 + 1,
                ..ok.clone()
            }
            .problem()
            .is_some()
        );
        assert!(
            DaemonBuild {
                sha256: "A".repeat(64),
                ..ok.clone()
            }
            .problem()
            .is_some()
        );
        assert!(
            DaemonBuild {
                file: "conductor-daemon-2.0.0.tgz".into(),
                ..ok
            }
            .problem()
            .is_some()
        );
    }
}
