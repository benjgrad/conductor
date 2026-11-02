//! MR-T05 FR-5: the Rust daemon reads the files the TS daemon wrote (`machine.json`,
//! `config.json`, `state/daemon.json`), and writes files the TS daemon reads, so a machine
//! upgrades in place without re-enrolling (ADR-0026 §4).
//!
//! - `tests/fixtures/ts/*` were written by the TS daemon's own code:
//!   `UPDATE_TS_FIXTURES=1 pnpm vitest run --project daemon src/rust-compat.test.ts`
//!   (`packages/daemon/src/rust-compat.test.ts`, which also checks they're still current).
//! - `tests/fixtures/rust/*` are written here: `UPDATE_RUST_FIXTURES=1 cargo test -p
//!   conductor-daemon --test compat_ts_files` regenerates them; otherwise this test checks they
//!   are still what the Rust code writes. The TS test reads them.
//!
//! Both sides build the same sample content (keep it in step with `rust-compat.test.ts`).

use conductor_daemon::config::{
    DaemonFileConfig, RepoFileConfig, read_file_config, write_file_config,
};
use conductor_daemon::credential::{MachineCredential, load_credential, write_credential};
use conductor_daemon::platform::{mkdir_private, write_private_file};
use conductor_daemon::store::{
    AckRecord, AgentRecord, BufferedEvent, DaemonStore, DurableMessage, PersistedSession, PortRange,
};
use conductor_protocol::WorkingCopyMode;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const SID: &str = "7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f";
const CLAUDE_ID: &str = "3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19";
const REPO_PATH: &str = "/home/me/.conductor/repos/github.com_org_app-0a1b2c3d";

fn fixtures(side: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(side)
}

fn sample_cred() -> MachineCredential {
    MachineCredential {
        url: "https://conductor.example.com".into(),
        machine_id: "m-1".into(),
        credential: "secret-xyz".into(),
    }
}

fn sample_config() -> DaemonFileConfig {
    let mode = |mode| RepoFileConfig { mode };
    DaemonFileConfig {
        roots: vec!["/src/a".into(), "/src/b".into()],
        repos: BTreeMap::from([
            ("github.com/org/app".into(), mode(WorkingCopyMode::Checkout)),
            (
                "github.com/org/lib".into(),
                mode(WorkingCopyMode::Reference),
            ),
        ]),
    }
}

fn msg(v: Value) -> DurableMessage {
    serde_json::from_value(v).expect("a valid durable message")
}

fn heartbeat() -> DurableMessage {
    msg(json!({
        "type": "session_event",
        "msg_id": "00000000-0000-4000-8000-000000000001",
        "session_id": SID,
        "fencing_token": 1,
        "payload": { "kind": "heartbeat", "data": {} },
    }))
}

fn permission() -> DurableMessage {
    msg(json!({
        "type": "permission_request",
        "msg_id": "00000000-0000-4000-8000-0000000a0001",
        "session_id": SID,
        "fencing_token": 1,
        "payload": {
            "request_id": "4f3e2d1c-0b9a-4876-9543-210fedcba987",
            "session_id": SID,
            "tool": "Bash",
            "input": { "command": "pnpm exec tsc -b" },
            "expires_at": "2026-10-22T12:30:00.000Z",
        },
    }))
}

fn session(
    port_range: Option<PortRange>,
    claude: Option<&str>,
    agent: Option<Option<AgentRecord>>,
) -> PersistedSession {
    PersistedSession {
        ticket_id: "b1d1f6a2-6c8e-4f3a-9d2b-0e1f2a3b4c5d".into(),
        repo: "github.com/org/app".into(),
        worktree_path: "/home/me/.conductor/wt/s".into(),
        branch: "conductor/t/s".into(),
        port_range,
        claude_session_id: claude.map(String::from),
        last_used_at: 1_793_095_872_000,
        agent,
    }
}

fn sample_sessions() -> BTreeMap<String, PersistedSession> {
    let range = Some(PortRange {
        base: 41000,
        count: 10,
    });
    BTreeMap::from([
        ("session-a".into(), session(None, None, None)),
        (
            "session-b".into(),
            session(range, Some(CLAUDE_ID), Some(None)),
        ),
        (
            "session-c".into(),
            session(
                range,
                Some(CLAUDE_ID),
                Some(Some(AgentRecord {
                    command_id: "11111111-1111-4111-8111-111111111111".into(),
                    fencing_token: 2,
                    pid: Some(4242),
                    claude_session_id: Some(CLAUDE_ID.into()),
                    started_at: Some(1_793_095_872_000),
                })),
            ),
        ),
    ])
}

/// The sample store, built through the store's own API (as the TS test builds it).
fn build_store(file: &Path) -> DaemonStore {
    let mut s = DaemonStore::new(file).unwrap();
    s.on_registered(None).unwrap();
    s.push_event(heartbeat(), true).unwrap(); // seq 0
    s.push_event(permission(), false).unwrap(); // unsequenced
    s.record_ack(
        "c1",
        AckRecord {
            accepted: false,
            reason: Some("max_sessions".into()),
        },
    )
    .unwrap();
    s.record_ack(
        "c2",
        AckRecord {
            accepted: true,
            reason: None,
        },
    )
    .unwrap();
    for (id, sess) in sample_sessions() {
        s.put_session(&id, sess).unwrap();
    }
    s.put_repo("github.com/org/app", REPO_PATH).unwrap();
    s
}

fn assert_sample_store(s: &DaemonStore) {
    assert_eq!(s.last_seq(), Some(0));
    assert_eq!(
        s.events(),
        &[
            BufferedEvent {
                seq: Some(0),
                msg: heartbeat()
            },
            BufferedEvent {
                seq: None,
                msg: permission()
            },
        ]
    );
    assert_eq!(
        s.ack_for("c1"),
        Some(&AckRecord {
            accepted: false,
            reason: Some("max_sessions".into())
        })
    );
    assert_eq!(
        s.ack_for("c2"),
        Some(&AckRecord {
            accepted: true,
            reason: None
        })
    );
    assert_eq!(s.sessions(), &sample_sessions());
    assert_eq!(
        s.repos(),
        &BTreeMap::from([("github.com/org/app".to_string(), REPO_PATH.to_string())])
    );
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A temp dir made private first (%TEMP% is not owner-only on Windows, and `mkdir_private`
/// refuses to create under a non-private parent).
fn private_tmp() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    mkdir_private(tmp.path()).unwrap();
    tmp
}

/// A private copy of a fixture (git checks files out world-readable).
fn private_copy(src: &Path, dir: &Path, name: &str) {
    mkdir_private(dir).unwrap();
    write_private_file(&dir.join(name), &std::fs::read(src).unwrap()).unwrap();
}

#[test]
fn reads_the_files_the_ts_daemon_wrote() {
    let ts = fixtures("ts");
    let tmp = private_tmp();
    let root = tmp.path().join("root");
    private_copy(&ts.join("machine.json"), &root, "machine.json");
    private_copy(&ts.join("config.json"), &root, "config.json");
    assert_eq!(load_credential(&root).unwrap(), Some(sample_cred()));
    assert_eq!(read_file_config(&root).unwrap(), sample_config());

    let store = DaemonStore::new(ts.join("daemon.json")).unwrap();
    assert_sample_store(&store);
    // Rewritten by Rust, it is the same document (key order aside).
    let back: Value = serde_json::from_str(&store.to_json()).unwrap();
    assert_eq!(back, read_json(&ts.join("daemon.json")));
}

#[test]
fn the_rust_fixtures_are_what_the_rust_daemon_writes() {
    let tmp = private_tmp();
    let root = tmp.path().join("root");
    write_credential(&root, &sample_cred(), false).unwrap();
    write_file_config(&root, &sample_config()).unwrap();
    assert_sample_store(&build_store(&root.join("state").join("daemon.json")));

    let rust = fixtures("rust");
    for (name, written) in [
        ("machine.json", root.join("machine.json")),
        ("config.json", root.join("config.json")),
        ("daemon.json", root.join("state").join("daemon.json")),
    ] {
        let text = std::fs::read_to_string(&written).unwrap();
        if std::env::var("UPDATE_RUST_FIXTURES").as_deref() == Ok("1") {
            std::fs::write(rust.join(name), &text).unwrap();
        }
        let committed = std::fs::read_to_string(rust.join(name))
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(
            committed, text,
            "{name} (UPDATE_RUST_FIXTURES=1 regenerates it)"
        );
        // And the same document as the TS daemon's.
        assert_eq!(
            read_json(&rust.join(name)),
            read_json(&fixtures("ts").join(name)),
            "{name}"
        );
    }
}
