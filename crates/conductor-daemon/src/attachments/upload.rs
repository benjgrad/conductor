//! Agent attachments (06 §Attachments, Rust only): the outcome server's `attach_file` tool hands a
//! path here, and the daemon uploads the file to the orchestrator (POST
//! `/api/daemon/sessions/<session>/attachments`, its machine credential, the raw bytes), which
//! files it on the ticket under the session and its current state. That is how a before/after GIF
//! the agent recorded reaches the human: a file left on the machine's disk never does.
//!
//! The tool is pre-approved (no permission prompt), so what it may read is fenced: the file must
//! resolve (symlinks followed) inside one of the target's `roots` (the session's worktree, the
//! system temp dir and the session's attachment dirs); a capture saved elsewhere is copied in
//! first, which goes through Claude's own permission checks. And only bytes sniffed as PNG, JPEG,
//! GIF, WebP, MP4 or WebM are ever sent, the check the orchestrator repeats: source files, keys or
//! configs can't leave the machine through this tool.

use std::path::{Path, PathBuf};
use std::time::Duration;

use conductor_protocol::{
    ATTACHMENT_CAPTION_HEADER, ATTACHMENT_CAPTION_MAX, ATTACHMENT_FILENAME_HEADER,
    ATTACHMENT_MAX_IMAGE_BYTES, ATTACHMENT_MAX_VIDEO_BYTES, DAEMON_AUTH_HEADER,
    auth::daemon_auth_header_value,
};
use reqwest::Url;

use super::safe_name;

/// How long one upload may take.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// Where a session's agent attachments go. The credential is never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct AttachTarget {
    /// The orchestrator's HTTP origin (`attachments::http_base`).
    pub base: Url,
    /// The machine credential; None in local mode.
    pub credential: Option<String>,
    /// The conductor session id.
    pub session_id: String,
    /// The directories a file may be attached from (see the module doc).
    pub roots: Vec<PathBuf>,
}

impl std::fmt::Debug for AttachTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttachTarget")
            .field("base", &self.base.as_str())
            .field("session_id", &self.session_id)
            .field("roots", &self.roots)
            .finish_non_exhaustive()
    }
}

/// The shared `sniffMime`: the type from the file's first bytes, or None when it isn't one of
/// the attachable types.
pub fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    let at = |off: usize, sig: &[u8]| b.len() >= off + sig.len() && &b[off..off + sig.len()] == sig;
    if at(0, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if at(0, &[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some("image/gif")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if at(4, b"ftyp") {
        Some("video/mp4")
    } else if at(0, &[0x1a, 0x45, 0xdf, 0xa3]) {
        Some("video/webm")
    } else {
        None
    }
}

/// The size limit for one file of `mime`.
pub fn max_bytes(mime: &str) -> usize {
    if mime.starts_with("video/") {
        ATTACHMENT_MAX_VIDEO_BYTES
    } else {
        ATTACHMENT_MAX_IMAGE_BYTES
    }
}

const MB: usize = 1024 * 1024;
const TYPES: &str = "PNG, JPEG, GIF, WebP, MP4 or WebM";

/// A file ready to send: its bytes, sniffed type and safe name.
#[derive(Debug, PartialEq, Eq)]
pub struct Prepared {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub name: String,
}

/// `path` resolved (symlinks followed) when it is inside one of `roots`, else why not.
pub fn resolve_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let real =
        std::fs::canonicalize(path).map_err(|e| format!("can't read `{}`: {e}", path.display()))?;
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| real.starts_with(&r));
    if inside {
        return Ok(real);
    }
    let list: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
    Err(format!(
        "`{}` is outside the directories files can be attached from ({}). Copy it into one of them first",
        path.display(),
        list.join(", ")
    ))
}

/// Read `path` and check it, or say why it can't be attached (the text the agent reads).
pub fn prepare(path: &Path, roots: &[PathBuf]) -> Result<Prepared, String> {
    if !path.is_absolute() {
        return Err(format!(
            "`{}` is not an absolute path; pass the file's full path",
            path.display()
        ));
    }
    let path = &resolve_in_roots(path, roots)?;
    let meta =
        std::fs::metadata(path).map_err(|e| format!("can't read `{}`: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("`{}` is not a regular file", path.display()));
    }
    if meta.len() == 0 {
        return Err(format!("`{}` is empty", path.display()));
    }
    if meta.len() > ATTACHMENT_MAX_VIDEO_BYTES as u64 {
        return Err(format!(
            "`{}` is larger than {} MB",
            path.display(),
            ATTACHMENT_MAX_VIDEO_BYTES / MB
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("can't read `{}`: {e}", path.display()))?;
    let Some(mime) = sniff_mime(&bytes) else {
        return Err(format!(
            "`{}` is not a {TYPES} file (checked from its bytes)",
            path.display()
        ));
    };
    let max = max_bytes(mime);
    if bytes.len() > max {
        return Err(format!("{mime} files are at most {} MB", max / MB));
    }
    let raw = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Prepared {
        bytes,
        mime,
        name: safe_name(&raw),
    })
}

/// JS `encodeURIComponent` (what the orchestrator's `decodeURIComponent` reads).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The caption the server keeps: trimmed, at most ATTACHMENT_CAPTION_MAX characters; None if empty.
pub fn clean_caption(caption: Option<&str>) -> Option<String> {
    let c = caption?.trim();
    (!c.is_empty()).then(|| c.chars().take(ATTACHMENT_CAPTION_MAX).collect())
}

/// The agent-readable text for a refused upload.
fn refusal(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from));
    match (status, message) {
        (404, _) => {
            "the conductor server doesn't take attachments for this session (it may be an older server, or the session has ended)".into()
        }
        (401, _) => "the conductor server refused this machine's credential".into(),
        (_, Some(m)) => format!("the conductor server refused it ({status}): {m}"),
        (_, None) => format!("the conductor server answered HTTP {status}"),
    }
}

/// Upload `path` as an attachment of the target session. Ok: the text for the agent.
pub async fn upload(
    client: &reqwest::Client,
    target: &AttachTarget,
    path: &Path,
    caption: Option<&str>,
) -> Result<String, String> {
    let file = prepare(path, &target.roots)?;
    let url = target
        .base
        .join(&format!(
            "api/daemon/sessions/{}/attachments",
            encode_uri_component(&target.session_id)
        ))
        .map_err(|e| format!("bad URL: {e}"))?;
    let caption = clean_caption(caption);
    let send = || {
        let mut req = client
            .post(url.clone())
            .timeout(UPLOAD_TIMEOUT)
            .header("content-type", "application/octet-stream")
            .header(ATTACHMENT_FILENAME_HEADER, encode_uri_component(&file.name))
            .body(file.bytes.clone());
        if let Some(c) = &caption {
            req = req.header(ATTACHMENT_CAPTION_HEADER, encode_uri_component(c));
        }
        if let Some(c) = &target.credential {
            req = req.header(DAEMON_AUTH_HEADER, daemon_auth_header_value(c));
        }
        req.send()
    };
    // One retry on a network error: the server stores the same bytes of a session once.
    let res = match send().await {
        Ok(r) => r,
        Err(_) => send()
            .await
            .map_err(|e| format!("the upload failed: {e}"))?,
    };
    let status = res.status().as_u16();
    if res.status().is_success() {
        let what = if status == 201 {
            "Attached"
        } else {
            "Already attached"
        };
        return Ok(format!(
            "{what} {} ({}, {} KB) to the ticket; the human sees it on the board.",
            file.name,
            file.mime,
            file.bytes.len().div_ceil(1024)
        ));
    }
    let body = res.text().await.unwrap_or_default();
    Err(refusal(status, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

    #[test]
    fn sniffs_the_attachable_types_only() {
        assert_eq!(sniff_mime(PNG), Some("image/png"));
        assert_eq!(sniff_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_mime(&[0xff, 0xd8, 0xff, 0]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_mime(b"\0\0\0\x18ftypmp42"), Some("video/mp4"));
        assert_eq!(sniff_mime(&[0x1a, 0x45, 0xdf, 0xa3, 1]), Some("video/webm"));
        assert_eq!(sniff_mime(b"<svg xmlns=..."), None);
        assert_eq!(sniff_mime(b"-----BEGIN OPENSSH PRIVATE KEY-----"), None);
        assert_eq!(sniff_mime(b""), None);
    }

    #[test]
    fn prepare_refuses_relative_missing_empty_and_non_media_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            prepare(Path::new("shot.png"), &[])
                .unwrap_err()
                .contains("absolute")
        );
        assert!(
            prepare(&dir.path().join("missing.png"), &[dir.path().to_path_buf()])
                .unwrap_err()
                .contains("can't read")
        );
        assert!(
            prepare(dir.path(), &[dir.path().to_path_buf()])
                .unwrap_err()
                .contains("not a regular file")
        );
        let empty = dir.path().join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(
            prepare(&empty, &[dir.path().to_path_buf()])
                .unwrap_err()
                .contains("empty")
        );
        let text = dir.path().join("secrets.png");
        std::fs::write(&text, b"API_KEY=hunter2").unwrap();
        assert!(
            prepare(&text, &[dir.path().to_path_buf()])
                .unwrap_err()
                .contains("not a PNG, JPEG")
        );
        let big = dir.path().join("big.gif");
        let mut gif = b"GIF89a".to_vec();
        gif.resize(ATTACHMENT_MAX_IMAGE_BYTES + 1, 0);
        std::fs::write(&big, &gif).unwrap();
        assert!(
            prepare(&big, &[dir.path().to_path_buf()])
                .unwrap_err()
                .contains("image/gif files are at most 10 MB")
        );
    }

    #[test]
    fn prepare_reads_a_media_file_under_a_safe_name() {
        let dir = tempfile::tempdir().unwrap();
        // `#` (not `?`): a valid name on Windows too, still not one safe_name keeps.
        let p = dir.path().join("NCNG-2701 case1 before#.png");
        std::fs::write(&p, PNG).unwrap();
        assert_eq!(
            prepare(&p, &[dir.path().to_path_buf()]).unwrap(),
            Prepared {
                bytes: PNG.to_vec(),
                mime: "image/png",
                name: "NCNG-2701 case1 before_.png".into()
            }
        );
    }

    #[test]
    fn only_files_inside_the_roots_are_attached_even_through_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("photo.png");
        std::fs::write(&secret, PNG).unwrap();
        let roots = [root.path().to_path_buf()];
        let err = prepare(&secret, &roots).unwrap_err();
        assert!(err.contains("outside the directories"), "{err}");
        assert!(err.contains("Copy it into one of them first"));
        // Windows without Developer Mode can't make the link; the check is the same there.
        let link = root.path().join("link.png");
        if crate::platform::fs::symlink(&secret, &link).is_ok() {
            assert!(prepare(&link, &roots).unwrap_err().contains("outside"));
        }
        let inside = root.path().join("sub").join("ok.png");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::write(&inside, PNG).unwrap();
        assert_eq!(prepare(&inside, &roots).unwrap().name, "ok.png");
        assert!(prepare(&inside, &[]).is_err());
    }

    #[test]
    fn encodes_like_encode_uri_component_and_cleans_captions() {
        assert_eq!(encode_uri_component("a b/é?.png"), "a%20b%2F%C3%A9%3F.png");
        assert_eq!(encode_uri_component("Before: (1)"), "Before%3A%20(1)");
        assert_eq!(clean_caption(Some("  ")), None);
        assert_eq!(clean_caption(None), None);
        assert_eq!(clean_caption(Some(" after ")).as_deref(), Some("after"));
        assert_eq!(
            clean_caption(Some(&"x".repeat(600))).unwrap().len(),
            ATTACHMENT_CAPTION_MAX
        );
    }

    #[test]
    fn refusals_read_well() {
        assert!(refusal(404, "").contains("older server"));
        assert_eq!(
            refusal(
                400,
                r#"{"error":{"code":"attachment_limit","message":"the agents of a ticket attach at most 20 files"}}"#
            ),
            "the conductor server refused it (400): the agents of a ticket attach at most 20 files"
        );
        assert_eq!(refusal(502, "x"), "the conductor server answered HTTP 502");
    }

    /// What the loopback server saw of one POST.
    #[derive(Debug, Default, Clone)]
    struct Seen {
        path: String,
        auth: Option<String>,
        name: Option<String>,
        caption: Option<String>,
        body: Vec<u8>,
    }

    // The HTTP boundary (headers, credential, status mapping) is what's under test, so a loopback
    // axum server stands in for the orchestrator.
    async fn serve(status: u16, seen: std::sync::Arc<std::sync::Mutex<Vec<Seen>>>) -> Url {
        use axum::http::HeaderMap;
        let app = axum::Router::new().fallback(
            move |uri: axum::http::Uri, headers: HeaderMap, body: axum::body::Bytes| {
                let seen = seen.clone();
                async move {
                    let h = |k: &str| {
                        headers
                            .get(k)
                            .and_then(|v| v.to_str().ok())
                            .map(String::from)
                    };
                    seen.lock().unwrap().push(Seen {
                        path: uri.path().to_string(),
                        auth: h("authorization"),
                        name: h(ATTACHMENT_FILENAME_HEADER),
                        caption: h(ATTACHMENT_CAPTION_HEADER),
                        body: body.to_vec(),
                    });
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        r#"{"error":{"code":"x","message":"nope"}}"#,
                    )
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Url::parse(&format!("http://{addr}/")).unwrap()
    }

    #[tokio::test]
    async fn uploads_the_bytes_with_the_credential_name_and_caption() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("after 1.png");
        std::fs::write(&p, PNG).unwrap();
        let seen = std::sync::Arc::default();
        let target = AttachTarget {
            base: serve(201, std::sync::Arc::clone(&seen)).await,
            credential: Some("secret".into()),
            session_id: "s-1".into(),
            roots: vec![dir.path().to_path_buf()],
        };
        let client = reqwest::Client::new();
        let ok = upload(&client, &target, &p, Some(" After: deletes ")).await;
        assert_eq!(
            ok.unwrap(),
            "Attached after 1.png (image/png, 1 KB) to the ticket; the human sees it on the board."
        );
        let s = seen.lock().unwrap()[0].clone();
        assert_eq!(s.path, "/api/daemon/sessions/s-1/attachments");
        assert_eq!(s.auth.as_deref(), Some("Bearer secret"));
        assert_eq!(s.name.as_deref(), Some("after%201.png"));
        assert_eq!(s.caption.as_deref(), Some("After%3A%20deletes"));
        assert_eq!(s.body, PNG);
        assert!(!format!("{target:?}").contains("secret"));

        // A refused file never reaches the server.
        let txt = dir.path().join("notes.png");
        std::fs::write(&txt, b"hello").unwrap();
        assert!(upload(&client, &target, &txt, None).await.is_err());
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_refusal_is_the_reason_for_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.png");
        std::fs::write(&p, PNG).unwrap();
        for (status, want) in [(404, "older server"), (400, "refused it (400): nope")] {
            let target = AttachTarget {
                base: serve(status, std::sync::Arc::default()).await,
                credential: None,
                session_id: "s".into(),
                roots: vec![dir.path().to_path_buf()],
            };
            let err = upload(&reqwest::Client::new(), &target, &p, None)
                .await
                .unwrap_err();
            assert!(err.contains(want), "{err}");
        }
        let target = AttachTarget {
            base: serve(200, std::sync::Arc::default()).await,
            credential: None,
            session_id: "s".into(),
            roots: vec![dir.path().to_path_buf()],
        };
        assert!(
            upload(&reqwest::Client::new(), &target, &p, None)
                .await
                .unwrap()
                .starts_with("Already attached a.png")
        );
    }
}
