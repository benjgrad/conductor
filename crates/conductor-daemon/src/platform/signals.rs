//! The signals `conductor-daemon run` listens to (MR-T13b; TS `main.ts` `process.once('SIGINT' |
//! 'SIGTERM')` and `watchSighup`).
//!
//! - POSIX: SIGINT and SIGTERM stop the daemon; SIGHUP rescans the inventory (M2-T10).
//! - Windows: Ctrl-C and the console closing stop it; Ctrl-Break rescans (MW-T09's twin of SIGHUP,
//!   next to `conductor-daemon rescan`). A Scheduled Task stop (`schtasks /End`, `service
//!   restart|uninstall`, logoff) is TerminateProcess and sends no console event (U-108), so the
//!   daemon gets no chance to drain there (TD-190; `commands/service.rs`).

use tokio::sync::mpsc;

/// What a signal asks the running daemon to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonSignal {
    /// Stop gracefully and exit 0.
    Shutdown,
    /// Rescan the inventory now.
    Rescan,
}

/// Start listening; every signal arrives on the returned channel. Needs a tokio runtime.
pub fn daemon_signals() -> std::io::Result<mpsc::UnboundedReceiver<DaemonSignal>> {
    let (tx, rx) = mpsc::unbounded_channel();
    imp::listen(tx)?;
    Ok(rx)
}

#[cfg(unix)]
mod imp {
    use super::DaemonSignal;
    use tokio::signal::unix::{SignalKind, signal};
    use tokio::sync::mpsc::UnboundedSender;

    pub fn listen(tx: UnboundedSender<DaemonSignal>) -> std::io::Result<()> {
        for (kind, what) in [
            (SignalKind::interrupt(), DaemonSignal::Shutdown),
            (SignalKind::terminate(), DaemonSignal::Shutdown),
            (SignalKind::hangup(), DaemonSignal::Rescan),
        ] {
            let mut s = signal(kind)?;
            let tx = tx.clone();
            tokio::spawn(async move {
                while s.recv().await.is_some() {
                    if tx.send(what).is_err() {
                        break;
                    }
                }
            });
        }
        Ok(())
    }
}

#[cfg(windows)]
mod imp {
    use super::DaemonSignal;
    use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close};
    use tokio::sync::mpsc::UnboundedSender;

    pub fn listen(tx: UnboundedSender<DaemonSignal>) -> std::io::Result<()> {
        let mut c = ctrl_c()?;
        let mut close = ctrl_close()?;
        let mut brk = ctrl_break()?;
        let t = tx.clone();
        tokio::spawn(async move {
            while c.recv().await.is_some() {
                if t.send(DaemonSignal::Shutdown).is_err() {
                    break;
                }
            }
        });
        let t = tx.clone();
        tokio::spawn(async move {
            while close.recv().await.is_some() {
                if t.send(DaemonSignal::Shutdown).is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while brk.recv().await.is_some() {
                if tx.send(DaemonSignal::Rescan).is_err() {
                    break;
                }
            }
        });
        Ok(())
    }
}
