//! `stage` against a local HTTP server serving tarballs built here. The `--version` probe is a
//! fake (it reads the staged "binary" as text) so the cases run the same on every OS; one case
//! runs the real probe on a POSIX shell script.

use super::*;
use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use std::collections::HashMap;
use std::sync::Mutex;

type Served = Arc<Mutex<HashMap<String, Vec<u8>>>>;

async fn download_route(UrlPath(file): UrlPath<String>, State(s): State<Served>) -> Response {
    if file == "redirect.tgz" {
        return (StatusCode::FOUND, [(header::LOCATION, "/downloads/x.tgz")]).into_response();
    }
    match s.lock().unwrap().get(&file) {
        Some(b) => b.clone().into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve(files: Served) -> Url {
    let app = Router::new()
        .route("/downloads/{file}", get(download_route))
        .with_state(files);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Url::parse(&format!("http://{addr}/")).unwrap()
}

/// The fake probe: the "binary" is a text file holding the version it prints.
fn text_probe() -> VersionProbe {
    Arc::new(|exe: PathBuf| {
        Box::pin(async move {
            std::fs::read_to_string(&exe)
                .map(|s| s.trim().to_string())
                .map_err(|e| e.to_string())
        })
    })
}

fn exe_name() -> &'static str {
    if Platform::current().is_windows() {
        "bin/conductor-daemon.exe"
    } else {
        "bin/conductor-daemon"
    }
}

/// An entry with an exact raw name (bypassing tar's own path checks) and type.
fn raw_entry(
    b: &mut tar::Builder<Vec<u8>>,
    name: &[u8],
    ty: tar::EntryType,
    link: &[u8],
    data: &[u8],
) {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(ty);
    h.set_size(data.len() as u64);
    h.set_mode(0o755);
    {
        let old = h.as_old_mut();
        old.name[..name.len()].copy_from_slice(name);
        old.linkname[..link.len()].copy_from_slice(link);
    }
    h.set_cksum();
    b.append(&h, data).unwrap();
}

/// A gzipped tarball of `(name, contents)` regular files plus `extra` raw entries.
fn tgz(files: &[(&str, &str)], extra: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    for (name, body) in files {
        raw_entry(
            &mut b,
            name.as_bytes(),
            tar::EntryType::Regular,
            b"",
            body.as_bytes(),
        );
    }
    extra(&mut b);
    let tar = b.into_inner().unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&tar).unwrap();
    gz.finish().unwrap()
}

fn good(version: &str) -> Vec<u8> {
    tgz(
        &[
            ("VERSION", version),
            (exe_name(), version),
            ("assets/conductor-launch.sh", "#!/bin/sh\n"),
        ],
        |_| {},
    )
}

fn build_for(version: &str, body: &[u8]) -> DaemonBuild {
    DaemonBuild {
        version: version.into(),
        file: format!("conductor-daemon-{version}-x86_64-unknown-linux-gnu.tgz"),
        sha256: hex::encode(Sha256::digest(body)),
        size: body.len() as u64,
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    files: Served,
    base: Url,
}

impl Fixture {
    async fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(daemon_dir(&root)).unwrap();
        let files: Served = Arc::default();
        let base = serve(files.clone()).await;
        Fixture {
            _dir: dir,
            root,
            files,
            base,
        }
    }

    fn put(&self, build: &DaemonBuild, body: Vec<u8>) {
        self.files.lock().unwrap().insert(build.file.clone(), body);
    }

    async fn stage(&self, build: &DaemonBuild) -> Result<PathBuf, UpdateError> {
        stage(&self.root, &self.base, build, &text_probe()).await
    }

    /// Nothing but the version dirs is left in `<root>/daemon`.
    fn entries(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(daemon_dir(&self.root))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    async fn fails(&self, build: &DaemonBuild, body: Vec<u8>) -> UpdateError {
        self.put(build, body);
        let e = self.stage(build).await.unwrap_err();
        assert_eq!(
            self.entries(),
            Vec::<String>::new(),
            "staging left behind: {e}"
        );
        e
    }
}

#[tokio::test]
async fn stages_a_good_build_and_reuses_it() {
    let f = Fixture::new().await;
    let body = good("2.0.0");
    let b = build_for("2.0.0", &body);
    f.put(&b, body);
    let dir = f.stage(&b).await.unwrap();
    assert_eq!(dir, version_dir(&f.root, "2.0.0"));
    assert_eq!(
        std::fs::read_to_string(dir.join("VERSION")).unwrap(),
        "2.0.0"
    );
    assert!(dir.join("assets/conductor-launch.sh").is_file());
    assert_eq!(f.entries(), ["2.0.0"]);
    // Already there and working: no download (the server no longer has it).
    f.files.lock().unwrap().clear();
    assert_eq!(f.stage(&b).await.unwrap(), dir);
}

#[tokio::test]
async fn a_broken_leftover_dir_is_replaced() {
    let f = Fixture::new().await;
    std::fs::create_dir_all(version_dir(&f.root, "2.0.0").join("junk")).unwrap();
    let body = good("2.0.0");
    let b = build_for("2.0.0", &body);
    f.put(&b, body);
    let dir = f.stage(&b).await.unwrap();
    assert!(!dir.join("junk").exists());
    assert!(dir.join("VERSION").is_file());
}

#[tokio::test]
async fn size_and_sha_mismatches_fail_verify() {
    let f = Fixture::new().await;
    let body = good("2.0.0");
    let mut b = build_for("2.0.0", &body);
    b.size += 1;
    let e = f.fails(&b, body.clone()).await;
    assert_eq!(e.stage, UpdateFailedStage::Verify, "{e}");
    let mut b = build_for("2.0.0", &body);
    b.size -= 1;
    let e = f.fails(&b, body.clone()).await;
    assert_eq!(e.stage, UpdateFailedStage::Verify, "{e}");
    let mut b = build_for("2.0.0", &body);
    b.sha256 = "0".repeat(64);
    let e = f.fails(&b, body).await;
    assert_eq!(e.stage, UpdateFailedStage::Verify);
    assert!(e.error.contains("SHA-256"));
}

#[tokio::test]
async fn http_errors_redirects_and_cleartext_fail_download() {
    let f = Fixture::new().await;
    let body = good("2.0.0");
    let b = build_for("2.0.0", &body);
    // Not served: 404.
    let e = f.stage(&b).await.unwrap_err();
    assert_eq!(e.stage, UpdateFailedStage::Download);
    assert!(e.error.contains("404"), "{e}");
    // A redirect is not followed.
    let r = DaemonBuild {
        file: "redirect.tgz".into(),
        ..b.clone()
    };
    assert_eq!(
        f.stage(&r).await.unwrap_err().stage,
        UpdateFailedStage::Download
    );
    let r = DaemonBuild {
        version: "redirect".into(),
        file: "conductor-daemon-redirect.tgz".into(),
        ..b.clone()
    };
    f.files.lock().unwrap().remove(&r.file);
    assert_eq!(
        f.stage(&r).await.unwrap_err().stage,
        UpdateFailedStage::Download
    );
    // http to a host that isn't loopback.
    let e = stage(
        &f.root,
        &Url::parse("http://example.com/").unwrap(),
        &b,
        &text_probe(),
    )
    .await
    .unwrap_err();
    assert_eq!(e.stage, UpdateFailedStage::Download);
    assert!(e.error.contains("not https"));
    // A file name that doesn't name the version.
    let bad = DaemonBuild {
        file: "conductor-daemon-9.9.9.tgz".into(),
        ..b
    };
    assert_eq!(
        f.stage(&bad).await.unwrap_err().stage,
        UpdateFailedStage::Download
    );
    assert_eq!(f.entries(), Vec::<String>::new());
}

#[tokio::test]
async fn the_redirect_route_really_redirects() {
    // The guard on the test above: without `Policy::none` reqwest would follow this.
    let f = Fixture::new().await;
    let res = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(f.base.join("/downloads/redirect.tgz").unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 302);
}

#[tokio::test]
async fn unsafe_entries_fail_unpack_before_anything_is_written() {
    use tar::EntryType as T;
    let f = Fixture::new().await;
    let base = [("VERSION", "2.0.0"), (exe_name(), "2.0.0")];
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "dot-dot",
            tgz(&base, |b| raw_entry(b, b"../evil", T::Regular, b"", b"x")),
        ),
        (
            "nested dot-dot",
            tgz(&base, |b| {
                raw_entry(b, b"bin/../../evil", T::Regular, b"", b"x")
            }),
        ),
        (
            "absolute",
            tgz(&base, |b| raw_entry(b, b"/tmp/evil", T::Regular, b"", b"x")),
        ),
        (
            "drive",
            tgz(&base, |b| raw_entry(b, b"C:evil", T::Regular, b"", b"x")),
        ),
        (
            "backslash",
            tgz(&base, |b| {
                raw_entry(b, b"bin\\..\\..\\evil", T::Regular, b"", b"x")
            }),
        ),
        (
            "symlink out",
            tgz(&base, |b| {
                raw_entry(b, b"bin/l", T::Symlink, b"../../etc", b"")
            }),
        ),
        (
            "absolute symlink",
            tgz(&base, |b| {
                raw_entry(b, b"l", T::Symlink, b"/etc/passwd", b"")
            }),
        ),
        (
            "hardlink out",
            tgz(&base, |b| raw_entry(b, b"h", T::Link, b"../x", b"")),
        ),
        (
            "char device",
            tgz(&base, |b| raw_entry(b, b"dev", T::Char, b"", b"")),
        ),
        (
            "fifo",
            tgz(&base, |b| raw_entry(b, b"fifo", T::Fifo, b"", b"")),
        ),
    ];
    for (what, body) in cases {
        let b = build_for("2.0.0", &body);
        let e = f.fails(&b, body).await;
        assert_eq!(e.stage, UpdateFailedStage::Unpack, "{what}: {e}");
    }
    assert!(!f.root.parent().unwrap().join("evil").exists());
    // A link that stays inside is fine.
    let body = tgz(&base, |b| {
        raw_entry(b, b"bin/l", T::Symlink, b"../VERSION", b"")
    });
    let b = build_for("2.0.0", &body);
    f.put(&b, body);
    if !Platform::current().is_windows() {
        f.stage(&b).await.unwrap();
    }
}

#[tokio::test]
async fn a_missing_binary_or_a_wrong_version_fails_unpack() {
    let f = Fixture::new().await;
    let body = tgz(&[("VERSION", "2.0.0")], |_| {});
    let e = f.fails(&build_for("2.0.0", &body), body).await;
    assert_eq!(e.stage, UpdateFailedStage::Unpack);
    assert!(e.error.contains("no bin/conductor-daemon"), "{e}");
    let body = tgz(&[(exe_name(), "1.9.9")], |_| {});
    let e = f.fails(&build_for("2.0.0", &body), body).await;
    assert_eq!(e.stage, UpdateFailedStage::Unpack);
    assert!(e.error.contains("1.9.9"), "{e}");
    let body = b"not a gzip".to_vec();
    let e = f.fails(&build_for("2.0.0", &body), body).await;
    assert_eq!(e.stage, UpdateFailedStage::Unpack);
}

/// The real probe, on a POSIX shell script that prints the version (it would print `-leaked` if
/// CONDUCTOR_BUILD_SHA were passed through). Windows needs a real exe: skipped there.
#[tokio::test]
async fn the_real_probe_runs_the_binary_without_the_build_sha() {
    if Platform::current().is_windows() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("conductor-daemon");
    std::fs::write(
        &exe,
        "#!/bin/sh\n[ \"$1\" = --version ] || exit 2\necho \"2.0.0${CONDUCTOR_BUILD_SHA:+-leaked}\"\n",
    )
    .unwrap();
    platform::fs::set_executable(&exe).unwrap();
    assert_eq!(run_version_probe()(exe.clone()).await.unwrap(), "2.0.0");
    std::fs::write(&exe, "#!/bin/sh\nexit 3\n").unwrap();
    assert!(
        run_version_probe()(exe)
            .await
            .unwrap_err()
            .contains("exited")
    );
}
