//! The daemon ↔ orchestrator wire protocol, generated from `packages/shared`'s zod schemas
//! (ADR-0026 §2, MR-T03). `generated.rs` is typify output plus the protocol constants; never edit
//! it by hand (see README.md). The other modules are hand-written ports of the shared helpers the
//! daemon calls, checked against the same JSON vectors as their TypeScript originals.

// TD-196: zod refinements and non-tag literals are not enforced by these types (README §Known gaps).
#[allow(
    clippy::all,
    clippy::pedantic,
    dead_code,
    missing_docs,
    unused_imports,
    irrefutable_let_patterns
)]
mod generated;
pub use generated::*;

pub mod auth;
pub mod capabilities;
pub mod json;
pub mod repo;
pub mod tool_policy;
pub mod wire;

/// Parse one orchestrator → daemon WS frame (the TS `parseOrchestratorMessage`).
pub fn parse_orchestrator_message(frame: &str) -> serde_json::Result<OrchestratorToDaemon> {
    serde_json::from_str(frame)
}

/// Parse one daemon → orchestrator WS frame (the TS `parseDaemonMessage`).
pub fn parse_daemon_message(frame: &str) -> serde_json::Result<DaemonToOrchestrator> {
    serde_json::from_str(frame)
}
