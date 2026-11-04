//! Port of `packages/daemon/src/ws-client.ts` (MR-T07).
//!
//! The daemon's one outbound WebSocket to the orchestrator (03), reconnecting with exponential
//! backoff and ±20 % jitter. The backoff resets when the caller says the link is healthy
//! ([`ReconnectingWs::reset_backoff`], called on `registered`), not merely on TCP open.
//!
//! M2-T04 (10-contracts §Machines protocol v2): optional upgrade headers (the machine credential).
//! Close 4001 (revoked), 4003 (unauthorized) or 4005 (protocol too old), or HTTP 401/403 at the
//! upgrade (treated as 4003), is fatal: no reconnect, the log says why, `on_fatal` runs once.
//! M2-T18 (TD-119): `main` exits with [`fatal_exit_code`] = [`EXIT_FATAL_AUTH`] (78), which the
//! service units don't restart. Wake (ADR-0021 §5): a 5 s tick that sees the wall clock jump by
//! more than 30 s (the machine slept) resets the backoff and reconnects at once.
//!
//! One supervisor task owns the socket: it connects, reads, writes (frames queued by
//! [`ReconnectingWs::send`]) and sleeps out the backoff. Handlers are called from that task, in
//! frame order, with no lock held. TLS (`wss://`) uses rustls with its one compiled-in provider
//! (aws-lc-rs), so no provider has to be installed by hand.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use conductor_protocol::{CLOSE_PROTOCOL, CLOSE_REVOKED, CLOSE_UNAUTHORIZED};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Notify, mpsc};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::config::BackoffConfig;

/// `EX_CONFIG`: the link can't recover by restarting; systemd `RestartPreventExitStatus` (TD-119).
pub const EXIT_FATAL_AUTH: i32 = 78;

/// Why a fatal close code is fatal (the log line); `None` for any other code.
pub fn fatal_why(code: u16) -> Option<&'static str> {
    match code {
        CLOSE_REVOKED => {
            Some("machine revoked: enroll it again with a new token (conductor-daemon enroll)")
        }
        CLOSE_UNAUTHORIZED => Some(
            "unauthorized: the machine credential was refused; enroll again (conductor-daemon enroll --force)",
        ),
        CLOSE_PROTOCOL => {
            Some("protocol version not supported: update the daemon: re-run the install command")
        }
        _ => None,
    }
}

/// The process exit code for a fatal close (4001, 4003 incl. HTTP 401/403, 4005); 1 otherwise.
pub fn fatal_exit_code(close_code: u16) -> i32 {
    if fatal_why(close_code).is_some() {
        EXIT_FATAL_AUTH
    } else {
        1
    }
}

/// `min(max, initial * factor^attempt)` with ±20 % jitter (`rand` in [0, 1)), at least 1 ms.
pub fn backoff_delay(cfg: &BackoffConfig, attempt: u32, rand: impl FnOnce() -> f64) -> u64 {
    let grown = cfg.initial_ms as f64 * cfg.factor.powf(f64::from(attempt));
    let base = if grown.is_finite() {
        grown.min(cfg.max_ms as f64)
    } else {
        cfg.max_ms as f64
    };
    (base * (0.8 + 0.4 * rand())).round().max(1.0) as u64
}

/// `WsClientHandlers`.
pub trait WsHandlers: Send + Sync + 'static {
    /// The socket is open; [`ReconnectingWs::send`] already works.
    fn on_open(&self);
    fn on_message(&self, text: String);
    fn on_close(&self);
    /// The link can't recover (revoked, unauthorized, protocol too old); reconnecting has stopped.
    fn on_fatal(&self, _code: u16, _reason: &str) {}
}

pub type WsLog = Arc<dyn Fn(&str) + Send + Sync>;
/// Wall clock in ms (the TS `now`).
pub type WallClock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// `WsClientOptions`.
#[derive(Clone)]
pub struct WsClientOptions {
    /// Sent on every upgrade request (e.g. `authorization: Bearer <credential>`).
    pub headers: Vec<(String, String)>,
    /// Default: `tracing::info!`.
    pub log: Option<WsLog>,
    /// Default: the system clock.
    pub now: Option<WallClock>,
    /// Wake check period (default 5 s).
    pub wake_tick: Duration,
    /// A tick later than expected by more than this is a wake (default 30 s).
    pub wake_jump: Duration,
    /// The upgrade must finish within this (default 10 s, the TS `handshakeTimeout`).
    pub handshake_timeout: Duration,
}

impl Default for WsClientOptions {
    fn default() -> Self {
        WsClientOptions {
            headers: Vec::new(),
            log: None,
            now: None,
            wake_tick: Duration::from_secs(5),
            wake_jump: Duration::from_secs(30),
            handshake_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Connecting,
    Open,
    Backoff,
}

struct State {
    stopped: bool,
    fatal: bool,
    attempt: u32,
    phase: Phase,
    /// Frames for the open socket; `None` unless it is open.
    writer: Option<mpsc::UnboundedSender<Message>>,
    /// Ends the open socket (`terminate`).
    terminate: Option<Arc<Notify>>,
    /// Ends the current backoff sleep early (wake).
    backoff_wake: Option<Arc<Notify>>,
    /// The open socket's close code, for the reconnect log (TS's `close` event code: 1005 for a
    /// close frame without one, 1006 for an abnormal end); `None` after a refused upgrade.
    last_close: Option<u16>,
    last_tick: i64,
    tasks: Vec<AbortHandle>,
}

struct Inner {
    url: String,
    backoff: BackoffConfig,
    handlers: Arc<dyn WsHandlers>,
    headers: Vec<(String, String)>,
    log: Option<WsLog>,
    now: WallClock,
    wake_tick: Duration,
    wake_jump: Duration,
    handshake_timeout: Duration,
    state: Mutex<State>,
}

/// `ReconnectingWs`. Clones share one link. Needs a tokio runtime from `start` on.
#[derive(Clone)]
pub struct ReconnectingWs(Arc<Inner>);

fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The backoff log line: with the close code when the socket was open (none after a refused
/// upgrade, which logs its HTTP status itself).
pub fn reconnect_line(code: Option<u16>, delay: u64) -> String {
    match code {
        Some(c) => format!("ws closed ({c}); reconnecting in {delay} ms"),
        None => format!("ws closed; reconnecting in {delay} ms"),
    }
}

/// How a connection ended.
enum End {
    Dropped,
    Fatal(u16, String),
}

impl ReconnectingWs {
    pub fn new(
        url: impl Into<String>,
        backoff: BackoffConfig,
        handlers: Arc<dyn WsHandlers>,
        opts: WsClientOptions,
    ) -> Self {
        ReconnectingWs(Arc::new(Inner {
            url: url.into(),
            backoff,
            handlers,
            headers: opts.headers,
            log: opts.log,
            now: opts.now.unwrap_or_else(|| Arc::new(system_now_ms)),
            wake_tick: opts.wake_tick,
            wake_jump: opts.wake_jump,
            handshake_timeout: opts.handshake_timeout,
            state: Mutex::new(State {
                stopped: true,
                fatal: false,
                attempt: 0,
                phase: Phase::Idle,
                writer: None,
                terminate: None,
                backoff_wake: None,
                last_close: None,
                last_tick: 0,
                tasks: Vec::new(),
            }),
        }))
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log(&self, msg: &str) {
        match &self.0.log {
            Some(l) => l(msg),
            None => tracing::info!("{msg}"),
        }
    }

    /// Reconnect attempts since the last healthy link (the backoff exponent).
    pub fn attempts(&self) -> u32 {
        self.st().attempt
    }

    pub fn connected(&self) -> bool {
        self.st().phase == Phase::Open
    }

    /// True once a fatal close stopped the client for good.
    pub fn failed(&self) -> bool {
        self.st().fatal
    }

    pub fn start(&self) {
        let mut s = self.st();
        if !s.stopped || s.fatal {
            return;
        }
        s.stopped = false;
        s.phase = Phase::Connecting;
        s.last_tick = (self.0.now)();
        let sup = tokio::spawn(self.clone().supervise());
        let wake = tokio::spawn(self.clone().wake_loop());
        s.tasks = vec![sup.abort_handle(), wake.abort_handle()];
    }

    /// Stop for good (until `start`): no reconnect and no `on_close` (the caller does its own).
    pub fn stop(&self) {
        let tasks = {
            let mut s = self.st();
            s.stopped = true;
            s.phase = Phase::Idle;
            s.writer = None;
            s.terminate = None;
            s.backoff_wake = None;
            std::mem::take(&mut s.tasks)
        };
        // Aborting the supervisor drops the socket with it.
        for t in tasks {
            t.abort();
        }
    }

    pub fn reset_backoff(&self) {
        self.st().attempt = 0;
    }

    /// Send one frame. False when not connected (the caller decides whether to buffer).
    pub fn send(&self, text: &str) -> bool {
        let s = self.st();
        match &s.writer {
            Some(w) => w.send(Message::Text(text.into())).is_ok(),
            None => false,
        }
    }

    /// Drop the current socket and reconnect (e.g. after a protocol violation).
    pub fn reconnect(&self) {
        if let Some(t) = &self.st().terminate {
            t.notify_one();
        }
    }

    async fn supervise(self) {
        loop {
            if self.st().stopped {
                return;
            }
            match self.connect_once().await {
                End::Fatal(code, reason) => {
                    self.fail(code, &reason);
                    return;
                }
                End::Dropped => {
                    if !self.dropped() {
                        return;
                    }
                    self.backoff().await;
                }
            }
        }
    }

    /// One connection, from the upgrade to its end.
    async fn connect_once(&self) -> End {
        let mut req = match self.0.url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                self.log(&format!("ws error: {e}"));
                return End::Dropped;
            }
        };
        for (k, v) in &self.0.headers {
            match (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                (Ok(k), Ok(v)) => {
                    req.headers_mut().insert(k, v);
                }
                _ => self.log(&format!("ws: skipping an invalid upgrade header {k}")),
            }
        }
        let ws = match tokio::time::timeout(
            self.0.handshake_timeout,
            tokio_tungstenite::connect_async(req),
        )
        .await
        {
            Err(_) => {
                self.log("ws error: opening handshake has timed out");
                return End::Dropped;
            }
            Ok(Err(WsError::Http(resp))) => {
                // 401/403 are fatal (the contract answers an unknown or revoked credential with
                // HTTP 401); anything else retries.
                let status = resp.status().as_u16();
                if status == 401 || status == 403 {
                    return End::Fatal(CLOSE_UNAUTHORIZED, format!("HTTP {status} at the upgrade"));
                }
                self.log(&format!("ws upgrade refused: HTTP {status}"));
                return End::Dropped;
            }
            Ok(Err(e)) => {
                self.log(&format!("ws error: {e}"));
                return End::Dropped;
            }
            Ok(Ok((ws, _))) => ws,
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let terminate = Arc::new(Notify::new());
        {
            let mut s = self.st();
            if s.stopped {
                return End::Dropped;
            }
            // Before on_open: the daemon sends `register` from it.
            s.writer = Some(tx);
            s.terminate = Some(terminate.clone());
            s.phase = Phase::Open;
        }
        self.0.handlers.on_open();
        let mut ws = ws;
        let code = loop {
            tokio::select! {
                m = ws.next() => match m {
                    Some(Ok(Message::Text(t))) => self.0.handlers.on_message(t.to_string()),
                    Some(Ok(Message::Close(Some(f)))) => {
                        let code = u16::from(f.code);
                        if fatal_why(code).is_some() {
                            return End::Fatal(code, f.reason.to_string());
                        }
                        break code;
                    }
                    Some(Ok(Message::Close(None))) => break 1005,
                    None | Some(Err(_)) => break 1006,
                    // Binary frames are ignored, as in TS; pings are answered by tungstenite.
                    Some(Ok(_)) => {}
                },
                out = rx.recv() => match out {
                    Some(m) => {
                        if ws.send(m).await.is_err() {
                            break 1006;
                        }
                    }
                    None => break 1006,
                },
                () = terminate.notified() => break 1006,
            }
        };
        self.st().last_close = Some(code);
        End::Dropped
    }

    /// The socket went away (not fatally). False if the client was stopped meanwhile.
    fn dropped(&self) -> bool {
        {
            let mut s = self.st();
            s.writer = None;
            s.terminate = None;
            if s.stopped {
                return false;
            }
            s.phase = Phase::Connecting;
        }
        self.0.handlers.on_close();
        true
    }

    async fn backoff(&self) {
        let (delay, wake, code) = {
            let mut s = self.st();
            if s.stopped {
                return;
            }
            let delay = backoff_delay(&self.0.backoff, s.attempt, rand::random::<f64>);
            s.attempt += 1;
            s.phase = Phase::Backoff;
            let wake = Arc::new(Notify::new());
            s.backoff_wake = Some(wake.clone());
            (delay, wake, s.last_close.take())
        };
        self.log(&reconnect_line(code, delay));
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(delay)) => {}
            () = wake.notified() => {}
        }
        let mut s = self.st();
        s.backoff_wake = None;
        if !s.stopped {
            s.phase = Phase::Connecting;
        }
    }

    fn fail(&self, code: u16, reason: &str) {
        let tasks = {
            let mut s = self.st();
            s.fatal = true;
            s.stopped = true;
            s.phase = Phase::Idle;
            s.writer = None;
            s.terminate = None;
            s.backoff_wake = None;
            // Only the wake task: this runs on the supervisor, which returns right after.
            std::mem::take(&mut s.tasks)
        };
        if let Some(wake) = tasks.get(1) {
            wake.abort();
        }
        let why = fatal_why(code).unwrap_or("");
        let reason_part = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        self.log(&format!(
            "ws closed {code}{reason_part}: {why}; not reconnecting"
        ));
        self.0.handlers.on_close();
        self.0.handlers.on_fatal(code, reason);
    }

    /// Timers stall while the machine sleeps: a late tick means it woke, so don't wait out a
    /// backoff.
    async fn wake_loop(self) {
        loop {
            tokio::time::sleep(self.0.wake_tick).await;
            let now = (self.0.now)();
            let jumped = {
                let mut s = self.st();
                let gap = now - s.last_tick;
                s.last_tick = now;
                if s.stopped
                    || gap - self.0.wake_tick.as_millis() as i64
                        <= self.0.wake_jump.as_millis() as i64
                {
                    None
                } else {
                    s.attempt = 0;
                    let notify = match s.phase {
                        Phase::Backoff => s.backoff_wake.clone(),
                        // After a long sleep the server has usually dropped the socket; the
                        // dropped path reconnects at attempt 0.
                        Phase::Open => s.terminate.clone(),
                        Phase::Idle | Phase::Connecting => None,
                    };
                    Some((gap, notify))
                }
            };
            if let Some((gap, notify)) = jumped {
                self.log(&format!(
                    "wall clock jumped {gap} ms (wake); reconnecting now"
                ));
                if let Some(n) = notify {
                    n.notify_one();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // Real sockets on 127.0.0.1 against the fake orchestrator: the reconnect path is what's under
    // test.
    use super::*;
    use crate::test_support::fake_orchestrator::FakeOrchestrator;
    use conductor_protocol::{DAEMON_AUTH_HEADER, auth::daemon_auth_header_value};
    use std::sync::atomic::{AtomicI64, Ordering};

    const BACKOFF: BackoffConfig = BackoffConfig {
        initial_ms: 10,
        max_ms: 20,
        factor: 2.0,
    };

    #[derive(Default)]
    struct Ev {
        opens: usize,
        closes: usize,
        fatal: Vec<u16>,
        logs: Vec<String>,
    }

    #[derive(Default)]
    struct Rec(Mutex<Ev>);

    impl Rec {
        fn ev(&self) -> MutexGuard<'_, Ev> {
            self.0.lock().unwrap()
        }
        fn logs(&self) -> String {
            self.ev().logs.join("\n")
        }
    }

    impl WsHandlers for Rec {
        fn on_open(&self) {
            self.ev().opens += 1;
        }
        fn on_message(&self, _text: String) {}
        fn on_close(&self) {
            self.ev().closes += 1;
        }
        fn on_fatal(&self, code: u16, _reason: &str) {
            self.ev().fatal.push(code);
        }
    }

    /// Stops the client when the test ends.
    struct Client {
        c: ReconnectingWs,
        ev: Arc<Rec>,
    }

    impl Drop for Client {
        fn drop(&mut self) {
            self.c.stop();
        }
    }

    fn client(url: &str, headers: Vec<(String, String)>, opts: Option<WsClientOptions>) -> Client {
        client_with(url, BACKOFF, headers, opts)
    }

    fn client_with(
        url: &str,
        backoff: BackoffConfig,
        headers: Vec<(String, String)>,
        opts: Option<WsClientOptions>,
    ) -> Client {
        let ev = Arc::new(Rec::default());
        let log_ev = ev.clone();
        let opts = WsClientOptions {
            headers,
            log: Some(Arc::new(move |m: &str| {
                log_ev.ev().logs.push(m.to_string())
            })),
            ..opts.unwrap_or_default()
        };
        let c = ReconnectingWs::new(url, backoff, ev.clone(), opts);
        c.start();
        Client { c, ev }
    }

    async fn until(pred: impl Fn() -> bool, ms: u64) {
        let end = tokio::time::Instant::now() + Duration::from_millis(ms);
        while !pred() {
            assert!(tokio::time::Instant::now() < end, "until: timed out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Several backoff windows.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    /// A wall clock that can jump ahead.
    fn fake_clock() -> (WallClock, Arc<AtomicI64>) {
        let offset = Arc::new(AtomicI64::new(0));
        let o = offset.clone();
        (
            Arc::new(move || system_now_ms() + o.load(Ordering::SeqCst)),
            offset,
        )
    }

    #[test]
    fn backoff_grows_exponentially_with_jitter_and_is_capped() {
        let cfg = BackoffConfig {
            initial_ms: 100,
            max_ms: 1000,
            factor: 2.0,
        };
        assert_eq!(backoff_delay(&cfg, 0, || 0.5), 100);
        assert_eq!(backoff_delay(&cfg, 3, || 0.5), 800);
        assert_eq!(backoff_delay(&cfg, 10, || 0.5), 1000);
        assert_eq!(backoff_delay(&cfg, 10, || 1.0), 1200);
        assert_eq!(backoff_delay(&cfg, 0, || 0.0), 80);
        assert_eq!(backoff_delay(&cfg, u32::MAX, || 0.5), 1000);
    }

    #[test]
    fn fatal_why_covers_exactly_the_three_fatal_codes() {
        for code in [CLOSE_REVOKED, CLOSE_UNAUTHORIZED, CLOSE_PROTOCOL] {
            assert!(fatal_why(code).is_some(), "{code}");
        }
        for code in [1000, 1001, 1006, 4000, 4002, 4004] {
            assert_eq!(fatal_why(code), None, "{code}");
        }
    }

    #[test]
    fn any_other_code_exits_1() {
        assert_eq!(fatal_exit_code(1000), 1);
        assert_eq!(fatal_exit_code(1006), 1);
        assert_eq!(fatal_exit_code(CLOSE_REVOKED), EXIT_FATAL_AUTH);
    }

    #[tokio::test]
    async fn sends_the_bearer_header_when_enrolled_and_none_in_local_mode() {
        let o = FakeOrchestrator::start().await.unwrap();
        let header = vec![(
            DAEMON_AUTH_HEADER.to_string(),
            daemon_auth_header_value("cred-1"),
        )];
        let _a = client(&o.url(), header, None);
        let _b = client(&o.url(), vec![], None);
        until(|| o.auth_headers().len() == 2, 3000).await;
        let h = o.auth_headers();
        assert!(h.contains(&Some("Bearer cred-1".to_string())));
        assert!(h.contains(&None));
    }

    #[tokio::test]
    async fn close_4001_stops_reconnecting_and_reports_it_once() {
        let o = FakeOrchestrator::start().await.unwrap();
        let cl = client(&o.url(), vec![], None);
        until(|| cl.ev.ev().opens == 1, 3000).await;
        o.close_with(CLOSE_REVOKED);
        until(|| cl.ev.ev().fatal.len() == 1, 3000).await;
        settle().await;
        assert_eq!(cl.ev.ev().fatal, [CLOSE_REVOKED]);
        assert_eq!(fatal_exit_code(cl.ev.ev().fatal[0]), EXIT_FATAL_AUTH);
        assert_eq!(o.connections(), 1);
        assert!(cl.c.failed());
        let logs = cl.ev.logs();
        let at = logs.find("machine revoked").expect("logged why");
        assert!(logs[at..].contains("not reconnecting"), "{logs}");
        cl.c.start(); // a failed client stays stopped
        settle().await;
        assert_eq!(o.connections(), 1);
    }

    #[tokio::test]
    async fn close_4003_is_fatal_too_4005_says_to_rerun_the_install_command() {
        for code in [CLOSE_UNAUTHORIZED, CLOSE_PROTOCOL] {
            let o = FakeOrchestrator::start().await.unwrap();
            let cl = client(&o.url(), vec![], None);
            until(|| cl.ev.ev().opens == 1, 3000).await;
            o.close_with(code);
            until(|| cl.ev.ev().fatal.len() == 1, 3000).await;
            settle().await;
            assert_eq!(o.connections(), 1);
            assert_eq!(fatal_exit_code(cl.ev.ev().fatal[0]), EXIT_FATAL_AUTH);
            if code == CLOSE_PROTOCOL {
                assert!(
                    cl.ev
                        .logs()
                        .contains("update the daemon: re-run the install command")
                );
            }
        }
    }

    #[tokio::test]
    async fn http_401_and_403_at_the_upgrade_are_unauthorized_no_retries_exit_78() {
        for status in [401, 403] {
            let o = FakeOrchestrator::start().await.unwrap();
            o.set_reject_upgrade(Some(status));
            let header = vec![(
                DAEMON_AUTH_HEADER.to_string(),
                daemon_auth_header_value("revoked"),
            )];
            let cl = client(&o.url(), header, None);
            until(|| cl.ev.ev().fatal.len() == 1, 3000).await;
            settle().await;
            assert_eq!(cl.ev.ev().fatal, [CLOSE_UNAUTHORIZED]);
            assert_eq!(fatal_exit_code(cl.ev.ev().fatal[0]), 78);
            assert_eq!(o.rejected(), 1);
        }
    }

    #[tokio::test]
    async fn another_refused_upgrade_and_an_ordinary_close_still_reconnect() {
        let bad = FakeOrchestrator::start().await.unwrap();
        bad.set_reject_upgrade(Some(503));
        let r = client(&bad.url(), vec![], None);
        until(|| bad.rejected() >= 2, 3000).await;
        assert!(r.ev.ev().fatal.is_empty());
        // A refused upgrade logs its status; the backoff line then has no close code.
        let logs = r.ev.logs();
        assert!(logs.contains("ws upgrade refused: HTTP 503"), "{logs}");
        assert!(logs.contains("ws closed; reconnecting in "), "{logs}");
        r.c.stop();

        let o = FakeOrchestrator::start().await.unwrap();
        let cl = client(&o.url(), vec![], None);
        until(|| cl.ev.ev().opens == 1, 3000).await;
        o.close_with(1000);
        until(|| cl.ev.ev().opens == 2, 3000).await;
        assert!(cl.ev.ev().fatal.is_empty());
        assert!(cl.c.connected());
        // An open socket's close names its code.
        let logs = cl.ev.logs();
        assert!(
            logs.contains("ws closed (1000); reconnecting in "),
            "{logs}"
        );
    }

    #[test]
    fn reconnect_line_names_the_close_code_when_there_is_one() {
        assert_eq!(
            reconnect_line(Some(1006), 558),
            "ws closed (1006); reconnecting in 558 ms"
        );
        assert_eq!(
            reconnect_line(None, 845),
            "ws closed; reconnecting in 845 ms"
        );
    }

    // Wake tick (M2-T18, ADR-0021 §5). A fake wall clock, a short tick, and a 30 s backoff: a
    // reconnect inside the test's window can only come from the wake check.
    const SLOW: BackoffConfig = BackoffConfig {
        initial_ms: 30_000,
        max_ms: 30_000,
        factor: 2.0,
    };

    fn wake_opts(now: WallClock) -> Option<WsClientOptions> {
        Some(WsClientOptions {
            now: Some(now),
            wake_tick: Duration::from_millis(20),
            wake_jump: Duration::from_millis(100),
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn wake_a_60s_jump_during_a_30s_backoff_reconnects_within_one_tick_and_resets_attempts() {
        let o = FakeOrchestrator::start().await.unwrap();
        o.set_reject_upgrade(Some(503));
        let (now, offset) = fake_clock();
        let cl = client_with(&o.url(), SLOW, vec![], wake_opts(now));
        until(|| o.rejected() == 1 && cl.c.attempts() == 1, 3000).await;
        settle().await; // several normal ticks: no early retry, no reset
        assert_eq!(o.rejected(), 1);
        assert_eq!(cl.c.attempts(), 1);

        offset.fetch_add(60_000, Ordering::SeqCst);
        until(|| o.rejected() == 2, 1000).await;
        // Reset to 0, then the new try failed: 1 again (2 without the reset).
        until(
            || {
                cl.c.attempts() == 1
                    && cl
                        .ev
                        .ev()
                        .logs
                        .iter()
                        .filter(|l| l.contains("reconnecting in"))
                        .count()
                        == 2
            },
            3000,
        )
        .await;
        assert_eq!(cl.c.attempts(), 1);
        let logs = cl.ev.logs();
        let line = logs
            .lines()
            .find(|l| l.starts_with("wall clock jumped "))
            .expect("a wake line");
        let ms = line
            .trim_start_matches("wall clock jumped ")
            .trim_end_matches(" ms (wake); reconnecting now");
        assert!(ms.parse::<i64>().is_ok(), "{line}");
    }

    #[tokio::test]
    async fn wake_a_jump_while_connected_drops_the_socket_and_opens_a_new_one() {
        let o = FakeOrchestrator::start().await.unwrap();
        let (now, offset) = fake_clock();
        let cl = client(&o.url(), vec![], wake_opts(now));
        until(|| cl.ev.ev().opens == 1, 3000).await;
        settle().await;
        assert_eq!(cl.ev.ev().opens, 1);
        offset.fetch_add(60_000, Ordering::SeqCst);
        until(|| cl.ev.ev().opens == 2, 3000).await;
        assert!(cl.ev.ev().fatal.is_empty());
    }

    #[tokio::test]
    async fn send_works_from_on_open_and_is_false_when_not_connected() {
        let o = FakeOrchestrator::start().await.unwrap();
        let c = ReconnectingWs::new(
            o.url(),
            BACKOFF,
            Arc::new(Rec::default()),
            WsClientOptions::default(),
        );
        assert!(!c.send("{}"));
        assert!(!c.connected());
        c.start();
        until(|| c.connected(), 3000).await;
        assert!(c.send(r#"{"type":"nope"}"#));
        o.until(|| (!o.invalid().is_empty()).then_some(()), None)
            .await
            .unwrap();
        c.stop();
        assert!(!c.send("{}"));
    }
}
