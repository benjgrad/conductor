//! Port of `packages/daemon/src/ports.ts` (MR-T05): per-session port ranges from a fixed pool
//! (07 §Ports). Ranges are aligned to `range_size` from `start`. The env passed to the session is
//! `CONDUCTOR_PORT_BASE`, `PORT`, `CONDUCTOR_PORT_COUNT`.

use crate::config::PortPoolConfig;
use crate::store::PortRange;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("port pool exhausted")]
pub struct PortPoolExhausted;

#[derive(Debug, Clone)]
pub struct PortPool {
    cfg: PortPoolConfig,
    /// base → session_id. Ordered by base, so `range_of` finds the lowest, as TS's Map did (ranges
    /// were inserted lowest-first there too, except after an adopt; a session holds one range).
    owners: BTreeMap<u32, String>,
}

impl PortPool {
    pub fn new(cfg: PortPoolConfig) -> Self {
        PortPool {
            cfg,
            owners: BTreeMap::new(),
        }
    }

    pub fn capacity(&self) -> u32 {
        (self.cfg.end - self.cfg.start + 1) / self.cfg.range_size
    }

    /// Re-adopt a range persisted for a session (after a daemon restart). False if unusable.
    pub fn adopt(&mut self, session_id: &str, range: PortRange) -> bool {
        let size = self.cfg.range_size;
        if range.count != size
            || range.base < self.cfg.start
            || !(range.base - self.cfg.start).is_multiple_of(size)
            || u64::from(range.base) + u64::from(range.count) - 1 > u64::from(self.cfg.end)
        {
            return false;
        }
        if let Some(owner) = self.owners.get(&range.base)
            && owner != session_id
        {
            return false;
        }
        self.owners.insert(range.base, session_id.to_string());
        true
    }

    /// The session's existing range, else the first free one.
    pub fn allocate(&mut self, session_id: &str) -> Result<PortRange, PortPoolExhausted> {
        if let Some(existing) = self.range_of(session_id) {
            return Ok(existing);
        }
        for i in 0..self.capacity() {
            let base = self.cfg.start + i * self.cfg.range_size;
            if let std::collections::btree_map::Entry::Vacant(e) = self.owners.entry(base) {
                e.insert(session_id.to_string());
                return Ok(PortRange {
                    base,
                    count: self.cfg.range_size,
                });
            }
        }
        Err(PortPoolExhausted)
    }

    pub fn range_of(&self, session_id: &str) -> Option<PortRange> {
        self.owners
            .iter()
            .find(|(_, owner)| *owner == session_id)
            .map(|(&base, _)| PortRange {
                base,
                count: self.cfg.range_size,
            })
    }

    pub fn release(&mut self, session_id: &str) {
        self.owners.retain(|_, owner| owner != session_id);
    }

    pub fn allocated(&self) -> usize {
        self.owners.len()
    }
}

/// The session env for a range: `CONDUCTOR_PORT_BASE`, `PORT`, `CONDUCTOR_PORT_COUNT`.
pub fn port_env(range: PortRange) -> Vec<(String, String)> {
    vec![
        ("CONDUCTOR_PORT_BASE".into(), range.base.to_string()),
        ("PORT".into(), range.base.to_string()),
        ("CONDUCTOR_PORT_COUNT".into(), range.count.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_aligned_ranges_reuses_a_sessions_range_and_reports_exhaustion() {
        let r = |base, count| PortRange { base, count };
        let mut pool = PortPool::new(PortPoolConfig {
            start: 100,
            end: 119,
            range_size: 10,
        });
        assert_eq!(pool.allocate("a"), Ok(r(100, 10)));
        assert_eq!(pool.allocate("a"), Ok(r(100, 10)));
        assert_eq!(pool.allocate("b"), Ok(r(110, 10)));
        assert_eq!(pool.allocate("c"), Err(PortPoolExhausted));
        pool.release("a");
        assert_eq!(pool.allocate("c"), Ok(r(100, 10)));
        assert!(!pool.adopt("d", r(110, 10))); // owned by b
        assert!(!pool.adopt("b", r(105, 10))); // misaligned
        assert_eq!(
            port_env(r(100, 10)),
            vec![
                ("CONDUCTOR_PORT_BASE".to_string(), "100".to_string()),
                ("PORT".to_string(), "100".to_string()),
                ("CONDUCTOR_PORT_COUNT".to_string(), "10".to_string()),
            ]
        );
    }

    #[test]
    fn adopt_refuses_out_of_pool_and_wrong_size_ranges() {
        let mut pool = PortPool::new(PortPoolConfig {
            start: 100,
            end: 119,
            range_size: 10,
        });
        assert!(!pool.adopt(
            "a",
            PortRange {
                base: 90,
                count: 10
            }
        ));
        assert!(!pool.adopt(
            "a",
            PortRange {
                base: 120,
                count: 10
            }
        ));
        assert!(!pool.adopt(
            "a",
            PortRange {
                base: 100,
                count: 5
            }
        ));
        assert!(pool.adopt(
            "a",
            PortRange {
                base: 110,
                count: 10
            }
        ));
        assert_eq!(pool.allocated(), 1);
        assert_eq!(pool.capacity(), 2);
    }
}
