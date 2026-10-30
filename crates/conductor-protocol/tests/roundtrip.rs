//! MR-T03 FR-4: every fixture in `packages/shared/protocol-json/fixtures` parses into the
//! generated types, re-serialises, and equals the original after canonical JSON. The Rust output
//! is kept as `protocol-json/roundtrip/<file>` (golden files), which the vitest side
//! (`packages/shared/src/protocol/protocol-json.test.ts`) parses with the zod schemas.
//!
//! `CONDUCTOR_UPDATE_GOLDEN=1 cargo nextest run -p conductor-protocol` rewrites the goldens.

use std::path::{Path, PathBuf};

use conductor_protocol::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn protocol_json() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/shared/protocol-json")
}

fn read(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Sorted keys (serde_json's Map is a BTreeMap), and an integral float compares as an integer:
/// Rust writes an `f64` 2 as `2.0` where JS writes `2`, which is the same JSON number.
fn canonical(v: &Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                // Exact: |f| < 2^53.
                Value::from(f as i64)
            }
            _ => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), canonical(v))).collect())
        }
        _ => v.clone(),
    }
}

fn round_trip<T: DeserializeOwned + Serialize>(fixture: &Value, what: &str) -> Value {
    let parsed: T = serde_json::from_value(fixture.clone())
        .unwrap_or_else(|e| panic!("{what} does not parse in Rust: {e}"));
    serde_json::to_value(&parsed).unwrap_or_else(|e| panic!("{what} does not serialise: {e}"))
}

fn round_trip_as(schema: &str, fixture: &Value, what: &str) -> Value {
    match schema {
        "DaemonToOrchestrator" => round_trip::<DaemonToOrchestrator>(fixture, what),
        "OrchestratorToDaemon" => round_trip::<OrchestratorToDaemon>(fixture, what),
        "SessionEventPayload" => round_trip::<SessionEventPayload>(fixture, what),
        "Capability" => round_trip::<Capability>(fixture, what),
        "InventoryRepo" => round_trip::<InventoryRepo>(fixture, what),
        "OpenPrResult" => round_trip::<OpenPrResult>(fixture, what),
        "InspectPrArgs" => round_trip::<InspectPrArgs>(fixture, what),
        "InspectPrResult" => round_trip::<InspectPrResult>(fixture, what),
        "MergePrArgs" => round_trip::<MergePrArgs>(fixture, what),
        "MergePrResult" => round_trip::<MergePrResult>(fixture, what),
        "ClosePrArgs" => round_trip::<ClosePrArgs>(fixture, what),
        "ClosePrResult" => round_trip::<ClosePrResult>(fixture, what),
        other => panic!("{what}: no Rust type mapped for schema {other} (add it here)"),
    }
}

#[derive(serde::Deserialize)]
struct Entry {
    file: String,
    schema: Option<String>,
    array: bool,
}

#[test]
fn every_fixture_round_trips_and_matches_its_golden() {
    let dir = protocol_json();
    let manifest: Vec<Entry> =
        serde_json::from_value(read(&dir.join("fixtures/manifest.json"))).expect("manifest");
    let update = std::env::var("CONDUCTOR_UPDATE_GOLDEN").is_ok_and(|v| v == "1");
    let mut checked = 0;
    for entry in manifest {
        let Some(schema) = entry.schema else { continue };
        let fixture = read(&dir.join("fixtures").join(&entry.file));
        let out = if entry.array {
            let items = fixture.as_array().expect("array fixture");
            Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, v)| round_trip_as(&schema, v, &format!("{}[{i}]", entry.file)))
                    .collect(),
            )
        } else {
            round_trip_as(&schema, &fixture, &entry.file)
        };
        assert_eq!(
            canonical(&out),
            canonical(&fixture),
            "{} changed in the Rust round trip",
            entry.file
        );
        let golden = dir.join("roundtrip").join(&entry.file);
        if update {
            std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
            let text = serde_json::to_string_pretty(&out).unwrap() + "\n";
            std::fs::write(&golden, text).unwrap();
        } else {
            assert!(
                golden.exists(),
                "{} has no golden: run CONDUCTOR_UPDATE_GOLDEN=1 cargo nextest run -p conductor-protocol",
                golden.display()
            );
            // By value, not bytes: a Windows checkout may have CRLF line endings.
            assert_eq!(
                canonical(&read(&golden)),
                canonical(&out),
                "{} golden is stale",
                entry.file
            );
        }
        checked += 1;
    }
    assert!(checked > 80, "only {checked} fixtures checked");
}

fn fixture(file: &str) -> Value {
    read(&protocol_json().join("fixtures").join(file))
}

#[test]
fn explicit_null_and_absent_optionals_both_survive() {
    // `enrollment_token` is `.nullable().optional()`: the TS daemon sends null in local mode.
    let v1 = fixture("DAEMON_FIXTURES.register.json");
    assert_eq!(v1["payload"]["enrollment_token"], Value::Null);
    let out = round_trip::<DaemonToOrchestrator>(&v1, "register");
    assert_eq!(out["payload"].get("enrollment_token"), Some(&Value::Null));

    let v2 = fixture("M2_WS_FIXTURES.register_v2.json");
    assert!(v2["payload"].get("enrollment_token").is_none());
    let out = round_trip::<DaemonToOrchestrator>(&v2, "register_v2");
    assert!(out["payload"].get("enrollment_token").is_none());

    // A plain optional (`stderr_tail`) stays absent, never `null` (the PR #74 spike finding).
    let exit = fixture("SESSION_EVENT_FIXTURES.exit.json");
    let out = round_trip::<SessionEventPayload>(&exit, "exit");
    assert!(
        out["data"]
            .as_object()
            .unwrap()
            .get("stderr_tail")
            .is_none()
    );
}

#[test]
fn unknown_fields_are_ignored_like_zod_strips_them() {
    let mut v = fixture("ORCHESTRATOR_FIXTURES.registered.json");
    v["future_field"] = Value::from(1);
    v["payload"]["also_new"] = Value::from("x");
    let parsed: OrchestratorToDaemon = serde_json::from_value(v).expect("forward compatible");
    assert!(matches!(parsed, OrchestratorToDaemon::Registered { .. }));
}

#[test]
fn the_type_tag_picks_the_variant() {
    // An untagged union would read this payload-compatible frame as `no_work`.
    let v = fixture("ORCHESTRATOR_FIXTURES.fetch_transcript.json");
    let text = serde_json::to_string(&v).unwrap();
    let parsed = parse_orchestrator_message(&text).expect("parses");
    assert!(matches!(
        parsed,
        OrchestratorToDaemon::FetchTranscript { .. }
    ));

    let mut wrong = v.clone();
    wrong["type"] = Value::from("no_such_type");
    assert!(serde_json::from_value::<OrchestratorToDaemon>(wrong).is_err());
}

#[test]
fn invalid_frames_are_refused() {
    let mut v = fixture("DAEMON_FIXTURES.heartbeat.json");
    v["msg_id"] = Value::from("not-a-uuid");
    assert!(serde_json::from_value::<DaemonToOrchestrator>(v).is_err());

    let mut v = fixture("DAEMON_FIXTURES.output.json");
    v["payload"]["ts"] = Value::from("yesterday");
    assert!(serde_json::from_value::<DaemonToOrchestrator>(v).is_err());

    let mut v = fixture("ORCHESTRATOR_FIXTURES.run_cmd.json");
    v["payload"].as_object_mut().unwrap().remove("cmd");
    assert!(serde_json::from_value::<OrchestratorToDaemon>(v).is_err());
}

#[test]
fn constants_match_constants_json() {
    let c = read(&protocol_json().join("constants.json"));
    assert_eq!(c["PROTOCOL_VERSION"], PROTOCOL_VERSION);
    assert_eq!(c["CLOSE_PROTOCOL"], CLOSE_PROTOCOL);
    assert_eq!(
        c["DEFAULT_PERMISSION_TIMEOUT_MS"],
        DEFAULT_PERMISSION_TIMEOUT_MS
    );
    assert_eq!(
        c["CLOSE_REASONS"]["4001"],
        close_reason(CLOSE_REVOKED).unwrap()
    );
    assert_eq!(close_reason(1000), None);
    assert_eq!(api_paths::DAEMON_WS, "/ws/daemon");
    assert_eq!(
        api_paths::daemon_download("latest.json"),
        "/downloads/latest.json"
    );
    assert_eq!(c["GH_MIN_VERSION"], GH_MIN_VERSION);
}
