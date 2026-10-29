//! MR-T01 FR-1: register + heartbeats against a real orchestrator over the daemon WS protocol.
//!
//! Reference: `packages/daemon/src/daemon.ts` (onOpen register, onRegistered, sendHeartbeat) and
//! `packages/shared/src/protocol/ws.ts`. Hand-written serde structs (the port generates them from
//! the zod schemas, MR-T03). Throwaway spike code: never shipped.

use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// `PROTOCOL_VERSION` (ws.ts).
const PROTOCOL_VERSION: u32 = 2;
/// `DAEMON_AUTH_HEADER` (ws.ts): `authorization: Bearer <credential>`.
const DAEMON_AUTH_HEADER: &str = "authorization";

#[derive(Parser)]
#[command(about = "MR-T01 WS register + heartbeat probe")]
struct Args {
    /// e.g. ws://127.0.0.1:7499/ws/daemon
    #[arg(long)]
    url: String,
    /// The enrolled machine credential.
    #[arg(long)]
    credential: String,
    /// The enrolled machine id (`register` must name the credential's machine).
    #[arg(long)]
    machine_id: String,
    /// Override `registered.heartbeat_interval_ms`.
    #[arg(long)]
    interval_ms: Option<u64>,
    #[arg(long, default_value_t = 3)]
    heartbeats: u32,
    /// Expect the upgrade to be refused with HTTP 401 (a wrong credential).
    #[arg(long)]
    expect_401: bool,
}

/// The common envelope. Daemon machine messages carry `seq`, `session_id`, `fencing_token` null.
#[derive(Serialize, Deserialize, Debug)]
struct Envelope<P> {
    #[serde(rename = "type")]
    ty: String,
    msg_id: String,
    seq: Option<u64>,
    session_id: Option<String>,
    fencing_token: Option<u64>,
    payload: P,
}

impl<P> Envelope<P> {
    fn machine(ty: &str, payload: P) -> Self {
        Self {
            ty: ty.into(),
            msg_id: uuid::Uuid::new_v4().to_string(),
            seq: None,
            session_id: None,
            fencing_token: None,
            payload,
        }
    }
}

// TD: hand-written frames; the port uses conductor-protocol types generated from the zod schemas.
#[derive(Serialize)]
struct RegisterPayload {
    machine_id: String,
    protocol_version: u32,
    hostname: String,
    os: &'static str,
    arch: &'static str,
    tags: Vec<String>,
    cpu_total: u32,
    mem_total_mb: u64,
    disk_free_mb: u64,
    budget_cpu: u32,
    budget_mem_mb: u64,
    max_sessions: u32,
    max_concurrent_builds: u32,
    daemon_version: String,
    claude_code_version: Option<String>,
}

#[derive(Deserialize, Debug)]
struct RegisteredPayload {
    machine_id: String,
    last_seq: Option<u64>,
    heartbeat_interval_ms: u64,
}

#[derive(Serialize)]
struct SessionLease {
    session_id: String,
    fencing_token: u64,
}

#[derive(Serialize)]
struct HeartbeatPayload {
    cpu_free: f64,
    mem_free_mb: u64,
    disk_free_mb: u64,
    sessions: Vec<SessionLease>,
}

/// Node's `os.platform()` names, which the orchestrator stores.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// Node's `os.arch()` names.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_owned())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "rust-spike".into())
}

fn log(start: Instant, msg: impl AsRef<str>) {
    println!(
        "[+{:>7.3}s] {}",
        start.elapsed().as_secs_f64(),
        msg.as_ref()
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let start = Instant::now();

    let mut req = args.url.as_str().into_client_request()?;
    req.headers_mut().insert(
        DAEMON_AUTH_HEADER,
        format!("Bearer {}", args.credential).parse()?,
    );
    log(start, format!("connect {}", args.url));
    let ws = match tokio_tungstenite::connect_async(req).await {
        Ok((ws, res)) => {
            if args.expect_401 {
                bail!("expected 401, but the upgrade succeeded");
            }
            log(start, format!("upgraded: HTTP {}", res.status()));
            ws
        }
        Err(WsError::Http(res)) if args.expect_401 => {
            let s = res.status().as_u16();
            log(start, format!("upgrade refused: HTTP {s}"));
            if s != 401 {
                bail!("expected HTTP 401, got {s}");
            }
            println!("ws-probe: PASS wrong credential refused with 401");
            return Ok(());
        }
        Err(e) => return Err(e).context("WS upgrade"),
    };
    let (mut tx, mut rx) = ws.split();

    let send = |env: Value| Message::text(env.to_string());
    let register = Envelope::machine(
        "register",
        RegisterPayload {
            machine_id: args.machine_id.clone(),
            protocol_version: PROTOCOL_VERSION,
            hostname: hostname(),
            os: node_platform(),
            arch: node_arch(),
            tags: vec![],
            // TD: fixed facts; the port reads them from sysinfo (MR-T05).
            cpu_total: 4,
            mem_total_mb: 8192,
            disk_free_mb: 10_000,
            budget_cpu: 2,
            budget_mem_mb: 4096,
            max_sessions: 0, // never offered work
            max_concurrent_builds: 1,
            daemon_version: "0.0.0-rust-spike".into(),
            claude_code_version: None,
        },
    );
    let frame = serde_json::to_value(&register)?;
    log(start, format!("-> {frame}"));
    tx.send(send(frame)).await?;

    // registered (≤ 10 s); anything else is logged, protocol_error fails.
    let registered: RegisteredPayload = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = rx.next().await {
            match msg? {
                Message::Text(t) => {
                    log(start, format!("<- {t}"));
                    let env: Envelope<Value> = serde_json::from_str(&t)?;
                    match env.ty.as_str() {
                        "registered" => return Ok(serde_json::from_value(env.payload)?),
                        "protocol_error" => bail!("protocol_error: {}", env.payload),
                        _ => {}
                    }
                }
                Message::Close(c) => bail!("closed before registered: {c:?}"),
                _ => {}
            }
        }
        Err(anyhow!("socket ended before registered"))
    })
    .await
    .context("no registered within 10 s")??;
    if registered.machine_id != args.machine_id {
        bail!("registered names {}", registered.machine_id);
    }
    log(
        start,
        format!(
            "registered: last_seq={:?} heartbeat_interval_ms={}",
            registered.last_seq, registered.heartbeat_interval_ms
        ),
    );

    let interval =
        Duration::from_millis(args.interval_ms.unwrap_or(registered.heartbeat_interval_ms));
    for n in 1..=args.heartbeats {
        if n > 1 {
            // Keep reading while waiting: a protocol_error must fail the run.
            let deadline = tokio::time::sleep(interval);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    msg = rx.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            log(start, format!("<- {t}"));
                            if t.contains("\"protocol_error\"") {
                                bail!("protocol_error after heartbeat");
                            }
                        }
                        Some(Ok(Message::Close(c))) => bail!("server closed: {c:?}"),
                        Some(Ok(_)) => {}
                        Some(Err(e)) => return Err(e.into()),
                        None => bail!("socket ended"),
                    }
                }
            }
        }
        let hb = Envelope::machine(
            "heartbeat",
            HeartbeatPayload {
                cpu_free: 2.0,
                mem_free_mb: 4096,
                disk_free_mb: 10_000,
                sessions: vec![],
            },
        );
        let frame = serde_json::to_value(&hb)?;
        log(start, format!("-> heartbeat #{n} {frame}"));
        tx.send(send(frame)).await?;
    }

    // A short grace for a late protocol_error, then a clean close.
    let grace = tokio::time::timeout(Duration::from_millis(500), rx.next()).await;
    if let Ok(Some(Ok(Message::Text(t)))) = grace {
        log(start, format!("<- {t}"));
        if t.contains("\"protocol_error\"") {
            bail!("protocol_error after the last heartbeat");
        }
    }
    tx.send(Message::Close(Some(CloseFrame {
        code: CloseCode::Normal,
        reason: "probe done".into(),
    })))
    .await?;
    log(start, "-> close 1000");
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(msg) = rx.next().await {
            match msg {
                Ok(Message::Close(c)) => return Some(c),
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    log(start, format!("<- close {closed:?}"));
    println!(
        "ws-probe: PASS registered + {} heartbeats, closed cleanly",
        args.heartbeats
    );
    Ok(())
}
