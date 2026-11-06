//! ADR-0021 §2.1 "Stage": fetch the announced build in the background, check it, unpack it and
//! make sure it runs, then put it at `<root>/daemon/<version>`. Work goes on meanwhile; any
//! failure removes the staging dir and is reported with the stage it failed at.
//!
//! - **download**: the build is fetched from `<orchestrator>/downloads/<file>`, over https (plain
//!   http only to a loopback host, `is_secure_or_loopback`), with no redirects followed: the
//!   same trust rules as `install.sh` and `enroll`.
//! - **verify**: exactly `size` bytes with the announced SHA-256.
//! - **unpack**: every entry is checked before anything is written (no absolute path, no `..`, no
//!   drive or `\`, no link leaving the archive, no device or fifo), `bin/conductor-daemon[.exe]`
//!   must exist, and `<it> --version` must print `version`.

use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use conductor_protocol::UpdateFailedStage;
use reqwest::Url;
use sha2::{Digest, Sha256};

use super::contract::DaemonBuild;
use super::layout::{STAGING_PREFIX, daemon_dir, version_dir};
use crate::credential::is_secure_or_loopback;
use crate::platform::{self, CliOptions, Platform, exec_file_cli};

/// How long `<staged binary> --version` may take.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the whole download may take.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// An update step that failed, and where (`alert update_failed.stage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    pub stage: UpdateFailedStage,
    pub error: String,
}

impl UpdateError {
    pub fn new(stage: UpdateFailedStage, error: impl Into<String>) -> Self {
        UpdateError {
            stage,
            error: error.into(),
        }
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", super::stage_name(self.stage), self.error)
    }
}

fn download(e: impl Into<String>) -> UpdateError {
    UpdateError::new(UpdateFailedStage::Download, e)
}
fn verify(e: impl Into<String>) -> UpdateError {
    UpdateError::new(UpdateFailedStage::Verify, e)
}
fn unpack(e: impl Into<String>) -> UpdateError {
    UpdateError::new(UpdateFailedStage::Unpack, e)
}

/// `<dir>/bin/conductor-daemon` (`.exe` on Windows).
pub fn daemon_exe(dir: &Path) -> PathBuf {
    let name = if Platform::current().is_windows() {
        "conductor-daemon.exe"
    } else {
        "conductor-daemon"
    };
    dir.join("bin").join(name)
}

/// What a staged binary says its version is (`--version`, trimmed), or why it couldn't say.
pub type VersionProbe = Arc<
    dyn Fn(PathBuf) -> futures_util::future::BoxFuture<'static, Result<String, String>>
        + Send
        + Sync,
>;

/// The real probe: run `<exe> --version` with this process's environment minus
/// `CONDUCTOR_BUILD_SHA` (which would override the sha baked into the new binary).
pub fn run_version_probe() -> VersionProbe {
    Arc::new(|exe: PathBuf| {
        Box::pin(async move {
            let mut env = crate::platform::spawn::process_env();
            env.retain(|(k, _)| !k.eq_ignore_ascii_case("CONDUCTOR_BUILD_SHA"));
            let opts = CliOptions {
                env: Some(env),
                timeout: Some(VERSION_TIMEOUT),
                ..CliOptions::default()
            };
            let bin = exe.to_string_lossy().into_owned();
            match exec_file_cli(&bin, &["--version".to_string()], opts).await {
                Ok(out) if out.timed_out => Err("--version timed out".into()),
                Ok(out) if out.output.status.success() => {
                    Ok(String::from_utf8_lossy(&out.output.stdout)
                        .trim()
                        .to_string())
                }
                Ok(out) => Err(format!("--version exited {}", out.output.status)),
                Err(e) => Err(format!("cannot run it: {e}")),
            }
        })
    })
}

/// Removes the staging dir when dropped (every failure path, and a cancelled task).
struct StagingDir(PathBuf);

impl Drop for StagingDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Stage `build` from the orchestrator at `base` (its HTTP origin) into `<root>/daemon/<version>`
/// and return that dir. An existing, working `<version>` dir is reused without a download.
pub async fn stage(
    root: &Path,
    base: &Url,
    build: &DaemonBuild,
    probe: &VersionProbe,
) -> Result<PathBuf, UpdateError> {
    if let Some(p) = build.problem() {
        return Err(download(p));
    }
    if !matches!(base.scheme(), "http" | "https") || !is_secure_or_loopback(base) {
        return Err(download(format!(
            "{base} is not https (plain http is allowed only to a loopback host)"
        )));
    }
    let dest = version_dir(root, &build.version);
    if dest.is_dir() && check_version(&dest, build, probe).await.is_ok() {
        return Ok(dest);
    }
    let staging = daemon_dir(root).join(format!(
        "{STAGING_PREFIX}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    std::fs::create_dir_all(&staging)
        .map_err(|e| download(format!("cannot create {}: {e}", staging.display())))?;
    let guard = StagingDir(staging.clone());
    let tgz = staging.join(&build.file);
    fetch(base, build, &tgz).await?;
    let pkg = staging.join("pkg");
    let (tgz2, pkg2) = (tgz.clone(), pkg.clone());
    tokio::task::spawn_blocking(move || unpack_checked(&tgz2, &pkg2))
        .await
        .map_err(|e| unpack(e.to_string()))??;
    check_version(&pkg, build, probe).await?;
    // A leftover dir that failed the check above is replaced.
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| unpack(format!("cannot replace {}: {e}", dest.display())))?;
    }
    rename_retrying(&pkg, &dest)
        .map_err(|e| unpack(format!("cannot move it to {}: {e}", dest.display())))?;
    drop(guard);
    Ok(dest)
}

/// Windows: an antivirus scan can hold a just-written file for a moment; retry the rename.
fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    let mut last = None;
    for i in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if platform::fs::is_held_open(&e) && i < 4 => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

async fn check_version(
    dir: &Path,
    build: &DaemonBuild,
    probe: &VersionProbe,
) -> Result<(), UpdateError> {
    let exe = daemon_exe(dir);
    if !exe.is_file() {
        return Err(unpack(format!(
            "{} has no bin/conductor-daemon",
            build.file
        )));
    }
    let _ = platform::fs::set_executable(&exe);
    let got = probe(exe).await.map_err(unpack)?;
    if got != build.version {
        return Err(unpack(format!(
            "its --version says {got:?}, not {:?}",
            build.version
        )));
    }
    Ok(())
}

/// Download to `dest`: HTTP 200, no redirects, exactly `size` bytes, the announced SHA-256.
async fn fetch(base: &Url, build: &DaemonBuild, dest: &Path) -> Result<(), UpdateError> {
    let url = base
        .join(&conductor_protocol::api_paths::daemon_download(&build.file))
        .map_err(|e| download(e.to_string()))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| download(e.to_string()))?;
    let mut res = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| download(format!("GET {url}: {e}")))?;
    if res.status() != reqwest::StatusCode::OK {
        return Err(download(format!(
            "GET {url}: HTTP {}",
            res.status().as_u16()
        )));
    }
    let mut file = std::fs::File::create(dest)
        .map_err(|e| download(format!("cannot write {}: {e}", dest.display())))?;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| download(format!("download failed: {e}")))?
    {
        got += chunk.len() as u64;
        if got > build.size {
            return Err(verify(format!(
                "larger than the announced {} bytes",
                build.size
            )));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| download(format!("cannot write {}: {e}", dest.display())))?;
    }
    file.flush().map_err(|e| download(e.to_string()))?;
    if got != build.size {
        return Err(verify(format!(
            "{got} bytes, not the announced {}",
            build.size
        )));
    }
    let sha = hex::encode(hasher.finalize());
    if sha != build.sha256 {
        return Err(verify(format!(
            "SHA-256 {sha} does not match the announced {}",
            build.sha256
        )));
    }
    Ok(())
}

/// A relative path inside the archive, as plain components; Err names the problem.
fn safe_rel(raw: &[u8]) -> Result<PathBuf, String> {
    let s = String::from_utf8(raw.to_vec()).map_err(|_| "a non-UTF-8 entry name".to_string())?;
    if s.contains('\\') || s.contains(':') {
        return Err(format!("unsafe entry {s:?}"));
    }
    let mut out = PathBuf::new();
    for c in Path::new(&s).components() {
        match c {
            Component::Normal(n) => out.push(n),
            Component::CurDir => {}
            _ => return Err(format!("unsafe entry {s:?}")),
        }
    }
    Ok(out)
}

/// Does `target`, relative to the dir holding `entry`, stay inside the archive?
fn link_stays_inside(entry: &Path, target: &[u8]) -> bool {
    let Ok(t) = std::str::from_utf8(target) else {
        return false;
    };
    if t.contains('\\') || t.contains(':') || t.starts_with('/') {
        return false;
    }
    let mut depth = entry.components().count() as i64 - 1;
    for c in Path::new(t).components() {
        match c {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

fn open_archive(tgz: &Path) -> Result<tar::Archive<impl Read>, UpdateError> {
    let f = std::fs::File::open(tgz).map_err(|e| unpack(e.to_string()))?;
    Ok(tar::Archive::new(flate2::read::GzDecoder::new(f)))
}

/// Check every entry of `tgz`, then (only if all pass) unpack it into `dest`.
pub fn unpack_checked(tgz: &Path, dest: &Path) -> Result<(), UpdateError> {
    use tar::EntryType as T;
    let bad = |e: io::Error| unpack(format!("not a valid .tgz: {e}"));
    let mut ar = open_archive(tgz)?;
    for entry in ar.entries().map_err(bad)? {
        let entry = entry.map_err(bad)?;
        let raw = entry.path_bytes().into_owned();
        let rel = safe_rel(&raw).map_err(unpack)?;
        match entry.header().entry_type() {
            T::Regular | T::Continuous | T::Directory | T::XGlobalHeader => {}
            T::Symlink => {
                let target = entry.link_name_bytes().unwrap_or_default().into_owned();
                if !link_stays_inside(&rel, &target) {
                    return Err(unpack(format!(
                        "the link {} points outside the archive",
                        rel.display()
                    )));
                }
            }
            T::Link => {
                let target = entry.link_name_bytes().unwrap_or_default().into_owned();
                safe_rel(&target).map_err(unpack)?;
            }
            other => {
                return Err(unpack(format!(
                    "{} is a {other:?} entry, which a daemon build never has",
                    rel.display()
                )));
            }
        }
    }
    std::fs::create_dir_all(dest).map_err(|e| unpack(e.to_string()))?;
    let mut ar = open_archive(tgz)?;
    ar.set_preserve_permissions(true);
    ar.set_overwrite(true);
    ar.unpack(dest)
        .map_err(|e| unpack(format!("cannot unpack: {e}")))
}

#[cfg(test)]
mod tests;
