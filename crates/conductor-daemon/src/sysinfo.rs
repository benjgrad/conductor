//! Port of `packages/daemon/src/sysinfo.ts` (MR-T05): live machine resources for `heartbeat` and
//! `request_work` (03). Injectable ([`SysInfo`]) so tests can fake memory pressure.

use crate::platform::{machine, sysres};
use std::path::Path;
use std::sync::Arc;

pub use crate::platform::sysres::parse_vm_stat_available_bytes;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LiveResources {
    /// Idle cores: from the 1-minute load average (Windows: CPU time since the last call).
    pub cpu_free: f64,
    pub mem_free_mb: u64,
    pub disk_free_mb: u64,
}

/// `(root_dir) -> LiveResources`, as TS's `SysInfo`.
pub type SysInfo = Arc<dyn Fn(&Path) -> LiveResources + Send + Sync>;

const MIB: u64 = 1024 * 1024;

/// The real resources, with `root_dir`'s file system for the disk figure (0 if it doesn't exist
/// yet).
pub fn live_resources(root_dir: &Path) -> LiveResources {
    let cores = machine::cpu_count() as f64;
    let load = sysres::busy_cores();
    LiveResources {
        cpu_free: (((cores - load) * 100.0).round() / 100.0).max(0.0),
        mem_free_mb: sysres::available_mem_bytes() / MIB,
        disk_free_mb: machine::disk_free_bytes(root_dir).map_or(0, |b| b / MIB),
    }
}

/// [`live_resources`] as a [`SysInfo`].
pub fn live_sysinfo() -> SysInfo {
    Arc::new(live_resources)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VM_STAT: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                7609.
Pages active:                            241092.
Pages inactive:                          230014.
Pages speculative:                          922.
Pages throttled:                              0.
Pages wired down:                        177054.
Pages purgeable:                           4457.
\"Translation faults\":                8646962438.
";

    #[test]
    fn counts_free_inactive_speculative_and_purgeable_pages() {
        assert_eq!(
            parse_vm_stat_available_bytes(VM_STAT),
            Some((7609 + 230014 + 922 + 4457) * 16384)
        );
    }

    #[test]
    fn returns_none_on_unparseable_output() {
        assert_eq!(parse_vm_stat_available_bytes(""), None);
        assert_eq!(
            parse_vm_stat_available_bytes(
                "Mach Virtual Memory Statistics: (page size of 4096 bytes)"
            ),
            None
        );
    }

    #[test]
    fn reports_more_than_the_raw_free_pages_on_macos() {
        // TS runs this on darwin only; the figures are sane on every OS.
        let r = live_resources(&std::env::current_dir().unwrap());
        if machine::is_macos() {
            assert!(r.mem_free_mb > 0);
        }
        assert!(r.cpu_free >= 0.0 && r.cpu_free.is_finite());
        assert!(r.disk_free_mb > 0);
    }

    #[test]
    fn a_missing_root_has_no_disk_figure() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(live_resources(&dir.path().join("missing")).disk_free_mb, 0);
    }
}
