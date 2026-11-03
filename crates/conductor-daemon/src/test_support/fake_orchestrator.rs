//! Port of `packages/daemon/src/test-support/fake-orchestrator.ts` (MR-T06): a fake orchestrator
//! WS endpoint for daemon integration tests.
//!
//! Every daemon frame is parsed with `conductor_protocol::parse_daemon_message`; an invalid frame
//! is recorded in `invalid()` (tests assert it stays empty). It records each upgrade's
//! `DAEMON_AUTH_HEADER`, can refuse upgrades with an HTTP status, and can close the socket with a
//! protocol close code. Every frame it sends is a serialised `OrchestratorToDaemon` (no hand-built
//! JSON). Binds 127.0.0.1 only. Needs a tokio runtime.

use std::num::NonZeroU64;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use conductor_protocol::{
    CommandAckPayload, DAEMON_AUTH_HEADER, DaemonToOrchestrator, NoWorkPayload,
    OrchestratorToDaemon, RegisteredPayload, api_paths, close_reason, parse_daemon_message,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};
use tokio::task::{AbortHandle, JoinHandle};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, http};
use uuid::Uuid;

/// Builds the reply to a `request_work` (`None` = no reply).
pub type WorkReply =
    Box<dyn Fn(&DaemonToOrchestrator) -> Option<OrchestratorToDaemon> + Send + Sync>;

/// The default `work_reply`: `no_work`.
pub fn no_work() -> OrchestratorToDaemon {
    OrchestratorToDaemon::NoWork {
        fencing_token: (),
        msg_id: Uuid::new_v4(),
        payload: NoWorkPayload { reason: None },
        seq: (),
        session_id: (),
    }
}

struct Conn {
    tx: mpsc::UnboundedSender<Message>,
    /// Ends the connection's task, which drops the TCP stream without a close frame.
    kill: Arc<Notify>,
}

struct Inner {
    received: Vec<DaemonToOrchestrator>,
    invalid: Vec<String>,
    last_seq: Option<i64>,
    heartbeat_interval_ms: NonZeroU64,
    work_reply: Arc<WorkReply>,
    connections: usize,
    auth_headers: Vec<Option<String>>,
    reject_upgrade: Option<u16>,
    rejected: usize,
    /// The latest daemon socket (the TS `socket`).
    socket: Option<Conn>,
    tasks: Vec<AbortHandle>,
}

struct Shared {
    inner: Mutex<Inner>,
    frames: Notify,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// `FakeOrchestrator`.
pub struct FakeOrchestrator {
    shared: Arc<Shared>,
    port: u16,
    accept: JoinHandle<()>,
}

fn frame(msg: &OrchestratorToDaemon) -> Message {
    Message::Text(
        serde_json::to_string(msg)
            .expect("an OrchestratorToDaemon serialises")
            .into(),
    )
}

/// The wire `type` of a daemon message.
pub fn message_type(msg: &DaemonToOrchestrator) -> String {
    serde_json::to_value(msg)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_default()
}

impl FakeOrchestrator {
    /// Listen on `127.0.0.1:<random port>` at `api_paths::DAEMON_WS`.
    pub async fn start() -> std::io::Result<FakeOrchestrator> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                received: Vec::new(),
                invalid: Vec::new(),
                last_seq: None,
                heartbeat_interval_ms: NonZeroU64::new(60_000).expect("non-zero"),
                work_reply: Arc::new(Box::new(|_| Some(no_work()))),
                connections: 0,
                auth_headers: Vec::new(),
                reject_upgrade: None,
                rejected: 0,
                socket: None,
                tasks: Vec::new(),
            }),
            frames: Notify::new(),
        });
        let accept = {
            let shared = shared.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let s = shared.clone();
                    let task = tokio::spawn(Self::serve(s, stream));
                    shared.lock().tasks.push(task.abort_handle());
                }
            })
        };
        Ok(FakeOrchestrator {
            shared,
            port,
            accept,
        })
    }

    async fn serve(shared: Arc<Shared>, stream: TcpStream) {
        let header: Arc<Mutex<Option<String>>> = Arc::default();
        // tungstenite's `Callback` fixes the `ErrorResponse` error type.
        #[allow(clippy::result_large_err)]
        let callback = {
            let (shared, header) = (shared.clone(), header.clone());
            move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                let refuse = |status: u16| {
                    let mut r = ErrorResponse::new(None);
                    *r.status_mut() =
                        http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::FORBIDDEN);
                    r
                };
                if req.uri().path() != api_paths::DAEMON_WS {
                    return Err(refuse(400));
                }
                let mut inner = shared.lock();
                if let Some(status) = inner.reject_upgrade {
                    inner.rejected += 1;
                    return Err(refuse(status));
                }
                *header.lock().unwrap_or_else(|e| e.into_inner()) = req
                    .headers()
                    .get(DAEMON_AUTH_HEADER)
                    .and_then(|v| v.to_str().ok())
                    .map(String::from);
                Ok(resp)
            }
        };
        let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
            return;
        };
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });
        let kill = Arc::new(Notify::new());
        {
            let mut inner = shared.lock();
            inner.connections += 1;
            let h = header.lock().unwrap_or_else(|e| e.into_inner()).clone();
            inner.auth_headers.push(h);
            inner.tasks.push(writer.abort_handle());
            inner.socket = Some(Conn {
                tx: tx.clone(),
                kill: kill.clone(),
            });
        }
        shared.frames.notify_waiters();
        loop {
            let m = tokio::select! {
                m = source.next() => m,
                // `drop_socket`. A newer connection replacing this one leaves it open, as in TS.
                () = kill.notified() => break,
            };
            match m {
                Some(Ok(Message::Text(t))) => Self::on_frame(&shared, &tx, t.as_str()),
                Some(Ok(Message::Binary(b))) => {
                    Self::on_frame(&shared, &tx, &String::from_utf8_lossy(&b))
                }
                Some(Ok(_)) => {}
                None | Some(Err(_)) => break,
            }
        }
        writer.abort();
        // Dropping `source` and the aborted writer's `sink` closes the TCP stream.
    }

    fn on_frame(shared: &Shared, tx: &mpsc::UnboundedSender<Message>, text: &str) {
        let msg = match parse_daemon_message(text) {
            Ok(m) => m,
            Err(_) => {
                shared.lock().invalid.push(text.to_string());
                shared.frames.notify_waiters();
                return;
            }
        };
        let reply = {
            let mut inner = shared.lock();
            inner.received.push(msg.clone());
            match &msg {
                DaemonToOrchestrator::Register { payload, .. } => {
                    Some(OrchestratorToDaemon::Registered {
                        fencing_token: (),
                        msg_id: Uuid::new_v4(),
                        payload: RegisteredPayload {
                            machine_id: payload.machine_id.to_string(),
                            last_seq: inner.last_seq,
                            heartbeat_interval_ms: inner.heartbeat_interval_ms,
                        },
                        seq: (),
                        session_id: (),
                    })
                }
                DaemonToOrchestrator::RequestWork { .. } => {
                    let f = inner.work_reply.clone();
                    drop(inner);
                    f(&msg)
                }
                DaemonToOrchestrator::SessionEvent { seq, .. }
                | DaemonToOrchestrator::PermissionRequest { seq, .. }
                | DaemonToOrchestrator::AssistantResult { seq, .. } => {
                    // Mirror machine.last_seq: the highest processed seq (ADR-0023:
                    // permission_request too; ADR-0033: assistant_result).
                    if inner.last_seq.is_none_or(|l| *seq > l) {
                        inner.last_seq = Some(*seq);
                    }
                    None
                }
                _ => None,
            }
        };
        if let Some(r) = reply {
            let _ = tx.send(frame(&r));
        }
        shared.frames.notify_waiters();
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.shared.lock()
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}{}", self.port, api_paths::DAEMON_WS)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Every valid daemon frame, in order.
    pub fn received(&self) -> Vec<DaemonToOrchestrator> {
        self.lock().received.clone()
    }

    /// Every frame that failed to parse.
    pub fn invalid(&self) -> Vec<String> {
        self.lock().invalid.clone()
    }

    pub fn last_seq(&self) -> Option<i64> {
        self.lock().last_seq
    }

    /// `registered.last_seq` sent on the next register.
    pub fn set_last_seq(&self, seq: Option<i64>) {
        self.lock().last_seq = seq;
    }

    pub fn set_heartbeat_interval_ms(&self, ms: NonZeroU64) {
        self.lock().heartbeat_interval_ms = ms;
    }

    /// Reply to request_work.
    pub fn set_work_reply(
        &self,
        f: impl Fn(&DaemonToOrchestrator) -> Option<OrchestratorToDaemon> + Send + Sync + 'static,
    ) {
        self.lock().work_reply = Arc::new(Box::new(f));
    }

    pub fn connections(&self) -> usize {
        self.lock().connections
    }

    /// `DAEMON_AUTH_HEADER` of each accepted upgrade, in order (`None` = none: local mode).
    pub fn auth_headers(&self) -> Vec<Option<String>> {
        self.lock().auth_headers.clone()
    }

    /// When set, upgrades are refused with this HTTP status (and counted in `rejected`).
    pub fn set_reject_upgrade(&self, status: Option<u16>) {
        self.lock().reject_upgrade = status;
    }

    pub fn rejected(&self) -> usize {
        self.lock().rejected
    }

    /// Send to the latest daemon socket.
    pub fn send(&self, msg: &OrchestratorToDaemon) -> anyhow::Result<()> {
        let inner = self.lock();
        let conn = inner
            .socket
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no daemon connected"))?;
        conn.tx
            .send(frame(msg))
            .map_err(|_| anyhow::anyhow!("no daemon connected"))
    }

    /// Close the daemon's socket with a protocol close code (e.g. `CLOSE_REVOKED`).
    pub fn close_with(&self, code: u16) {
        if let Some(conn) = self.lock().socket.take() {
            let _ = conn.tx.send(Message::Close(Some(CloseFrame {
                code: CloseCode::from(code),
                reason: close_reason(code).unwrap_or("").into(),
            })));
        }
    }

    /// Drop the daemon's socket without a close frame (it should reconnect).
    pub fn drop_socket(&self) {
        if let Some(conn) = self.lock().socket.take() {
            conn.kill.notify_one();
        }
    }

    /// Messages of one wire `type`.
    pub fn of_type(&self, kind: &str) -> Vec<DaemonToOrchestrator> {
        self.received()
            .into_iter()
            .filter(|m| message_type(m) == kind)
            .collect()
    }

    /// `session_event` messages, optionally of one payload `kind`.
    pub fn events(&self, kind: Option<&str>) -> Vec<DaemonToOrchestrator> {
        self.received()
            .into_iter()
            .filter(|m| match m {
                DaemonToOrchestrator::SessionEvent { payload, .. } => kind.is_none_or(|k| {
                    serde_json::to_value(payload)
                        .ok()
                        .and_then(|v| v.get("kind").and_then(|x| x.as_str()).map(|x| x == k))
                        .unwrap_or(false)
                }),
                _ => false,
            })
            .collect()
    }

    /// The `data` of each `session_event` of `kind`, as JSON.
    pub fn event_data(&self, kind: &str) -> Vec<serde_json::Value> {
        self.events(Some(kind))
            .into_iter()
            .filter_map(|m| match m {
                DaemonToOrchestrator::SessionEvent { payload, .. } => serde_json::to_value(payload)
                    .ok()
                    .and_then(|mut v| v.get_mut("data").map(serde_json::Value::take)),
                _ => None,
            })
            .collect()
    }

    /// The `command_ack`s for `command_id`.
    pub fn ack(&self, command_id: Uuid) -> Vec<CommandAckPayload> {
        self.received()
            .into_iter()
            .filter_map(|m| match m {
                DaemonToOrchestrator::CommandAck { payload, .. }
                    if payload.command_id == command_id =>
                {
                    Some(payload)
                }
                _ => None,
            })
            .collect()
    }

    /// Resolve when `pred` holds (checked on every frame, and every 50 ms). 10 s by default in TS:
    /// daemon tests spawn children that can stall on a loaded machine.
    pub async fn until<T>(
        &self,
        mut pred: impl FnMut() -> Option<T>,
        timeout: Option<Duration>,
    ) -> anyhow::Result<T> {
        let deadline = tokio::time::Instant::now() + timeout.unwrap_or(Duration::from_secs(10));
        loop {
            let notified = self.shared.frames.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(v) = pred() {
                return Ok(v);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                anyhow::bail!("FakeOrchestrator.until: timed out");
            }
            let wait = (deadline - now).min(Duration::from_millis(50));
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep(wait) => {}
            }
        }
    }

    /// Stop listening and drop every connection.
    pub fn close(&self) {
        self.accept.abort();
        let mut inner = self.lock();
        inner.socket = None;
        for t in inner.tasks.drain(..) {
            t.abort();
        }
    }
}

impl Drop for FakeOrchestrator {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conductor_protocol::{CLOSE_REVOKED, OrchestratorToDaemon};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::{Error as WsError, http::HeaderValue};

    const REGISTER: &str = include_str!(
        "../../../../packages/shared/protocol-json/fixtures/DAEMON_FIXTURES.register.json"
    );
    const SESSION_EVENT: &str = include_str!(
        "../../../../packages/shared/protocol-json/fixtures/DAEMON_FIXTURES.session_event.json"
    );
    const REQUEST_WORK: &str = include_str!(
        "../../../../packages/shared/protocol-json/fixtures/DAEMON_FIXTURES.request_work.json"
    );

    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect(o: &FakeOrchestrator, auth: Option<&str>) -> Result<Client, WsError> {
        let mut req = o.url().into_client_request()?;
        if let Some(a) = auth {
            req.headers_mut()
                .insert(DAEMON_AUTH_HEADER, HeaderValue::from_str(a).unwrap());
        }
        tokio_tungstenite::connect_async(req)
            .await
            .map(|(ws, _)| ws)
    }

    async fn next_reply(ws: &mut Client) -> OrchestratorToDaemon {
        loop {
            match ws.next().await.expect("a frame").expect("no error") {
                Message::Text(t) => {
                    return conductor_protocol::parse_orchestrator_message(t.as_str()).unwrap();
                }
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    fn compact(json: &str) -> String {
        serde_json::to_string(&serde_json::from_str::<serde_json::Value>(json).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn rejects_an_invalid_frame() {
        let o = FakeOrchestrator::start().await.unwrap();
        let mut ws = connect(&o, None).await.unwrap();
        ws.send(Message::Text(r#"{"type":"nope"}"#.into()))
            .await
            .unwrap();
        o.until(|| (!o.invalid().is_empty()).then_some(()), None)
            .await
            .unwrap();
        assert_eq!(o.invalid(), [r#"{"type":"nope"}"#]);
        assert!(o.received().is_empty());
    }

    #[tokio::test]
    async fn answers_register_with_registered_and_records_the_auth_header() {
        let o = FakeOrchestrator::start().await.unwrap();
        o.set_last_seq(Some(41));
        let mut ws = connect(&o, Some("Bearer mch_x")).await.unwrap();
        ws.send(Message::Text(compact(REGISTER).into()))
            .await
            .unwrap();
        let OrchestratorToDaemon::Registered { payload, .. } = next_reply(&mut ws).await else {
            panic!("registered expected")
        };
        assert_eq!(payload.machine_id, "mbp-ben");
        assert_eq!(payload.last_seq, Some(41));
        assert_eq!(payload.heartbeat_interval_ms.get(), 60_000);
        assert_eq!(o.connections(), 1);
        assert_eq!(o.auth_headers(), [Some("Bearer mch_x".to_string())]);
        assert_eq!(o.of_type("register").len(), 1);

        let _second = connect(&o, None).await.unwrap();
        o.until(|| (o.connections() == 2).then_some(()), None)
            .await
            .unwrap();
        assert_eq!(o.auth_headers()[1], None);
    }

    #[tokio::test]
    async fn refuses_an_upgrade_with_the_configured_status() {
        let o = FakeOrchestrator::start().await.unwrap();
        o.set_reject_upgrade(Some(401));
        match connect(&o, Some("Bearer bad")).await {
            Err(WsError::Http(resp)) => assert_eq!(resp.status(), 401),
            other => panic!("expected an HTTP 401, got {:?}", other.map(|_| ())),
        }
        assert_eq!(o.rejected(), 1);
        assert_eq!(o.connections(), 0);
        assert!(o.auth_headers().is_empty());
    }

    #[tokio::test]
    async fn close_with_sends_the_protocol_close_code() {
        let o = FakeOrchestrator::start().await.unwrap();
        let mut ws = connect(&o, None).await.unwrap();
        o.until(|| (o.connections() == 1).then_some(()), None)
            .await
            .unwrap();
        o.close_with(CLOSE_REVOKED);
        let code = loop {
            match ws.next().await {
                Some(Ok(Message::Close(Some(f)))) => break u16::from(f.code),
                Some(Ok(_)) => {}
                other => panic!("expected a close frame, got {other:?}"),
            }
        };
        assert_eq!(code, 4001);
        assert!(o.send(&no_work()).is_err());
    }

    #[tokio::test]
    async fn mirrors_last_seq_from_session_events_and_answers_request_work() {
        let o = FakeOrchestrator::start().await.unwrap();
        let mut ws = connect(&o, None).await.unwrap();
        ws.send(Message::Text(compact(SESSION_EVENT).into()))
            .await
            .unwrap();
        o.until(|| o.last_seq(), None).await.unwrap();
        assert_eq!(o.last_seq(), Some(6));
        assert_eq!(o.events(Some("ask_user")).len(), 1);
        assert!(o.events(Some("exit")).is_empty());
        assert_eq!(
            o.event_data("ask_user"),
            [serde_json::json!({"question": "Which DB should I target?"})]
        );

        ws.send(Message::Text(compact(REQUEST_WORK).into()))
            .await
            .unwrap();
        assert!(matches!(
            next_reply(&mut ws).await,
            OrchestratorToDaemon::NoWork { .. }
        ));
        o.set_work_reply(|_| None);
        ws.send(Message::Text(compact(REQUEST_WORK).into()))
            .await
            .unwrap();
        o.until(
            || (o.of_type("request_work").len() == 2).then_some(()),
            None,
        )
        .await
        .unwrap();
        o.send(&no_work()).unwrap();
        assert!(matches!(
            next_reply(&mut ws).await,
            OrchestratorToDaemon::NoWork { .. }
        ));
    }

    #[tokio::test]
    async fn drop_socket_ends_the_connection_without_a_close_frame() {
        let o = FakeOrchestrator::start().await.unwrap();
        let mut ws = connect(&o, None).await.unwrap();
        o.until(|| (o.connections() == 1).then_some(()), None)
            .await
            .unwrap();
        o.drop_socket();
        match ws.next().await {
            None | Some(Err(_)) => {}
            Some(Ok(Message::Close(_))) => panic!("drop_socket must not send a close frame"),
            Some(Ok(other)) => panic!("unexpected {other:?}"),
        }
        let _again = connect(&o, None).await.unwrap();
        o.until(|| (o.connections() == 2).then_some(()), None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn until_times_out() {
        let o = FakeOrchestrator::start().await.unwrap();
        let err = o
            .until(|| None::<()>, Some(Duration::from_millis(60)))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "FakeOrchestrator.until: timed out");
    }
}
