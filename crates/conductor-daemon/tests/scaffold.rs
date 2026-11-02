//! The Rust twin of `packages/daemon/src/index.test.ts` ("resolves @conductor/shared across the
//! workspace"): the daemon crate links the generated protocol crate.

#[test]
fn resolves_the_protocol_crate() {
    assert_eq!(conductor_protocol::PROTOCOL_VERSION, 2);
    assert_eq!(
        conductor_daemon::config::daemon_version(&Default::default()),
        env!("CARGO_PKG_VERSION")
    );
}
