//! conductor-daemon: the Rust port of `packages/daemon` (ADR-0026). The frozen TS daemon is the
//! behaviour reference, and `PARITY.md` maps each of its test cases to a Rust test.
//!
//! Every module is declared here up front (MR-T02): later tickets fill the files in and never
//! edit this list. OS-specific code lives only under `platform/` (tests/seam.rs).

pub mod actions;
pub mod claude;
pub mod commands;
pub mod config;
pub mod credential;
pub mod daemon;
pub mod exec;
pub mod inventory;
pub mod orphan;
pub mod platform;
pub mod ports;
pub mod store;
pub mod sysinfo;
pub mod system_prompt;
#[doc(hidden)]
pub mod test_support;
pub mod update;
pub mod workspace;
pub mod ws_client;
