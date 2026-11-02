//! Port of `packages/daemon/src/commands/index.ts` (MR-T07): the command modules and the
//! `create_command_runner` factory.
//!
//! Declared up front (MR-T02): fill the files in, don't edit this list.

pub mod config;
pub mod enroll;
pub mod fake_runner;
pub mod process_runner;
pub mod runner;
pub mod semaphore;
pub mod service;
pub mod tail;

pub use process_runner::{ProcessCommandRunner, ProcessCommandRunnerOptions};

/// `createCommandRunner` (M1-T06, 10-contracts §Seams): the real runner (`sh -c` in its own
/// process group or job, timeout, build semaphore, output tail), sized by
/// `machine.max_concurrent_builds`.
pub fn create_command_runner(max_concurrent: usize) -> Box<dyn runner::CommandRunner> {
    Box::new(
        ProcessCommandRunner::new(ProcessCommandRunnerOptions {
            max_concurrent,
            ..Default::default()
        })
        // `config` refuses CONDUCTOR_MAX_CONCURRENT_BUILDS below 1.
        .expect("max_concurrent_builds >= 1 (config validates it)"),
    )
}
