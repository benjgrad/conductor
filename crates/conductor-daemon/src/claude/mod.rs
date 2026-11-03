//! Port of `packages/daemon/src/claude/index.ts` (MR-T08).
//!
//! Declared up front (MR-T02): fill the files in, don't edit this list.

pub mod cli_driver;
pub mod driver;
pub mod edit_guard;
pub mod fake_driver;
/// ADR-0033 P2 (MA-T03): new in Rust, added after MR-T02's list (no TS counterpart).
pub mod oneshot;
pub mod outcome_server;
pub mod stream_parser;
pub mod transcript;
