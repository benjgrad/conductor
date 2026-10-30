//! MR-T03 FR-3: the shared JSON vectors in `packages/shared/protocol-json/vectors`. The same
//! files run against the TypeScript originals in `packages/shared/src/protocol/protocol-json.test.ts`.

use std::path::Path;

use conductor_protocol::Capability;
use conductor_protocol::auth::daemon_auth_header_value;
use conductor_protocol::capabilities::{capability_key, capability_keys, cli_version_at_least};
use conductor_protocol::json::json_byte_length;
use conductor_protocol::repo::{canonical_repo, is_canonical_remote};
use conductor_protocol::tool_policy::{ToolPolicy, resolve_tool_policy};
use serde_json::Value;

fn cases(name: &str) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/protocol-json/vectors")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["function"], name);
    let cases = v["cases"].as_array().unwrap().clone();
    assert!(!cases.is_empty());
    cases
}

fn str_of(v: &Value) -> &str {
    v.as_str().expect("string input")
}

#[test]
fn canonical_repo_vectors() {
    for c in cases("canonicalRepo") {
        let expected = c["expected"].as_str().map(str::to_string);
        assert_eq!(
            canonical_repo(str_of(&c["input"])),
            expected,
            "{:?}",
            c["input"]
        );
    }
}

#[test]
fn is_canonical_remote_vectors() {
    for c in cases("isCanonicalRemote") {
        let expected = c["expected"].as_bool().unwrap();
        assert_eq!(
            is_canonical_remote(str_of(&c["input"])),
            expected,
            "{:?}",
            c["input"]
        );
    }
}

#[test]
fn cli_version_at_least_vectors() {
    for c in cases("cliVersionAtLeast") {
        let version = c["input"]["version"].as_str();
        let min = str_of(&c["input"]["min"]);
        let expected = c["expected"].as_bool().unwrap();
        assert_eq!(
            cli_version_at_least(version, min),
            expected,
            "{:?}",
            c["input"]
        );
    }
}

#[test]
fn capability_key_vectors() {
    for c in cases("capabilityKey") {
        let cap: Capability = serde_json::from_value(c["input"].clone()).unwrap();
        assert_eq!(
            capability_key(&cap),
            str_of(&c["expected"]),
            "{:?}",
            c["input"]
        );
    }
    for c in cases("capabilityKeys") {
        let cap: Capability = serde_json::from_value(c["input"].clone()).unwrap();
        let expected: Vec<String> = serde_json::from_value(c["expected"].clone()).unwrap();
        assert_eq!(capability_keys(&cap), expected, "{:?}", c["input"]);
    }
}

#[test]
fn daemon_auth_header_value_vectors() {
    for c in cases("daemonAuthHeaderValue") {
        assert_eq!(
            daemon_auth_header_value(str_of(&c["input"])),
            str_of(&c["expected"])
        );
    }
}

#[test]
fn json_byte_length_vectors() {
    for c in cases("jsonByteLength") {
        let expected = c["expected"].as_u64().unwrap() as usize;
        assert_eq!(json_byte_length(&c["input"]), expected, "{}", c["input"]);
    }
}

#[test]
fn resolve_tool_policy_vectors() {
    for c in cases("resolveToolPolicy") {
        let tools: Vec<String> = serde_json::from_value(c["input"].clone()).unwrap();
        match resolve_tool_policy(&tools) {
            Ok(policy) => {
                let expected: ToolPolicy = serde_json::from_value(c["expected"].clone())
                    .unwrap_or_else(|_| panic!("{tools:?} should fail: {policy:?}"));
                assert_eq!(policy, expected, "{tools:?}");
            }
            Err(e) => {
                let expected: Vec<String> = serde_json::from_value(c["error"]["unknown"].clone())
                    .unwrap_or_else(|_| panic!("{tools:?} should resolve: {e}"));
                assert_eq!(e.names, expected, "{tools:?}");
            }
        }
    }
}
