//! Port of `packages/daemon/src/platform/index.ts` (MR-T04).
//!
//! The only place OS-specific code (`cfg(windows)`, `cfg(unix)`, `cfg(target_os = …)`) may live
//! (tests/seam.rs).
//!
//! Declared up front (MR-T02): fill the files in, don't edit this list.

pub mod acl;
pub mod fs;
pub mod git;
pub mod hook;
pub mod kill_tree;
pub mod procinfo;
pub mod shell;
pub mod spawn;
pub mod sysres;
