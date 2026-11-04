//! Port of `commands/enroll.test.ts` (M2-T04 acceptance): `enroll` against a stub HTTP server on
//! loopback (axum). A real socket on purpose: the redirect, status and connection-refused handling
//! are reqwest's behaviour at that boundary.

use super::*;
use crate::commands::CapturedOutput;
use crate::credential::load_credential;
use crate::platform::fs::{posix_mode, symlink};
use crate::platform::{
    AclKind, AssertOwnerOnlyOptions, Platform, assert_owner_only, mkdir_private,
};
use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Response, Uri};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const CREDENTIAL: &str = "cred-0123456789abcdef-secret";
const TOKEN: &str = "tok-one-time-abcdef";

/// 0600 file / 0700 dir on POSIX; an owner-only DACL on Windows (ADR-0024 §3).
fn expect_private(path: &Path, kind: AclKind) {
    if Platform::current().is_windows() {
        assert_owner_only(path, AssertOwnerOnlyOptions::new(kind)).unwrap();
    } else {
        let want = if kind == AclKind::File { 0o600 } else { 0o700 };
        assert_eq!(posix_mode(path).unwrap() & 0o777, want);
    }
}

#[derive(Debug, Clone)]
struct Req {
    method: String,
    url: String,
    body: String,
}

/// status, headers, body.
type Reply = (u16, Vec<(&'static str, String)>, String);

#[derive(Clone)]
struct Stub {
    requests: Arc<Mutex<Vec<Req>>>,
    reply: Arc<Mutex<Reply>>,
}

async fn handle(State(s): State<Stub>, method: Method, uri: Uri, body: String) -> Response<Body> {
    s.requests.lock().unwrap().push(Req {
        method: method.to_string(),
        url: uri.to_string(),
        body,
    });
    let (status, headers, body) = s.reply.lock().unwrap().clone();
    let mut b = Response::builder().status(status);
    for (k, v) in headers {
        b = b.header(k, v);
    }
    b.body(Body::from(body)).unwrap()
}

/// A loopback HTTP server; returns its base URL.
async fn serve(stub: Stub) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new().fallback(handle).with_state(stub);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

fn created(machine_id: &str, credential: &str) -> Reply {
    (
        201,
        vec![("content-type", "application/json".into())],
        serde_json::json!({ "machine_id": machine_id, "credential": credential }).to_string(),
    )
}

struct Fx {
    _tmp: tempfile::TempDir,
    tmp: PathBuf,
    base: String,
    stub: Stub,
    io: CapturedOutput,
}

impl Fx {
    async fn new() -> Self {
        let t = tempfile::tempdir().unwrap();
        let tmp = crate::claude::transcript::realpath(t.path()).unwrap();
        // Windows: a private root needs a private parent.
        mkdir_private(&tmp).unwrap();
        let stub = Stub {
            requests: Arc::default(),
            reply: Arc::new(Mutex::new(created("m-123", CREDENTIAL))),
        };
        let base = serve(stub.clone()).await;
        Fx {
            _tmp: t,
            tmp,
            base,
            stub,
            io: CapturedOutput::default(),
        }
    }

    fn root(&self) -> PathBuf {
        self.tmp.join("root")
    }

    fn reply(&self, r: Reply) {
        *self.stub.reply.lock().unwrap() = r;
    }

    fn requests(&self) -> Vec<Req> {
        self.stub.requests.lock().unwrap().clone()
    }

    fn sent_token(&self) -> Option<String> {
        let r = self.requests();
        let v: serde_json::Value = serde_json::from_str(&r.first()?.body).ok()?;
        v["token"].as_str().map(str::to_string)
    }

    /// Run `enroll` with `CONDUCTOR_ROOT` = `root` plus `extra`; returns the code and the env after.
    async fn run_env(
        &mut self,
        args: &[&str],
        root: &Path,
        extra: &[(&str, &str)],
        stdin: Option<&str>,
    ) -> (i32, Env) {
        let mut env: Env = [(
            "CONDUCTOR_ROOT".to_string(),
            root.to_string_lossy().into_owned(),
        )]
        .into();
        for (k, v) in extra {
            env.insert(k.to_string(), v.to_string());
        }
        let stdin = stdin.map(str::to_string);
        let mut read_stdin = move || match &stdin {
            Some(s) => Ok(s.clone()),
            None => Err(io::Error::other("no stdin in this test")),
        };
        let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let mut d = EnrollDeps {
            env: &mut env,
            facts: MachineFacts {
                cpu_total: 4,
                mem_total_mb: 8192,
                hostname: "test-host".into(),
                home: self.tmp.clone(),
            },
            os: "linux".into(),
            arch: "x64".into(),
            io: &mut self.io,
            read_stdin: &mut read_stdin,
        };
        let code = enroll(&argv, &mut d).await;
        (code, env)
    }

    async fn run(&mut self, args: &[&str]) -> i32 {
        let root = self.root();
        self.run_env(args, &root, &[], None).await.0
    }

    fn no_secrets(&self) {
        let all = self.io.all();
        assert!(!all.contains(CREDENTIAL), "{all}");
        assert!(!all.contains(TOKEN), "{all}");
    }

    fn err(&self) -> String {
        self.io.err.join("\n")
    }
}

// ---------------------------------------------------------------- conductor-daemon enroll

#[tokio::test]
async fn posts_the_token_and_writes_machine_json_0600_in_a_0700_root() {
    let mut f = Fx::new().await;
    let root = f.root();
    let base = f.base.clone();
    let url = format!("{base}/");
    let (code, _) = f
        .run_env(
            &["--url", &url, "--token", TOKEN],
            &root,
            &[("CONDUCTOR_BUILD_SHA", "abc")],
            None,
        )
        .await;
    assert_eq!(code, 0, "{}", f.err());
    let reqs = f.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].method, "POST");
    assert_eq!(reqs[0].url, api_paths::MACHINES_ENROLL);
    let body: EnrollRequest = serde_json::from_str(&reqs[0].body).unwrap();
    assert_eq!(&*body.token, TOKEN);
    assert_eq!(&*body.hostname, "test-host");
    assert_eq!(&*body.os, "linux");
    assert_eq!(&*body.arch, "x64");
    assert_eq!(
        &*body.daemon_version,
        &format!("{}+abc", daemon_version(&Env::new()))
    );

    let file = root.join("machine.json");
    expect_private(&file, AclKind::File);
    expect_private(&root, AclKind::Dir);
    let want = MachineCredential {
        url: base.clone(),
        machine_id: "m-123".into(),
        credential: CREDENTIAL.into(),
    };
    let on_disk: MachineCredential =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(on_disk, want);
    assert_eq!(load_credential(&root).unwrap(), Some(want));
    assert!(f.io.out.join("\n").contains("enrolled as m-123"));
    f.no_secrets();
}

#[tokio::test]
async fn a_401_leaves_no_file_and_says_the_token_is_expired_or_used() {
    let mut f = Fx::new().await;
    f.reply((
        401,
        vec![("content-type", "application/json".into())],
        r#"{"code":"unauthorized","message":"nope"}"#.into(),
    ));
    let base = f.base.clone();
    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 1);
    assert!(!f.root().join("machine.json").exists());
    assert!(f.err().contains("expired, already used or unknown"));
    f.no_secrets();
}

#[tokio::test]
async fn refuses_an_existing_file_without_force_and_replaces_it_with_force() {
    let mut f = Fx::new().await;
    let base = f.base.clone();
    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 0);
    let file = f.root().join("machine.json");
    let before = std::fs::read_to_string(&file).unwrap();
    f.reply(created("m-456", &format!("{CREDENTIAL}-2")));

    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 1);
    assert_eq!(f.requests().len(), 1);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
    let err = f.err();
    assert!(
        err.contains("already exists") && err.contains("--force"),
        "{err}"
    );

    assert_eq!(
        f.run(&["--url", &base, "--token", TOKEN, "--force"]).await,
        0
    );
    assert_eq!(f.requests().len(), 2);
    assert_eq!(
        load_credential(&f.root()).unwrap().unwrap().machine_id,
        "m-456"
    );
    expect_private(&file, AclKind::File);
    f.no_secrets();
}

#[tokio::test]
async fn refuses_a_symlinked_root_without_sending_a_request() {
    let mut f = Fx::new().await;
    let real = f.tmp.join("real");
    mkdir_private(&real).unwrap();
    let root = f.root();
    if symlink(&real, &root).is_err() {
        // Windows without Developer Mode can't make one; the refusal is tested elsewhere.
        assert!(Platform::current().is_windows());
        return;
    }
    let base = f.base.clone();
    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 1);
    assert!(f.requests().is_empty());
    assert!(!real.join("machine.json").exists());
    assert!(f.err().to_lowercase().contains("symlink"), "{}", f.err());
}

#[tokio::test]
async fn refuses_a_symlinked_machine_json_even_with_force() {
    let mut f = Fx::new().await;
    let root = f.root();
    mkdir_private(&root).unwrap();
    let target = f.tmp.join("elsewhere.json");
    std::fs::write(&target, "{}").unwrap();
    if symlink(&target, &root.join("machine.json")).is_err() {
        assert!(Platform::current().is_windows());
        return;
    }
    let base = f.base.clone();
    assert_eq!(
        f.run(&["--url", &base, "--token", TOKEN, "--force"]).await,
        1
    );
    assert!(f.requests().is_empty());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
}

#[tokio::test]
async fn a_429_says_to_retry_later() {
    let mut f = Fx::new().await;
    f.reply((
        429,
        vec![
            ("content-type", "application/json".into()),
            ("retry-after", "42".into()),
        ],
        r#"{"code":"rate_limited","message":"slow down"}"#.into(),
    ));
    let base = f.base.clone();
    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 1);
    assert!(
        f.err()
            .contains("too many enrollment attempts; try again in 42 s")
    );
    assert!(!f.root().join("machine.json").exists());
}

#[tokio::test]
async fn a_network_failure_says_the_server_cannot_be_reached() {
    let mut f = Fx::new().await;
    // A port nothing listens on: bind one, then close it.
    let closed = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        format!("http://{}", l.local_addr().unwrap())
    };
    assert_eq!(f.run(&["--url", &closed, "--token", TOKEN]).await, 1);
    assert!(
        f.err()
            .contains(&format!("cannot reach {closed}: ECONNREFUSED")),
        "{}",
        f.err()
    );
    f.no_secrets();
}

#[tokio::test]
async fn another_status_names_it_and_its_error_code() {
    let mut f = Fx::new().await;
    f.reply((
        500,
        vec![("content-type", "application/json".into())],
        r#"{"code":"internal","message":"boom"}"#.into(),
    ));
    let base = f.base.clone();
    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 1);
    assert!(f.err().contains("server returned 500 (internal)"));
}

#[tokio::test]
async fn never_follows_a_redirect_the_target_gets_no_request_and_no_file_is_written() {
    let mut f = Fx::new().await;
    let target = Stub {
        requests: Arc::default(),
        reply: Arc::new(Mutex::new(created("m-evil", "evil-cred"))),
    };
    let target_base = serve(target.clone()).await;
    let target_host = target_base.trim_start_matches("http://").to_string();
    f.reply((
        307,
        vec![(
            "location",
            format!("{target_base}{}", api_paths::MACHINES_ENROLL),
        )],
        String::new(),
    ));
    let base = f.base.clone();
    assert_eq!(f.run(&["--url", &base, "--token", TOKEN]).await, 1);
    assert!(target.requests.lock().unwrap().is_empty());
    assert_eq!(f.requests().len(), 1);
    assert!(!f.root().join("machine.json").exists());
    assert!(f.err().contains(&format!(
        "enrollment failed: the server redirected to {target_host} \
         (conductor never follows redirects during enrollment)"
    )));
    f.no_secrets();
}

#[tokio::test]
async fn an_empty_or_over_long_token_is_a_usage_error_naming_the_flag() {
    let mut f = Fx::new().await;
    let base = f.base.clone();
    let long = "x".repeat(513);
    assert_eq!(f.run(&["--url", &base, "--token", &long]).await, 2);
    assert_eq!(f.run(&["--url", &base, "--token="]).await, 2);
    assert!(f.requests().is_empty());
    let msg = f.err();
    assert!(msg.contains("--token is not a valid enrollment token"));
    assert!(!msg.contains("ConversionError"));
}

#[tokio::test]
async fn refuses_plain_http_to_a_non_loopback_host_and_missing_options() {
    let mut f = Fx::new().await;
    let base = f.base.clone();
    assert_eq!(
        f.run(&["--url", "http://conductor.example.com", "--token", TOKEN])
            .await,
        2
    );
    assert_eq!(f.run(&["--url", &base]).await, 2);
    assert_eq!(
        f.run(&["--url", &base, "--token", TOKEN, "--bogus"]).await,
        2
    );
    assert_eq!(f.run(&["--token", TOKEN]).await, 2);
    assert!(f.requests().is_empty());
    let err = f.err();
    assert!(err.contains("must be https"), "{err}");
    assert!(err.contains("usage: conductor-daemon enroll"), "{err}");
    assert!(err.contains("missing --url"), "{err}");
}

// ---------------------------------------------------------------- token sources (TD-117)

fn ps_warnings(f: &Fx) -> Vec<String> {
    f.io.err
        .iter()
        .filter(|l| l.contains("visible to other users (ps)"))
        .cloned()
        .collect()
}

#[tokio::test]
async fn takes_the_token_from_conductor_enroll_token_and_removes_it_from_the_environment() {
    let mut f = Fx::new().await;
    let (root, base) = (f.root(), f.base.clone());
    let (code, env) = f
        .run_env(&["--url", &base], &root, &[(ENROLL_TOKEN_ENV, TOKEN)], None)
        .await;
    assert_eq!(code, 0, "{}", f.err());
    assert_eq!(f.sent_token().as_deref(), Some(TOKEN));
    assert!(!env.contains_key(ENROLL_TOKEN_ENV));
    assert!(ps_warnings(&f).is_empty());
    assert_eq!(load_credential(&root).unwrap().unwrap().machine_id, "m-123");
    f.no_secrets();
}

#[tokio::test]
async fn token_flag_wins_over_the_environment_which_is_still_removed() {
    let mut f = Fx::new().await;
    let (root, base) = (f.root(), f.base.clone());
    let (code, env) = f
        .run_env(
            &["--url", &base, "--token", TOKEN],
            &root,
            &[(ENROLL_TOKEN_ENV, "env-token-unused")],
            None,
        )
        .await;
    assert_eq!(code, 0);
    assert_eq!(f.sent_token().as_deref(), Some(TOKEN));
    assert!(!env.contains_key(ENROLL_TOKEN_ENV));
    // Still works, with a warning that never repeats the token.
    let w = ps_warnings(&f);
    assert_eq!(w.len(), 1);
    assert!(w[0].contains("CONDUCTOR_ENROLL_TOKEN=<token>"));
    f.no_secrets();
}

#[tokio::test]
async fn token_dash_reads_the_first_line_of_stdin() {
    let mut f = Fx::new().await;
    let (root, base) = (f.root(), f.base.clone());
    let stdin = format!("{TOKEN}\r\nrest\n");
    let (code, _) = f
        .run_env(&["--url", &base, "--token", "-"], &root, &[], Some(&stdin))
        .await;
    assert_eq!(code, 0, "{}", f.err());
    assert_eq!(f.sent_token().as_deref(), Some(TOKEN));
    assert!(ps_warnings(&f).is_empty());
    f.no_secrets();
}

#[tokio::test]
async fn an_empty_or_over_long_token_from_stdin_or_the_environment_is_the_same_usage_error() {
    let mut f = Fx::new().await;
    let (root, base) = (f.root(), f.base.clone());
    let long = "x".repeat(513);
    let dash = ["--url", base.as_str(), "--token", "-"];
    assert_eq!(f.run_env(&dash, &root, &[], Some("\n")).await.0, 2);
    assert_eq!(f.run_env(&dash, &root, &[], Some(&long)).await.0, 2);
    assert_eq!(
        f.run_env(&["--url", &base], &root, &[(ENROLL_TOKEN_ENV, &long)], None)
            .await
            .0,
        2
    );
    assert!(f.requests().is_empty());
    assert_eq!(
        f.io.err
            .iter()
            .filter(|l| l.contains("--token is not a valid enrollment token"))
            .count(),
        3
    );
}

#[tokio::test]
async fn no_token_anywhere_is_a_usage_error_naming_both_sources() {
    let mut f = Fx::new().await;
    let (root, base) = (f.root(), f.base.clone());
    let (code, _) = f
        .run_env(&["--url", &base], &root, &[(ENROLL_TOKEN_ENV, "")], None)
        .await;
    assert_eq!(code, 2);
    assert!(f.requests().is_empty());
    let err = f.err();
    assert!(err.contains("missing --token (or CONDUCTOR_ENROLL_TOKEN)"));
    assert!(err.contains("usage: conductor-daemon enroll"));
}

// ---------------------------------------------------------------- enrollUrl

#[test]
fn enroll_url_keeps_https_and_loopback_http_without_a_trailing_slash() {
    assert_eq!(
        enroll_url("https://conductor.example.com/").unwrap(),
        "https://conductor.example.com"
    );
    assert_eq!(
        enroll_url("http://localhost:8080").unwrap(),
        "http://localhost:8080"
    );
    assert_eq!(
        enroll_url("http://[::1]:8080/").unwrap(),
        "http://[::1]:8080"
    );
    assert_eq!(
        enroll_url("https://c.example.com/sub/").unwrap(),
        "https://c.example.com/sub"
    );
    assert!(enroll_url("ftp://x").is_err());
    assert!(enroll_url("not a url").is_err());
    assert_eq!(
        enroll_url("http://conductor.example.com:81").unwrap_err(),
        "--url must be https:// (got http://conductor.example.com:81)"
    );
}
