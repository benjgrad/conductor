//! MR-T01 FR-2: an rmcp streamable-HTTP outcome server, probed by fake-claude, a raw client that
//! holds a call open for >= 60 s, and (opt-in, `E2E_REAL_CLAUDE=1`) the real `claude -p`.
//!
//! Mirrors `packages/daemon/src/claude/outcome-server.ts`: one listener on 127.0.0.1, a per-session
//! path `/mcp/<32 hex>` (unknown token = 404), loopback-only Host (403), stateless, JSON replies.
//! Throwaway spike code: never shipped.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use clap::Parser;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, MetaObject, ServerCapabilities, ServerConfig,
};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, ServerHandler, schemars, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tower::ServiceExt;

// The TS outcome server's texts and caps (outcome-server.ts, protocol/outcome.ts).
const COMPLETE_STATE_RETURN: &str =
    "Recorded. Stop now: do not call any other tool and end your turn.";
const ASK_USER_RETURN: &str = "Your question was sent to a human. End your turn now without calling more tools. The answer will arrive as the next user message.";
const COMPLETE_STATE_DESCRIPTION: &str = "Call exactly once when the current workflow state's work is finished. `result` holds the keys the state asked for. After calling it, stop: do not call any other tool and end your turn.";
const TRANSITION_NAME_MAX: usize = 100;
const TRANSITION_REASON_MAX: usize = 4_000;

#[derive(Parser)]
#[command(about = "MR-T01 rmcp outcome-server probe")]
struct Args {
    /// How long the `permission` tool holds a call before answering (ADR-0023 shape).
    #[arg(long, default_value_t = 65)]
    hold_secs: u64,
    /// Path to packages/daemon/test/fixtures/fake-claude.mjs.
    #[arg(long)]
    fake_claude: Option<PathBuf>,
    /// The `node` to run fake-claude with.
    #[arg(long, default_value = "node")]
    node: String,
    /// Skip the held-call scenario (quick iteration).
    #[arg(long)]
    skip_hold: bool,
}

// ------------------------------------------------------------------ the MCP server

/// `COMPLETE_STATE_INPUT_SHAPE` (packages/shared/src/protocol/outcome.ts).
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CompleteStateInput {
    /// The name of the transition you take (one of the names listed in your prompt)
    #[schemars(length(min = 1, max = 100))]
    transition: Option<String>,
    /// Why you take it; for a question transition, the question for the human
    #[schemars(length(max = 4000))]
    reason: Option<String>,
    /// Structured outcome of this state
    result: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AskUserInput {
    /// One clear question for the human
    #[schemars(length(min = 1))]
    question: String,
}

/// The `--permission-prompt-tool` input (outcome-server.ts PERMISSION_INPUT_SHAPE).
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PermissionInput {
    /// The tool Claude wants to run
    tool_name: String,
    /// The input it wants to run it with
    input: serde_json::Map<String, Value>,
    tool_use_id: Option<String>,
    permission_suggestions: Option<Vec<Value>>,
}

#[derive(Debug, Clone)]
struct Recorded {
    tool: &'static str,
    args: Value,
}

#[derive(Default)]
struct Session {
    calls: Mutex<Vec<Recorded>>,
}

#[derive(Clone)]
struct Outcome {
    session: Arc<Session>,
    hold: Duration,
}

/// `_meta: {"anthropic/alwaysLoad": true}`: keeps the tool out of the CLI's tool-search deferral.
fn always_load() -> MetaObject {
    let mut m = serde_json::Map::new();
    m.insert("anthropic/alwaysLoad".into(), Value::Bool(true));
    MetaObject(m)
}

fn text(t: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(t)])
}

#[tool_router]
impl Outcome {
    #[tool(description = COMPLETE_STATE_DESCRIPTION, meta = always_load())]
    async fn complete_state(
        &self,
        Parameters(input): Parameters<CompleteStateInput>,
    ) -> Result<CallToolResult, ErrorData> {
        // The zod caps, checked by hand (schemars only documents them).
        if let Some(t) = &input.transition
            && (t.is_empty() || t.chars().count() > TRANSITION_NAME_MAX)
        {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "transition must be 1..={TRANSITION_NAME_MAX} characters"
            ))]));
        }
        if let Some(r) = &input.reason
            && r.chars().count() > TRANSITION_REASON_MAX
        {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "reason must be at most {TRANSITION_REASON_MAX} characters"
            ))]));
        }
        self.session.calls.lock().unwrap().push(Recorded {
            tool: "complete_state",
            args: json!({
                "result": input.result,
                "transition": input.transition,
                "reason": input.reason,
            }),
        });
        Ok(text(COMPLETE_STATE_RETURN))
    }

    #[tool(
        description = "Ask the human operator one clear question when you cannot proceed without a decision. The call returns at once; then end your turn. The answer arrives as the next user message.",
        meta = always_load()
    )]
    async fn ask_user(&self, Parameters(input): Parameters<AskUserInput>) -> CallToolResult {
        self.session.calls.lock().unwrap().push(Recorded {
            tool: "ask_user",
            args: json!({ "question": input.question }),
        });
        text(ASK_USER_RETURN)
    }

    /// ADR-0023: held until a human decides; here, until `--hold-secs` pass. Then allow.
    #[tool(
        description = "Conductor's permission prompt tool: Claude Code calls it when a tool call needs a human's approval. Do not call it yourself."
    )]
    async fn permission(&self, Parameters(input): Parameters<PermissionInput>) -> CallToolResult {
        let started = Instant::now();
        log(&format!(
            "permission: holding {} ({:?}) for {:?}",
            input.tool_name, input.tool_use_id, self.hold
        ));
        let _ = input.permission_suggestions;
        tokio::time::sleep(self.hold).await;
        self.session.calls.lock().unwrap().push(Recorded {
            tool: "permission",
            args: json!({ "tool_name": input.tool_name, "held_ms": started.elapsed().as_millis() as u64 }),
        });
        text(json!({ "behavior": "allow", "updatedInput": input.input }).to_string())
    }
}

#[tool_handler]
impl ServerHandler for Outcome {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("conductor", "0.0.0"))
    }
}

type Svc = StreamableHttpService<Outcome, NeverSessionManager>;

#[derive(Clone, Default)]
struct Registry {
    /// token → that session's MCP service (TS: `entries`).
    services: Arc<Mutex<HashMap<String, Svc>>>,
}

struct Server {
    port: u16,
    registry: Registry,
    hold: Duration,
}

impl Server {
    async fn start(hold: Duration) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let registry = Registry::default();
        let app = Router::new()
            .route("/mcp/{token}", any(route))
            .with_state(registry.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            port,
            registry,
            hold,
        })
    }

    /// A fresh session: its token, URL and recorded calls (TS `register`).
    fn register(&self) -> (String, String, Arc<Session>) {
        let token = hex::encode(rand::random::<[u8; 16]>());
        let session = Arc::new(Session::default());
        let config = StreamableHttpServerConfig::default()
            // Stateless + JSON replies, as the TS server (`enableJsonResponse: true`, no session id).
            .with_legacy_session_mode(false)
            .with_json_response(true)
            // rmcp's own DNS-rebinding guard does the TS Host check (403).
            .with_allowed_hosts([
                format!("127.0.0.1:{}", self.port),
                format!("localhost:{}", self.port),
            ]);
        let outcome = Outcome {
            session: session.clone(),
            hold: self.hold,
        };
        let svc = StreamableHttpService::new(
            move || Ok(outcome.clone()),
            Arc::new(NeverSessionManager::default()),
            config,
        );
        self.registry
            .services
            .lock()
            .unwrap()
            .insert(token.clone(), svc);
        let url = format!("http://127.0.0.1:{}/mcp/{token}", self.port);
        (token, url, session)
    }
}

async fn route(
    State(reg): State<Registry>,
    Path(token): Path<String>,
    req: Request<Body>,
) -> Response {
    let svc = reg.services.lock().unwrap().get(&token).cloned();
    match svc {
        None => http::StatusCode::NOT_FOUND.into_response(),
        Some(svc) => match svc.oneshot(req).await {
            Ok(r) => r.into_response(),
            Err(never) => match never {},
        },
    }
}

// ------------------------------------------------------------------ probes

fn log(msg: &str) {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    eprintln!("[{}.{:03}] {msg}", t.as_secs(), t.subsec_millis());
}

struct Report {
    failed: bool,
}

impl Report {
    fn check(&mut self, name: &str, ok: bool, detail: impl AsRef<str>) {
        let d = detail.as_ref();
        if ok {
            println!(
                "PASS {name}{}",
                if d.is_empty() { "" } else { ": " }.to_owned() + d
            );
        } else {
            self.failed = true;
            println!("FAIL {name}: {d}");
        }
    }
}

fn mcp_config(url: &str) -> Result<tempfile::NamedTempFile> {
    let mut f = tempfile::Builder::new().suffix(".json").tempfile()?;
    let cfg = json!({ "mcpServers": { "conductor": { "type": "http", "url": url } } });
    std::io::Write::write_all(&mut f, cfg.to_string().as_bytes())?;
    Ok(f)
}

const PROTOCOL_VERSION: &str = "2025-06-18";

/// A raw JSON-RPC POST, as Claude's MCP client sends it; the reply is JSON or SSE `data:` lines.
async fn rpc(
    client: &reqwest::Client,
    url: &str,
    host: Option<&str>,
    body: Value,
) -> Result<(u16, Option<Value>, String)> {
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", PROTOCOL_VERSION)
        .body(body.to_string());
    if let Some(h) = host {
        req = req.header("host", h);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let ctype = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let raw = res.text().await?;
    let parsed = if ctype.starts_with("text/event-stream") {
        raw.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
            .find(|v| v.get("id").is_some())
    } else {
        serde_json::from_str(&raw).ok()
    };
    Ok((status, parsed, ctype))
}

fn initialize_body() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
        "clientInfo": {"name":"mcp-probe","version":"0.0.0"}}})
}

async fn raw_session(client: &reqwest::Client, url: &str) -> Result<()> {
    let (s, init, _) = rpc(client, url, None, initialize_body()).await?;
    if s != 200 {
        bail!("initialize: HTTP {s}");
    }
    log(&format!(
        "initialize -> {}",
        init.map(|v| v["result"]["protocolVersion"].to_string())
            .unwrap_or_default()
    ));
    let (s, _, _) = rpc(
        client,
        url,
        None,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await?;
    if s != 202 && s != 200 {
        bail!("notifications/initialized: HTTP {s}");
    }
    Ok(())
}

fn tool_text(v: &Value) -> String {
    v["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_owned()
}

async fn probe_tools_list(r: &mut Report, client: &reqwest::Client, url: &str) -> Result<()> {
    raw_session(client, url).await?;
    let (s, v, ctype) = rpc(
        client,
        url,
        None,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await?;
    let v = v.ok_or_else(|| anyhow!("tools/list: no JSON-RPC reply (HTTP {s})"))?;
    let tools = v["result"]["tools"].as_array().cloned().unwrap_or_default();
    let names: Vec<_> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    log(&format!(
        "tools/list ({ctype}): {}",
        serde_json::to_string_pretty(&v["result"])?
    ));
    r.check(
        "tools/list",
        names.contains(&"complete_state") && names.contains(&"permission"),
        format!("{names:?}, reply content-type {ctype}"),
    );
    let cs = tools.iter().find(|t| t["name"] == "complete_state");
    r.check(
        "complete_state _meta alwaysLoad",
        cs.is_some_and(|t| t["_meta"]["anthropic/alwaysLoad"] == json!(true)),
        "",
    );
    Ok(())
}

async fn probe_guards(
    r: &mut Report,
    client: &reqwest::Client,
    port: u16,
    url: &str,
) -> Result<()> {
    let other = format!("http://127.0.0.1:{port}/mcp/{}", hex::encode([7u8; 16]));
    let (s, _, _) = rpc(client, &other, None, initialize_body()).await?;
    r.check("unknown token -> 404", s == 404, format!("HTTP {s}"));
    let (s, _, _) = rpc(client, url, Some("evil.example"), initialize_body()).await?;
    r.check("foreign Host -> 403", s == 403, format!("HTTP {s}"));
    let s = client.get(url).send().await?.status().as_u16();
    log(&format!("GET (stateless, no SSE stream) -> HTTP {s}"));
    Ok(())
}

async fn probe_fake_claude(
    r: &mut Report,
    args: &Args,
    url: &str,
    session: &Session,
) -> Result<()> {
    let script = args.fake_claude.clone().unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/daemon/test/fixtures/fake-claude.mjs")
    });
    if !script.exists() {
        bail!("fake-claude not found at {}", script.display());
    }
    let cfg = mcp_config(url)?;
    let state = tempfile::tempdir()?;
    let scenario = r#"[[{"complete_state":{"probe":"ok"},"transition":"done","reason":"probe"}]]"#;
    let mut child = tokio::process::Command::new(&args.node)
        .arg(&script)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ])
        .args([
            "--verbose",
            "--session-id",
            &uuid::Uuid::new_v4().to_string(),
        ])
        .arg("--mcp-config")
        .arg(cfg.path())
        .env("FAKE_CLAUDE_STATE_DIR", state.path())
        .env("FAKE_CLAUDE_SCENARIO", scenario)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("spawn fake-claude")?;
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"go\"}]}}\n",
        )
        .await?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut tool_result: Option<Value> = None;
    let read = async {
        while let Some(line) = lines.next_line().await? {
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let ty = v["type"].as_str().unwrap_or("");
            if ty == "assistant" || ty == "user" {
                println!("  fake-claude> {line}");
            }
            if ty == "user" {
                tool_result = Some(v["message"]["content"][0].clone());
            }
            if ty == "result" {
                println!("  fake-claude> {line}");
                break;
            }
        }
        anyhow::Ok(())
    };
    tokio::time::timeout(Duration::from_secs(60), read)
        .await
        .context("fake-claude: no result line within 60 s")??;
    drop(stdin); // stdin EOF: fake-claude exits 0
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await??;

    let calls = session.calls.lock().unwrap().clone();
    let cs = calls.iter().find(|c| c.tool == "complete_state");
    r.check(
        "fake-claude complete_state recorded",
        cs.is_some_and(|c| {
            c.args["result"] == json!({"probe":"ok"}) && c.args["transition"] == json!("done")
        }),
        format!("{:?}", cs.map(|c| &c.args)),
    );
    let tr = tool_result.unwrap_or(Value::Null);
    r.check(
        "fake-claude tool_result",
        tr["is_error"] == json!(false) && tr["content"][0]["text"] == json!(COMPLETE_STATE_RETURN),
        tr.to_string(),
    );
    r.check("fake-claude exit 0", status.success(), format!("{status}"));
    Ok(())
}

async fn probe_held(
    r: &mut Report,
    client: &reqwest::Client,
    url: &str,
    hold: Duration,
) -> Result<()> {
    raw_session(client, url).await?;
    let started = Instant::now();
    let held = {
        let client = client.clone();
        let url = url.to_owned();
        tokio::spawn(async move {
            rpc(
                &client,
                &url,
                None,
                json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{
                    "name":"permission",
                    "arguments":{"tool_name":"Bash","input":{"command":"echo hi"},"tool_use_id":"toolu_probe"}}}),
            )
            .await
        })
    };
    // While the call is held, another call on the same token answers at once.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let t = Instant::now();
    let (_, v, _) = rpc(
        client,
        url,
        None,
        json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{
            "name":"ask_user","arguments":{"question":"concurrent?"}}}),
    )
    .await?;
    let concurrent_ms = t.elapsed().as_millis();
    r.check(
        "call during a held call answers at once",
        v.as_ref().is_some_and(|v| tool_text(v) == ASK_USER_RETURN) && concurrent_ms < 2_000,
        format!("{concurrent_ms} ms"),
    );
    let (s, v, ctype) = held.await??;
    let elapsed = started.elapsed();
    let reply: Value = v
        .as_ref()
        .and_then(|v| serde_json::from_str(&tool_text(v)).ok())
        .unwrap_or(Value::Null);
    r.check(
        &format!("permission held >= {}s", hold.as_secs()),
        s == 200
            && elapsed >= hold
            && reply["behavior"] == json!("allow")
            && reply["updatedInput"] == json!({"command":"echo hi"}),
        format!(
            "HTTP {s} {ctype} after {:.1} s: {reply}",
            elapsed.as_secs_f64()
        ),
    );
    Ok(())
}

/// Opt-in (`E2E_REAL_CLAUDE=1`): it spends cents. Flags as `cli-driver.ts` passes them.
async fn probe_real_claude(r: &mut Report, url: &str, session: &Session) -> Result<()> {
    let cfg = mcp_config(url)?;
    let started = Instant::now();
    let out = tokio::process::Command::new("claude")
        .args([
            "-p",
            "--model",
            "haiku",
            "--output-format",
            "stream-json",
            "--verbose",
        ])
        .arg("--mcp-config")
        .arg(cfg.path())
        .args([
            "--strict-mcp-config",
            "--allowedTools",
            "mcp__conductor__complete_state",
        ])
        .arg(
            "Call the mcp__conductor__complete_state tool with result {\"probe\":\"real\"}, \
             transition \"done\" and reason \"probe\". Then stop.",
        )
        .stdin(Stdio::null())
        .output()
        .await
        .context("spawn claude")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        if line.contains("tool_use") || line.contains("tool_result") || line.contains("\"result\"")
        {
            println!("  claude> {}", &line[..line.len().min(600)]);
        }
    }
    let calls = session.calls.lock().unwrap().clone();
    let cs = calls.iter().find(|c| c.tool == "complete_state");
    r.check(
        "real claude complete_state recorded",
        cs.is_some_and(|c| c.args["result"] == json!({"probe":"real"})),
        format!(
            "{:?} after {:.1} s, exit {}",
            cs.map(|c| &c.args),
            started.elapsed().as_secs_f64(),
            out.status
        ),
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let hold = Duration::from_secs(args.hold_secs);
    let server = Server::start(hold).await?;
    log(&format!(
        "rmcp {} outcome server on 127.0.0.1:{}",
        "3.8.0", server.port
    ));
    let client = reqwest::Client::builder()
        .timeout(hold + Duration::from_secs(120))
        .build()?;
    let mut r = Report { failed: false };

    let (_, url, _) = server.register();
    probe_tools_list(&mut r, &client, &url).await?;
    probe_guards(&mut r, &client, server.port, &url).await?;

    let (_, url, session) = server.register();
    if let Err(e) = probe_fake_claude(&mut r, &args, &url, &session).await {
        r.check("fake-claude", false, format!("{e:#}"));
    }

    if !args.skip_hold {
        let (_, url, _) = server.register();
        if let Err(e) = probe_held(&mut r, &client, &url, hold).await {
            r.check("held call", false, format!("{e:#}"));
        }
    }

    if std::env::var("E2E_REAL_CLAUDE").as_deref() == Ok("1") {
        let (_, url, session) = server.register();
        if let Err(e) = probe_real_claude(&mut r, &url, &session).await {
            r.check("real claude", false, format!("{e:#}"));
        }
    } else {
        println!("SKIP real claude (set E2E_REAL_CLAUDE=1; spends cents)");
    }

    if r.failed {
        std::process::exit(1);
    }
    println!("mcp-probe: all checks passed");
    Ok(())
}
