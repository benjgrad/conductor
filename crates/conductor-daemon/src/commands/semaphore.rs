//! Port of `packages/daemon/src/commands/semaphore.ts` (MR-T05): the FIFO counting semaphore for
//! the per-machine build slots (07 §Compute, `max_concurrent_builds`).
//!
//! Explicit `release()` as in TS (the runner releases on process exit, not on a guard's drop), and
//! a released slot goes straight to the oldest waiter. Clones share the same slots.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Debug)]
struct State {
    active: usize,
    next_id: u64,
    waiters: VecDeque<(u64, oneshot::Sender<()>)>,
}

#[derive(Debug, Clone)]
pub struct Semaphore {
    size: usize,
    state: Arc<Mutex<State>>,
}

impl Semaphore {
    /// A semaphore with `size` slots; 0 is refused (TS: a `RangeError`).
    pub fn new(size: usize) -> Result<Self, String> {
        if size < 1 {
            return Err(format!(
                "semaphore size must be a positive integer, got {size}"
            ));
        }
        Ok(Semaphore {
            size,
            state: Arc::new(Mutex::new(State {
                active: 0,
                next_id: 0,
                waiters: VecDeque::new(),
            })),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn in_use(&self) -> usize {
        self.lock().active
    }

    pub fn waiting(&self) -> usize {
        self.lock().waiters.len()
    }

    /// Take a slot now if one is free.
    pub fn try_acquire(&self) -> bool {
        let mut s = self.lock();
        if s.active >= self.size {
            return false;
        }
        s.active += 1;
        true
    }

    /// Wait for a slot (FIFO), with the slot held on return.
    pub async fn acquire(&self) {
        self.acquire_until(std::future::pending::<()>()).await;
    }

    /// Wait for a slot (FIFO). True with the slot held, or false if `cancel` finished first (no
    /// slot held; the queue position is given up). A free slot is taken at once without polling
    /// `cancel`; TS refused an already-aborted signal first, so a caller that may already be
    /// cancelled checks that before calling (MR-T07's runner does).
    pub async fn acquire_until(&self, cancel: impl Future<Output = ()>) -> bool {
        let (id, rx) = {
            let mut s = self.lock();
            if s.active < self.size {
                s.active += 1;
                return true;
            }
            let (tx, rx) = oneshot::channel();
            let id = s.next_id;
            s.next_id += 1;
            s.waiters.push_back((id, tx));
            (id, rx)
        };
        let mut rx = rx;
        tokio::select! {
            biased;
            r = &mut rx => r.is_ok(),
            () = cancel => {
                let mut s = self.lock();
                if let Some(i) = s.waiters.iter().position(|(w, _)| *w == id) {
                    s.waiters.remove(i);
                    false
                } else {
                    drop(s);
                    // Granted while we were cancelling: the slot is ours, so hand it on.
                    if rx.try_recv().is_ok() {
                        self.release();
                    }
                    false
                }
            }
        }
    }

    /// Free a slot; the oldest waiter (if any) inherits it.
    pub fn release(&self) {
        let mut s = self.lock();
        while let Some((_, tx)) = s.waiters.pop_front() {
            if tx.send(()).is_ok() {
                return;
            }
            // That waiter's future was dropped: try the next one.
        }
        if s.active > 0 {
            s.active -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn is_fifo_and_hands_a_released_slot_to_the_oldest_waiter() {
        let s = Semaphore::new(1).unwrap();
        assert!(s.try_acquire());
        let order = Arc::new(Mutex::new(Vec::new()));
        let spawn = |name: &'static str| {
            let (s, order) = (s.clone(), order.clone());
            tokio::spawn(async move {
                s.acquire().await;
                order.lock().unwrap().push(name);
            })
        };
        let x = spawn("x");
        while s.waiting() < 1 {
            tokio::task::yield_now().await;
        }
        let y = spawn("y");
        while s.waiting() < 2 {
            tokio::task::yield_now().await;
        }
        s.release();
        x.await.unwrap();
        s.release();
        y.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["x", "y"]);
        s.release();
        assert_eq!(s.in_use(), 0);
    }

    #[test]
    fn rejects_a_non_positive_size() {
        assert!(Semaphore::new(0).is_err());
    }

    #[tokio::test]
    async fn a_cancelled_waiter_gives_up_its_place_and_holds_no_slot() {
        let s = Semaphore::new(1).unwrap();
        assert!(s.try_acquire());
        assert!(!s.acquire_until(async {}).await);
        assert_eq!(s.waiting(), 0);
        s.release();
        assert_eq!(s.in_use(), 0);
        assert!(s.acquire_until(std::future::pending()).await);
        assert_eq!(s.in_use(), 1);
    }
}
