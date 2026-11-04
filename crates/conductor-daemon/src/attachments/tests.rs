use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path as AxPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;

use super::*;

// The pure parts first; then `fetch_all` against a loopback axum server, because the HTTP
// download (status, streaming, the credential header) is the boundary under test.

fn att(id: &str, name: &str, mime: &str, bytes: &[u8]) -> AttachmentRef {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": name,
        "mime": mime,
        "size": bytes.len(),
        "sha256": hex::encode(Sha256::digest(bytes)),
    }))
    .unwrap()
}

const ID1: &str = "00000000-0000-4000-8000-0000000a7002";
const ID2: &str = "00000000-0000-4000-8000-0000000a7003";
const ID3: &str = "00000000-0000-4000-8000-0000000a7004";

#[test]
fn safe_names() {
    assert_eq!(safe_name("mockup.png"), "mockup.png");
    assert_eq!(safe_name("../../etc/passwd"), "passwd");
    assert_eq!(safe_name("C:\\Users\\me\\a.png"), "a.png");
    assert_eq!(safe_name(".hidden.png"), "hidden.png");
    assert_eq!(safe_name(".."), "attachment");
    assert_eq!(safe_name(""), "attachment");
    assert_eq!(safe_name("é<1>.gif"), "__1_.gif");
    assert_eq!(safe_name(&"a".repeat(300)).len(), 100);
}

#[test]
fn duplicate_names_get_a_suffix() {
    let mut taken = BTreeSet::new();
    assert_eq!(unique_name("a.png", &mut taken), "a.png");
    assert_eq!(unique_name("a.png", &mut taken), "a-2.png");
    assert_eq!(unique_name("a.png", &mut taken), "a-3.png");
    assert_eq!(unique_name("noext", &mut taken), "noext");
    assert_eq!(unique_name("noext", &mut taken), "noext-2");
}

#[test]
fn http_base_from_the_ws_url() {
    assert_eq!(
        http_base("wss://conductor.example.com/ws/daemon")
            .unwrap()
            .as_str(),
        "https://conductor.example.com/"
    );
    assert_eq!(
        http_base("ws://127.0.0.1:7400/ws/daemon").unwrap().as_str(),
        "http://127.0.0.1:7400/"
    );
    assert!(http_base("ftp://x/").is_none());
    assert!(http_base("not a url").is_none());
}

#[test]
fn prompt_block_lists_paths_videos_and_failures() {
    let d = vec![
        Delivered {
            name: "mock.png".into(),
            mime: "image/png".into(),
            size: 2048,
            fetched: Fetched::New(PathBuf::from("/root/artifacts/s/attachments/mock.png")),
        },
        Delivered {
            name: "repro.mp4".into(),
            mime: "video/mp4".into(),
            size: 1,
            fetched: Fetched::Present(PathBuf::from("/root/artifacts/s/attachments/repro.mp4")),
        },
        Delivered {
            name: "gone.png".into(),
            mime: "image/png".into(),
            size: 1,
            fetched: Fetched::Failed("the server answered HTTP 404".into()),
        },
    ];
    let full = prompt_block(&d, false).unwrap();
    assert!(full.starts_with("## Attachments\n"), "{full}");
    assert!(full.contains(
        "- `/root/artifacts/s/attachments/mock.png` (image, image/png, 2 KB). Open it with the Read tool."
    ));
    assert!(full.contains("(video, video/mp4, 1 KB). You can't watch a video directly"));
    assert!(full.contains(
        "- gone.png (image) could not be downloaded: the server answered HTTP 404. Call ask_user if you need it."
    ));
    // Resumed: only what's new this time (and failures); the agent saw the rest.
    let resumed = prompt_block(&d, true).unwrap();
    assert!(resumed.starts_with("## New attachments\n"));
    assert!(resumed.contains("mock.png"));
    assert!(!resumed.contains("repro.mp4"));
    assert_eq!(prompt_block(&d[1..2], true), None);
    assert_eq!(prompt_block(&[], false), None);
}

#[derive(Default)]
struct Served {
    files: BTreeMap<String, Vec<u8>>,
    auth: Vec<Option<String>>,
}

async fn serve(served: Arc<Mutex<Served>>) -> Url {
    async fn content(
        State(s): State<Arc<Mutex<Served>>>,
        AxPath(id): AxPath<String>,
        headers: HeaderMap,
    ) -> Result<Vec<u8>, StatusCode> {
        let mut s = s.lock().unwrap();
        s.auth.push(
            headers
                .get("authorization")
                .map(|v| v.to_str().unwrap().to_string()),
        );
        s.files.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)
    }
    let app = Router::new()
        .route("/api/daemon/attachments/{id}/content", get(content))
        .with_state(served);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Url::parse(&format!("http://{addr}/")).unwrap()
}

#[tokio::test]
async fn fetches_checks_and_skips_what_is_already_there() {
    let png = b"\x89PNG\r\n\x1a\nbody".to_vec();
    let mp4 = b"\0\0\0\x20ftypisom".to_vec();
    let served = Arc::new(Mutex::new(Served::default()));
    {
        let mut s = served.lock().unwrap();
        s.files.insert(ID1.into(), png.clone());
        s.files.insert(ID2.into(), mp4.clone());
        // ID3 is announced with other bytes than served: the sha256 check refuses it.
        s.files.insert(ID3.into(), b"tampered".to_vec());
    }
    let base = serve(served.clone()).await;
    let tmp = tempfile::tempdir().unwrap();
    let dir = attachments_dir(tmp.path(), "sess");
    let refs = vec![
        att(ID1, "../mock.png", "image/png", &png),
        att(ID2, "repro.mp4", "video/mp4", &mp4),
        att(ID3, "mock.png", "image/png", b"original"),
    ];
    let client = reqwest::Client::new();
    let first = fetch_all(&client, &base, Some("cred"), &refs, &dir).await;
    assert_eq!(first[0].fetched, Fetched::New(dir.join("mock.png")));
    assert_eq!(first[1].fetched, Fetched::New(dir.join("repro.mp4")));
    assert_eq!(first[2].name, "mock-2.png");
    assert_eq!(
        first[2].fetched,
        Fetched::Failed("the download's sha256 doesn't match".into())
    );
    assert_eq!(std::fs::read(dir.join("mock.png")).unwrap(), png);
    // Nothing half-written is left behind.
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(
        served
            .lock()
            .unwrap()
            .auth
            .iter()
            .all(|a| a.as_deref() == Some("Bearer cred"))
    );

    // A second start of the session: present files aren't fetched again.
    served.lock().unwrap().auth.clear();
    let again = fetch_all(&client, &base, None, &refs[..2], &dir).await;
    assert_eq!(again[0].fetched, Fetched::Present(dir.join("mock.png")));
    assert_eq!(again[1].fetched, Fetched::Present(dir.join("repro.mp4")));
    assert!(served.lock().unwrap().auth.is_empty());
}

#[tokio::test]
async fn a_wrong_sha_or_status_is_a_failure_and_leaves_no_file() {
    let served = Arc::new(Mutex::new(Served::default()));
    served
        .lock()
        .unwrap()
        .files
        .insert(ID1.into(), b"12345678".to_vec());
    let base = serve(served).await;
    let tmp = tempfile::tempdir().unwrap();
    let dir = attachments_dir(tmp.path(), "s");
    let client = reqwest::Client::new();
    let mut wrong = att(ID1, "a.png", "image/png", b"abcdefgh");
    let got = fetch_all(&client, &base, None, std::slice::from_ref(&wrong), &dir).await;
    assert_eq!(
        got[0].fetched,
        Fetched::Failed("the download's sha256 doesn't match".into())
    );
    assert!(!dir.join("a.png").exists());
    assert!(!dir.join("a.part").exists());

    wrong = att(ID2, "b.png", "image/png", b"x");
    let missing = fetch_all(&client, &base, None, &[wrong], &dir).await;
    assert_eq!(
        missing[0].fetched,
        Fetched::Failed("the server answered HTTP 404".into())
    );

    let big = att(ID1, "c.png", "image/png", b"123");
    let over = fetch_all(&client, &base, None, &[big], &dir).await;
    assert_eq!(
        over[0].fetched,
        Fetched::Failed("the download is larger than announced".into())
    );
}
