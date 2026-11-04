//! Process signals for `conductor-daemon run` (MR-T13 FR-3, TD-211; the TS `process.once('SIGINT'
//! | 'SIGTERM')` and `watchSighup`):
//! - POSIX: SIGINT and SIGTERM stop the daemon gracefully; SIGHUP rescans the inventory.
//! - Windows: Ctrl-C, Ctrl-Break, closing the console, logoff and shutdown stop it gracefully.
//!   Windows has no SIGHUP: `conductor-daemon rescan` (the `<root>/state/rescan` trigger) is the
//!   way to ask for a rescan there.

use tokio::sync::mpsc;

/// What a signal asks the running daemon to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessSignal {
    /// Stop gracefully, then exit 0.
    Stop,
    /// Rescan the inventory now.
    Rescan,
}

/// Listen for the signals above, for the life of the process. Needs a tokio runtime. A listener
/// that can't be installed is skipped (logged through `log`), never fatal.
pub fn listen(
    log: impl Fn(&str) + Send + Sync + 'static,
) -> mpsc::UnboundedReceiver<ProcessSignal> {
    let (tx, rx) = mpsc::unbounded_channel();
    imp::listen(tx, &log);
    rx
}

#[cfg(unix)]
mod imp {
    use super::ProcessSignal;
    use tokio::signal::unix::{SignalKind, signal};
    use tokio::sync::mpsc::UnboundedSender;

    pub fn listen(tx: UnboundedSender<ProcessSignal>, log: &dyn Fn(&str)) {
        for (kind, name, what) in [
            (SignalKind::interrupt(), "SIGINT", ProcessSignal::Stop),
            (SignalKind::terminate(), "SIGTERM", ProcessSignal::Stop),
            (SignalKind::hangup(), "SIGHUP", ProcessSignal::Rescan),
        ] {
            match signal(kind) {
                Ok(mut s) => {
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        while s.recv().await.is_some() {
                            if tx.send(what).is_err() {
                                break;
                            }
                        }
                    });
                }
                Err(e) => log(&format!("cannot listen for {name}: {e}")),
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::ProcessSignal;
    use tokio::signal::windows;
    use tokio::sync::mpsc::UnboundedSender;

    macro_rules! forward {
        ($tx:expr, $log:expr, $make:expr, $name:literal) => {
            match $make {
                Ok(mut s) => {
                    let tx = $tx.clone();
                    tokio::spawn(async move {
                        while s.recv().await.is_some() {
                            if tx.send(ProcessSignal::Stop).is_err() {
                                break;
                            }
                        }
                    });
                }
                Err(e) => $log(&format!("cannot listen for {}: {e}", $name)),
            }
        };
    }

    pub fn listen(tx: UnboundedSender<ProcessSignal>, log: &dyn Fn(&str)) {
        forward!(tx, log, windows::ctrl_c(), "Ctrl-C");
        forward!(tx, log, windows::ctrl_break(), "Ctrl-Break");
        forward!(tx, log, windows::ctrl_close(), "console close");
        forward!(tx, log, windows::ctrl_logoff(), "logoff");
        forward!(tx, log, windows::ctrl_shutdown(), "shutdown");
    }
}
