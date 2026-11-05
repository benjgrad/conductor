//! MR-T08 verification: `fake-claude.mjs` (the official TS MCP SDK client, the same client side
//! real Claude Code uses) completes a state against the Rust outcome server, and its stdout goes
//! through the Rust stream parser. This spawns node on purpose: the client across a real process
//! and HTTP boundary is what is under test.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conductor_daemon::claude::driver::{DriverEvent, OutputStream};
use conductor_daemon::claude::outcome_server::{
    COMPLETE_STATE_RETURN, CompleteStateMeta, OutcomeHandlers, OutcomeRegisterOptions,
    OutcomeServerOptions, start_outcome_server,
};
use conductor_daemon::claude::stream_parser::{ParsedLine, parse_stream_line};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// node and the daemon package's installed MCP SDK, or why the test is skipped.
fn prerequisites() -> Result<PathBuf, String> {
    let script = repo().join("packages/daemon/test/fixtures/fake-claude.mjs");
    let sdk = repo().join("packages/daemon/node_modules/@modelcontextprotocol/sdk");
    if !sdk.exists() {
        return Err(format!("{} missing (run pnpm install)", sdk.display()));
    }
    match std::process::Command::new("node").arg("--version").output() {
        Ok(o) if o.status.success() => Ok(script),
        _ => Err("node is not on PATH".into()),
    }
}

#[tokio::test]
async fn fake_claude_completes_a_state_against_the_rust_server() {
    let script = match prerequisites() {
        Ok(s) => s,
        Err(why) => {
            eprintln!("SKIP fake_claude_completes_a_state_against_the_rust_server: {why}");
            return;
        }
    };
    let server = start_outcome_server(OutcomeServerOptions::default())
        .await
        .unwrap();
    let done: Arc<Mutex<Vec<(Value, CompleteStateMeta)>>> = Arc::default();
    let d = done.clone();
    let reg = server.register(
        OutcomeHandlers {
            on_complete_state: Arc::new(move |r, m| d.lock().unwrap().push((Value::Object(r), m))),
            on_ask_user: Arc::new(|_, _| {}),
            on_permission_request: None,
            on_attach_file: None,
        },
        OutcomeRegisterOptions::default(),
    );
    let tmp = tempfile::tempdir().unwrap();
    let cfg = tmp.path().join("mcp.json");
    std::fs::write(&cfg, reg.mcp_config()).unwrap();
    let state = tmp.path().join("state");
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut child = tokio::process::Command::new("node")
        .arg(&script)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ])
        .args(["--verbose", "--session-id", &session_id, "--mcp-config"])
        .arg(&cfg)
        .current_dir(tmp.path())
        .env("FAKE_CLAUDE_STATE_DIR", &state)
        .env(
            "FAKE_CLAUDE_SCENARIO",
            r#"[[{"complete_state":{"probe":"ok"},"transition":"done","reason":"probe"}]]"#,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn fake-claude");
    let mut stdin = child.stdin.take().unwrap();
    let first = json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "go"}]}});
    stdin
        .write_all(format!("{first}\n").as_bytes())
        .await
        .unwrap();

    let mut parsed: Vec<ParsedLine> = Vec::new();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let read = async {
        while let Some(line) = lines.next_line().await.unwrap() {
            let items = parse_stream_line(&line);
            let end = items
                .iter()
                .any(|p| matches!(p, ParsedLine::Event(DriverEvent::TurnEnd { .. })));
            parsed.extend(items);
            if end {
                break;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(60), read)
        .await
        .expect("fake-claude ends its turn within 60 s");
    drop(stdin); // stdin EOF: fake-claude exits 0
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{status}");

    let done = done.lock().unwrap().clone();
    assert_eq!(
        done,
        vec![(
            json!({"probe": "ok"}),
            CompleteStateMeta {
                transition: Some("done".into()),
                reason: Some("probe".into()),
            }
        )]
    );
    assert!(reg.completed());
    assert!(
        parsed
            .iter()
            .any(|p| matches!(p, ParsedLine::Init { session_id: Some(s), .. } if *s == session_id)),
        "{parsed:?}"
    );
    assert!(
        parsed.iter().any(|p| matches!(
            p,
            ParsedLine::Event(DriverEvent::Output { stream: OutputStream::ToolResult, text })
                if text == COMPLETE_STATE_RETURN
        )),
        "{parsed:?}"
    );
    assert!(parsed.iter().any(|p| matches!(
        p,
        ParsedLine::Event(DriverEvent::TurnEnd {
            is_error: false,
            ..
        })
    )));
    server.close().await;
}
