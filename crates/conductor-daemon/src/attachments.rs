//! Ticket attachments (06 §Attachments, Rust only). A `start_session` carries the ticket's
//! attachments (`StartSessionPayload::attachments`, only to a daemon that advertises
//! `ticket_attachments`). Before the spawn the daemon downloads each one with its machine
//! credential (`GET /api/daemon/attachments/:id/content`) into
//! `<root>/artifacts/<session>/attachments/`, outside the worktree, checking the size and the
//! sha256 it was promised. The prompt gets an `## Attachments` block with the absolute paths and
//! Claude gets `--add-dir <that dir>`, so its Read tool can open the images without a permission
//! prompt. A failed download never refuses the start: the block says what is missing.
//!
//! Names are never trusted: [`safe_name`] re-sanitizes the orchestrator's name the same way
//! `sanitizeAttachmentName` (shared) does, and keeps the file inside the directory.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use conductor_protocol::StartSessionPayloadAttachmentsItem as AttachmentRef;
use conductor_protocol::{DAEMON_AUTH_HEADER, auth::daemon_auth_header_value};
use reqwest::Url;
use sha2::{Digest, Sha256};

/// The largest file the daemon accepts (shared `ATTACHMENT_MAX_VIDEO_BYTES`).
pub const ATTACHMENT_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// How long all of a start's downloads may take together.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// `<root>/artifacts/<session>/attachments`.
pub fn attachments_dir(root: &Path, session_id: &str) -> PathBuf {
    root.join("artifacts").join(session_id).join("attachments")
}

/// The orchestrator's HTTP origin from the daemon's WS URL (`wss://h/ws/daemon` → `https://h/`).
pub fn http_base(orchestrator_url: &str) -> Option<Url> {
    let mut u = Url::parse(orchestrator_url).ok()?;
    let scheme = match u.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    u.set_scheme(scheme).ok()?;
    u.set_path("/");
    u.set_query(None);
    u.set_fragment(None);
    Some(u)
}

/// A file name safe to create in the attachments dir: the basename, characters outside
/// `[A-Za-z0-9._ -]` → `_`, no leading dots or spaces, at most 100 characters; `attachment` when
/// nothing is left.
pub fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mapped: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = mapped.trim_start_matches(['.', ' ']).trim_end();
    let mut name: String = trimmed.chars().take(100).collect();
    name = name.trim_end().to_string();
    if name.is_empty() || name == "." || name == ".." {
        "attachment".to_string()
    } else {
        name
    }
}

/// `name`, or `stem-2.ext`, `stem-3.ext`… when an earlier attachment of this start took it.
fn unique_name(name: &str, taken: &mut BTreeSet<String>) -> String {
    if taken.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2.. {
        let candidate = format!("{stem}-{n}{ext}");
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

/// What happened to one attachment.
#[derive(Debug, Clone, PartialEq)]
pub enum Fetched {
    /// Downloaded now.
    New(PathBuf),
    /// Already in the dir with the right sha256 (an earlier start of this session).
    Present(PathBuf),
    /// Not available; the reason is for the prompt.
    Failed(String),
}

/// One attachment and what became of it.
#[derive(Debug, Clone, PartialEq)]
pub struct Delivered {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub fetched: Fetched,
}

fn sha256_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(hex::encode(Sha256::digest(&bytes)))
}

/// Download one attachment to `dest` (via a temp file in the same dir), or say why not.
async fn fetch_one(
    client: &reqwest::Client,
    url: Url,
    credential: Option<&str>,
    a: &AttachmentRef,
    dest: &Path,
) -> Result<(), String> {
    let want = a.size.get();
    if want > ATTACHMENT_MAX_BYTES {
        return Err(format!(
            "larger than {} MB",
            ATTACHMENT_MAX_BYTES / 1024 / 1024
        ));
    }
    let mut req = client.get(url);
    if let Some(c) = credential {
        req = req.header(DAEMON_AUTH_HEADER, daemon_auth_header_value(c));
    }
    let mut res = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "the server answered HTTP {}",
            res.status().as_u16()
        ));
    }
    let mut hasher = Sha256::new();
    let mut body: Vec<u8> = Vec::with_capacity(usize::try_from(want).unwrap_or(0));
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("download failed: {e}"))?
    {
        if (body.len() + chunk.len()) as u64 > want {
            return Err("the download is larger than announced".into());
        }
        hasher.update(&chunk);
        body.extend_from_slice(&chunk);
    }
    if body.len() as u64 != want {
        return Err("the download is shorter than announced".into());
    }
    if hex::encode(hasher.finalize()) != a.sha256.as_str() {
        return Err("the download's sha256 doesn't match".into());
    }
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, &body).map_err(|e| format!("could not save it: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not save it: {e}")
    })
}

/// Download `refs` into `dir` (created if needed). Never fails as a whole: each attachment says
/// what happened to it, in order.
pub async fn fetch_all(
    client: &reqwest::Client,
    base: &Url,
    credential: Option<&str>,
    refs: &[AttachmentRef],
    dir: &Path,
) -> Vec<Delivered> {
    let mut taken = BTreeSet::new();
    let made = std::fs::create_dir_all(dir).map_err(|e| e.to_string());
    let mut out = Vec::with_capacity(refs.len());
    for a in refs {
        let name = unique_name(&safe_name(a.name.as_str()), &mut taken);
        let dest = dir.join(&name);
        let fetched = if let Err(e) = &made {
            Fetched::Failed(format!("could not create the attachments directory: {e}"))
        } else if std::fs::symlink_metadata(&dest).is_ok_and(|m| m.is_file())
            && sha256_file(&dest).as_deref() == Some(a.sha256.as_str())
        {
            Fetched::Present(dest)
        } else {
            match base.join(&format!("api/daemon/attachments/{}/content", a.id)) {
                Err(e) => Fetched::Failed(format!("bad URL: {e}")),
                Ok(url) => {
                    // A stale or tampered file (or a symlink) at the name is replaced.
                    let _ = std::fs::remove_file(&dest);
                    match fetch_one(client, url, credential, a, &dest).await {
                        Ok(()) => Fetched::New(dest),
                        Err(e) => Fetched::Failed(e),
                    }
                }
            }
        };
        out.push(Delivered {
            name,
            mime: a.mime.as_str().to_string(),
            size: a.size.get(),
            fetched,
        });
    }
    out
}

fn kind(mime: &str) -> &'static str {
    if mime.starts_with("video/") {
        "video"
    } else {
        "image"
    }
}

/// The prompt block. `only_new`: on a resumed conversation, only what was downloaded now (the
/// agent already saw the rest); None when there is nothing to say.
pub fn prompt_block(delivered: &[Delivered], only_new: bool) -> Option<String> {
    let lines: Vec<String> = delivered
        .iter()
        .filter(|d| !only_new || !matches!(d.fetched, Fetched::Present(_)))
        .map(|d| match &d.fetched {
            Fetched::New(p) | Fetched::Present(p) => {
                let hint = if kind(&d.mime) == "video" {
                    " You can't watch a video directly; extract frames with ffmpeg if you need to see it."
                } else {
                    " Open it with the Read tool."
                };
                format!(
                    "- `{}` ({}, {}, {} KB).{hint}",
                    p.display(),
                    kind(&d.mime),
                    d.mime,
                    d.size.div_ceil(1024)
                )
            }
            Fetched::Failed(why) => format!(
                "- {} ({}) could not be downloaded: {why}. Call ask_user if you need it.",
                d.name,
                kind(&d.mime)
            ),
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    let head = if only_new {
        "## New attachments\n\nThe human attached more files to the ticket since you last saw it:"
    } else {
        "## Attachments\n\nThe human attached these files to the ticket. Look at them before you start:"
    };
    Some(format!("{head}\n{}", lines.join("\n")))
}

#[cfg(test)]
mod tests;
