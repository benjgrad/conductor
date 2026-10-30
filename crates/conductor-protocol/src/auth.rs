//! The machine credential header (`protocol/ws.ts`).

/// The `DAEMON_AUTH_HEADER` value for a credential (`daemonAuthHeaderValue`).
pub fn daemon_auth_header_value(credential: &str) -> String {
    format!("Bearer {credential}")
}
