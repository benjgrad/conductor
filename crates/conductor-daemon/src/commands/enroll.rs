//! Port of `packages/daemon/src/commands/enroll.ts` (M2-T04; MR-T13a): `conductor-daemon enroll
//! --url <https url> --token <token> [--force]` (ADR-0013 §Enrollment, ADR-0017 §Daemon
//! distribution). Trades a one-time enrollment token for the machine id and credential, saved to
//! `<root>/machine.json`. Checks the root before the request so a refused run doesn't spend the
//! token. Never prints the credential or the token.
//!
//! TD-117 (M2-T14): the token can stay off argv: `--token -` reads it from stdin, and without
//! `--token` it comes from `CONDUCTOR_ENROLL_TOKEN` (what install.sh uses). The variable is removed
//! from the environment first thing (`main` also removes it from the process's own environment
//! before anything else runs), so no child process ever inherits it. `--token <value>` still works,
//! with a warning that argv is visible to other users.

use super::{Output, parse_args};
use crate::config::{Env, MachineFacts, daemon_version, root_dir_from};
use crate::credential::{
    MachineCredential, check_writable, credential_path, is_secure_or_loopback, write_credential,
};
use conductor_protocol::{
    EnrollRequest, EnrollRequestArch, EnrollRequestDaemonVersion, EnrollRequestHostname,
    EnrollRequestOs, EnrollRequestToken, EnrollResponse, api_paths,
};
use reqwest::Url;
use std::io;
use std::time::Duration;

pub const ENROLL_TOKEN_ENV: &str = "CONDUCTOR_ENROLL_TOKEN";

pub const ENROLL_USAGE: &str =
    "usage: conductor-daemon enroll --url <https url> [--token <token> | --token -] [--force]
       (without --token: the token from CONDUCTOR_ENROLL_TOKEN; --token - reads it from stdin)";

const ENROLL_TIMEOUT: Duration = Duration::from_secs(15);

/// What `enroll` needs from the machine; tests pass fakes.
pub struct EnrollDeps<'a> {
    /// The environment; `CONDUCTOR_ENROLL_TOKEN` is removed from it first thing.
    pub env: &'a mut Env,
    pub facts: MachineFacts,
    /// Node's `os.platform()` / `os.arch()` names (what the orchestrator stores).
    pub os: String,
    pub arch: String,
    pub io: &'a mut dyn Output,
    /// All of stdin, for `--token -`.
    pub read_stdin: &'a mut dyn FnMut() -> io::Result<String>,
}

/// `host` as Node's `URL.host`: the host name, plus `:port` unless it is the scheme's default.
fn url_host(u: &Url) -> String {
    let host = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

/// The orchestrator URL to store (origin + path, no trailing slash), or an error. https only;
/// plain http only to a loopback host (dev and tests).
pub fn enroll_url(raw: &str) -> Result<String, String> {
    let u = Url::parse(raw).map_err(|_| format!("--url {raw} is not a URL"))?;
    if !matches!(u.scheme(), "http" | "https") || !is_secure_or_loopback(&u) {
        return Err(format!(
            "--url must be https:// (got {}://{})",
            u.scheme(),
            url_host(&u)
        ));
    }
    Ok(format!(
        "{}{}",
        u.origin().ascii_serialization(),
        u.path().trim_end_matches('/')
    ))
}

/// The cause of a failed request, as TS printed it: `timed out`, an errno-style code for the
/// common socket errors, else the innermost message.
fn cause_of(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "timed out".into();
    }
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(e);
    let mut last = e.to_string();
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<io::Error>() {
            let code = match io.kind() {
                io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
                io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
                io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
                io::ErrorKind::HostUnreachable => Some("EHOSTUNREACH"),
                io::ErrorKind::NetworkUnreachable => Some("ENETUNREACH"),
                _ => None,
            };
            if let Some(code) = code {
                return code.into();
            }
        }
        last = s.to_string();
        src = s.source();
    }
    last
}

fn usage(io: &mut dyn Output, msg: &str) -> i32 {
    io.err(msg);
    io.err(ENROLL_USAGE);
    2
}

/// The request body, or the names of the fields that can't be sent (schema order).
fn enroll_request(
    token: &str,
    hostname: &str,
    os: &str,
    arch: &str,
    version: &str,
) -> Result<EnrollRequest, Vec<&'static str>> {
    let token = EnrollRequestToken::try_from(token);
    let hostname = EnrollRequestHostname::try_from(hostname);
    let os = EnrollRequestOs::try_from(os);
    let arch = EnrollRequestArch::try_from(arch);
    let daemon_version = EnrollRequestDaemonVersion::try_from(version);
    match (token, hostname, os, arch, daemon_version) {
        (Ok(token), Ok(hostname), Ok(os), Ok(arch), Ok(daemon_version)) => Ok(EnrollRequest {
            arch,
            daemon_version,
            hostname,
            os,
            token,
        }),
        (t, h, o, a, v) => {
            let mut bad = Vec::new();
            for (name, ok) in [
                ("token", t.is_ok()),
                ("hostname", h.is_ok()),
                ("os", o.is_ok()),
                ("arch", a.is_ok()),
                ("daemon_version", v.is_ok()),
            ] {
                if !ok {
                    bad.push(name);
                }
            }
            Err(bad)
        }
    }
}

/// Run `enroll`; returns the exit code (0 ok, 1 failed, 2 usage).
pub async fn enroll(argv: &[String], d: &mut EnrollDeps<'_>) -> i32 {
    // Taken out of the environment before anything else runs (TD-117); never logged.
    let env_token = d.env.remove(ENROLL_TOKEN_ENV);
    let parsed = match parse_args(argv, &["url", "token"], &["force"], false) {
        Ok(p) => p,
        Err(e) => return usage(d.io, &e),
    };
    let Some(url) = parsed.values.get("url").filter(|u| !u.is_empty()) else {
        return usage(d.io, "missing --url");
    };
    let token = match parsed.values.get("token").map(String::as_str) {
        Some("-") => match (d.read_stdin)() {
            // The first line, without its line ending.
            Ok(input) => {
                let line = input.split('\n').next().unwrap_or("");
                line.strip_suffix('\r').unwrap_or(line).to_string()
            }
            Err(e) => {
                d.io.err(&format!("--token -: cannot read stdin: {e}"));
                return 2;
            }
        },
        Some(t) => {
            d.io.err(&format!(
                "warning: --token <value> is visible to other users (ps) and in your shell history; \
                 prefer {ENROLL_TOKEN_ENV}=<token> or --token - (stdin)"
            ));
            t.to_string()
        }
        None => match env_token.filter(|t| !t.is_empty()) {
            Some(t) => t,
            None => return usage(d.io, &format!("missing --token (or {ENROLL_TOKEN_ENV})")),
        },
    };
    let target = match enroll_url(url) {
        Ok(t) => t,
        Err(e) => {
            d.io.err(&e);
            return 2;
        }
    };
    let force = parsed.flags.contains("force");
    let root = root_dir_from(d.env, &d.facts.home);
    if let Err(e) = check_writable(&root, force) {
        d.io.err(&format!("cannot enroll: {e}"));
        return 1;
    }

    let body = match enroll_request(
        &token,
        &d.facts.hostname,
        &d.os,
        &d.arch,
        &daemon_version(d.env),
    ) {
        Ok(b) => b,
        Err(fields) if fields.contains(&"token") => {
            return usage(
                d.io,
                "--token is not a valid enrollment token (empty or longer than 512 characters)",
            );
        }
        Err(fields) => {
            d.io.err(&format!(
                "cannot enroll: this machine's {} cannot be sent (invalid or too long)",
                fields.join(", ")
            ));
            return 1;
        }
    };
    let endpoint = Url::parse(&target)
        .and_then(|u| u.join(api_paths::MACHINES_ENROLL))
        .expect("an enroll_url result joins an absolute path");
    // Never follow a redirect: it would re-POST the one-time token to wherever it points.
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(ENROLL_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            d.io.err(&format!("cannot reach {target}: {}", cause_of(&e)));
            return 1;
        }
    };
    let res = match client
        .post(endpoint.clone())
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body).expect("a request serialises"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            d.io.err(&format!("cannot reach {target}: {}", cause_of(&e)));
            return 1;
        }
    };

    let status = res.status().as_u16();
    let header = |name: &str| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    if (300..400).contains(&status) {
        let where_ = header("location")
            .and_then(|l| endpoint.join(&l).ok())
            .map_or("another location".to_string(), |u| url_host(&u));
        d.io.err(&format!(
            "enrollment failed: the server redirected to {where_} \
             (conductor never follows redirects during enrollment)"
        ));
        return 1;
    }
    if status == 401 {
        d.io.err(
            "enrollment token is expired, already used or unknown: create a new one with Add a machine",
        );
        return 1;
    }
    if status == 429 {
        let after = header("retry-after")
            .filter(|a| !a.is_empty())
            .map_or(" later".to_string(), |a| format!(" in {a} s"));
        d.io.err(&format!("too many enrollment attempts; try again{after}"));
        return 1;
    }
    let bytes = res.bytes().await;
    if status != 201 && status != 200 {
        let code = bytes
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string))
            .map_or(String::new(), |c| format!(" ({c})"));
        d.io.err(&format!(
            "enrollment failed: server returned {status}{code}"
        ));
        return 1;
    }
    let Some(parsed) = bytes
        .ok()
        .and_then(|b| serde_json::from_slice::<EnrollResponse>(&b).ok())
    else {
        d.io.err("enrollment failed: the server sent an unexpected response");
        return 1;
    };
    let machine_id = parsed.machine_id.to_string();
    let cred = MachineCredential {
        url: target,
        machine_id: machine_id.clone(),
        credential: parsed.credential.to_string(),
    };
    if let Err(e) = write_credential(&root, &cred, force) {
        d.io.err(&format!(
            "enrolled as {machine_id}, but the credential could not be saved: {e}"
        ));
        return 1;
    }
    d.io.out(&format!(
        "enrolled as {machine_id}; credential saved to {}",
        credential_path(&root).display()
    ));
    0
}

/// `enroll` on this machine: real facts, stdin, and a current-thread runtime for the request.
pub fn run_enroll(argv: &[String], env: &mut Env, io: &mut dyn Output) -> i32 {
    let mut read_stdin = || io::read_to_string(io::stdin());
    let mut d = EnrollDeps {
        env,
        facts: crate::config::machine_facts(),
        os: crate::platform::machine::node_platform().to_string(),
        arch: crate::platform::machine::node_arch().to_string(),
        io,
        read_stdin: &mut read_stdin,
    };
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt.block_on(enroll(argv, &mut d)),
        Err(e) => {
            d.io.err(&format!("cannot start: {e}"));
            1
        }
    }
}

#[cfg(test)]
mod tests;
