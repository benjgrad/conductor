//! Port of `packages/daemon/src/credential.ts` (MR-T05). The machine credential (M2-T04; ADR-0013
//! §Enrollment, ADR-0017 §Daemon distribution): `<root>/machine.json` = `{url, machine_id,
//! credential}`, file 0600 in a 0700 directory, both lstat- and owner-checked like ADR-0010's
//! private repos. On Windows the same checks are an owner-only DACL (ADR-0024 §3, `platform::acl`).
//! No file = local mode (M1 behaviour). Error messages name paths, never the credential.
//!
//! TD-118 (`platform::private_file`): POSIX opens the file with `O_NOFOLLOW` and checks it with
//! fstat on that fd; a loaded root must be 0700 and ours; a write fsyncs the file and the root, and
//! chmods the root through an `O_NOFOLLOW` fd, never by path.

use crate::platform::{
    AclKind, AssertOwnerOnlyOptions, DurableIo, PrivateError, SyncAll, assert_owner_only,
    assert_private_dir, read_private_file, write_private_file_durable,
};
use conductor_protocol::api_paths;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

pub const CREDENTIAL_FILE: &str = "machine.json";

/// Hosts that may be reached over plain http/ws (dev and tests); everything else needs TLS.
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error(transparent)]
    Private(#[from] PrivateError),
    #[error("{0}")]
    Invalid(String),
}

impl From<io::Error> for CredentialError {
    fn from(e: io::Error) -> Self {
        CredentialError::Private(e.into())
    }
}

/// True for an https/wss URL, or an http/ws URL to a [`LOOPBACK_HOSTS`] host.
pub fn is_secure_or_loopback(url: &Url) -> bool {
    match url.scheme() {
        "https" | "wss" => true,
        "http" | "ws" => url.host_str().is_some_and(|h| LOOPBACK_HOSTS.contains(&h)),
        _ => false,
    }
}

/// The contents of `machine.json`, fields in the TS order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineCredential {
    pub url: String,
    pub machine_id: String,
    pub credential: String,
}

fn url_ok(u: &str) -> bool {
    Url::parse(u)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && is_secure_or_loopback(&url))
}

/// The TS zod schema's checks: the names of the bad fields, in schema order (`(root)` for a
/// non-object). Empty = valid.
fn invalid_fields(raw: &serde_json::Value) -> Vec<&'static str> {
    let Some(o) = raw.as_object() else {
        return vec!["(root)"];
    };
    let str_field = |k: &str| o.get(k).and_then(|v| v.as_str());
    let mut bad = Vec::new();
    if !str_field("url").is_some_and(url_ok) {
        bad.push("url");
    }
    if !str_field("machine_id").is_some_and(|s| !s.is_empty()) {
        bad.push("machine_id");
    }
    if !str_field("credential").is_some_and(|s| !s.is_empty()) {
        bad.push("credential");
    }
    bad
}

impl MachineCredential {
    /// Validate as the TS schema does; Err names the bad fields (never their values).
    pub fn validate(&self) -> Result<(), String> {
        let bad = invalid_fields(&serde_json::to_value(self).unwrap_or_default());
        if bad.is_empty() {
            Ok(())
        } else {
            Err(bad.join(", "))
        }
    }
}

pub fn credential_path(root_dir: &Path) -> PathBuf {
    root_dir.join(CREDENTIAL_FILE)
}

fn exists_lstat(path: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Refuse a root that is a symlink, not a directory, or owned by another user (Windows: also any
/// DACL that isn't owner-only). With `check_mode` (loading): POSIX also requires 0700-style privacy.
pub fn check_private_dir(dir: &Path, check_mode: bool) -> Result<(), PrivateError> {
    if check_mode {
        assert_private_dir(dir)
    } else {
        assert_owner_only(dir, AssertOwnerOnlyOptions::new(AclKind::Dir))
    }
}

/// Check that a credential could be written under `root_dir`: the root (if it exists) is private
/// and there is no credential yet, unless `force` (a symlinked or foreign file is refused even
/// then). Used by `enroll` before it spends the one-time token.
pub fn check_writable(root_dir: &Path, force: bool) -> Result<(), CredentialError> {
    if !exists_lstat(root_dir)? {
        return Ok(());
    }
    check_private_dir(root_dir, false)?;
    let path = credential_path(root_dir);
    if !exists_lstat(&path)? {
        return Ok(());
    }
    // Type and owner only: the file is about to be replaced, so its mode doesn't matter.
    assert_owner_only(
        &path,
        AssertOwnerOnlyOptions {
            kind: AclKind::File,
            check_access: false,
        },
    )?;
    if !force {
        return Err(CredentialError::Invalid(format!(
            "{} already exists (this machine is enrolled); pass --force to replace it",
            path.display()
        )));
    }
    Ok(())
}

/// The stored credential, or None (local mode) when `<root>/machine.json` does not exist.
pub fn load_credential(root_dir: &Path) -> Result<Option<MachineCredential>, CredentialError> {
    let path = credential_path(root_dir);
    if !exists_lstat(root_dir)? || !exists_lstat(&path)? {
        return Ok(None);
    }
    check_private_dir(root_dir, true)?;
    // Type, owner, and nobody else can read it (POSIX `mode & 0o077` on the open fd, Windows the
    // DACL).
    let text = read_private_file(&path)?;
    let p = path.display();
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        CredentialError::Invalid(format!("{p} is not valid JSON; enroll again with --force"))
    })?;
    let bad = invalid_fields(&raw);
    if !bad.is_empty() {
        return Err(CredentialError::Invalid(format!(
            "{p} is invalid ({}); enroll again with --force",
            bad.join(", ")
        )));
    }
    serde_json::from_value(raw).map_err(|_| {
        CredentialError::Invalid(format!(
            "{p} is invalid ((root)); enroll again with --force"
        ))
    })
}

/// `JSON.stringify(cred, null, 2) + "\n"`.
pub fn credential_json(cred: &MachineCredential) -> String {
    let mut s = serde_json::to_string_pretty(cred).expect("a credential serialises");
    s.push('\n');
    s
}

/// Write the credential atomically (private temp file + rename) into a private root. POSIX: the
/// root is made 0700 through an `O_NOFOLLOW` fd, and the file and the root are fsynced. Returns
/// the file's path.
pub fn write_credential(
    root_dir: &Path,
    cred: &MachineCredential,
    force: bool,
) -> Result<PathBuf, CredentialError> {
    write_credential_with(root_dir, cred, force, &SyncAll)
}

/// [`write_credential`] with the fsync hook (tests observe the calls).
pub fn write_credential_with(
    root_dir: &Path,
    cred: &MachineCredential,
    force: bool,
    io: &dyn DurableIo,
) -> Result<PathBuf, CredentialError> {
    cred.validate().map_err(|fields| {
        CredentialError::Invalid(format!("the machine credential is invalid ({fields})"))
    })?;
    write_private_file_durable(
        root_dir,
        CREDENTIAL_FILE,
        credential_json(cred).as_bytes(),
        || check_writable(root_dir, force),
        io,
    )
}

/// The daemon WS URL for a stored orchestrator URL: https → wss, http → ws, path daemonWs.
pub fn daemon_ws_url(stored_url: &str) -> Result<String, String> {
    let mut u = Url::parse(stored_url).map_err(|e| format!("{stored_url} is not a URL: {e}"))?;
    let scheme = if u.scheme() == "https" { "wss" } else { "ws" };
    u.set_scheme(scheme)
        .map_err(|()| format!("{stored_url} cannot be turned into a {scheme}:// URL"))?;
    u.set_path(api_paths::DAEMON_WS);
    u.set_query(None);
    u.set_fragment(None);
    Ok(u.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::fs::{posix_mode, set_posix_mode, symlink};
    use crate::platform::{Platform, mkdir_private, write_private_file};
    use std::cell::RefCell;
    use std::fs::File;

    const ON_WINDOWS: bool = Platform::current().is_windows();

    fn cred() -> MachineCredential {
        MachineCredential {
            url: "https://conductor.example.com".into(),
            machine_id: "m-1".into(),
            credential: "secret-xyz".into(),
        }
    }

    fn tmp() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        mkdir_private(t.path()).unwrap();
        t
    }

    /// Let other users read `path`: chmod 644/755 (POSIX), or grant Everyone read (Windows).
    fn widen(path: &Path, dir: bool) {
        if ON_WINDOWS {
            let ok = std::process::Command::new("icacls")
                .arg(path)
                .args(["/grant", "*S-1-1-0:R"])
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok);
        } else {
            set_posix_mode(path, if dir { 0o755 } else { 0o644 }).unwrap();
        }
    }

    fn mode(path: &Path) -> u32 {
        posix_mode(path).unwrap()
    }

    #[test]
    fn is_none_local_mode_without_a_root_or_a_file() {
        let t = tmp();
        assert_eq!(load_credential(&t.path().join("missing")).unwrap(), None);
        assert_eq!(load_credential(t.path()).unwrap(), None);
    }

    #[test]
    fn round_trips_what_write_credential_wrote() {
        let t = tmp();
        let root = t.path().join("root");
        write_credential(&root, &cred(), false).unwrap();
        assert_eq!(load_credential(&root).unwrap(), Some(cred()));
        // Enrolled already: refused without --force, replaced with it.
        let e = write_credential(&root, &cred(), false).unwrap_err();
        assert!(e.to_string().contains("already exists"), "{e}");
        write_credential(&root, &cred(), true).unwrap();
    }

    #[test]
    fn refuses_a_group_other_readable_file_and_says_how_to_fix_it() {
        let t = tmp();
        let root = t.path().join("root");
        let path = write_credential(&root, &cred(), false).unwrap();
        widen(&path, false);
        let msg = load_credential(&root).unwrap_err().to_string();
        if ON_WINDOWS {
            assert!(
                msg.contains("accessible to other users (S-1-1-0); run: icacls"),
                "{msg}"
            );
        } else {
            assert!(
                msg.contains(&format!("chmod 600 {}", path.display())),
                "{msg}"
            );
        }
    }

    #[test]
    fn refuses_a_root_other_users_can_read() {
        let t = tmp();
        let root = t.path().join("root");
        write_credential(&root, &cred(), false).unwrap();
        widen(&root, true);
        let msg = load_credential(&root).unwrap_err().to_string();
        if ON_WINDOWS {
            assert!(msg.contains("accessible to other users"), "{msg}");
        } else {
            assert!(
                msg.contains(&format!(
                    "accessible to other users; run: chmod 700 {}",
                    root.display()
                )),
                "{msg}"
            );
            // Enrolling again makes it private again (the write fchmods the root to 0700).
            write_credential(&root, &cred(), true).unwrap();
            assert_eq!(load_credential(&root).unwrap(), Some(cred()));
        }
    }

    #[test]
    fn refuses_a_symlinked_file_and_a_symlinked_root() {
        if ON_WINDOWS {
            return; // TS creates file symlinks here, which need Developer Mode on Windows
        }
        let t = tmp();
        let root = t.path().join("root");
        mkdir_private(&root).unwrap();
        let elsewhere = t.path().join("elsewhere.json");
        write_private_file(&elsewhere, credential_json(&cred()).as_bytes()).unwrap();
        symlink(&elsewhere, &root.join("machine.json")).unwrap();
        let msg = load_credential(&root).unwrap_err().to_string();
        assert!(msg.contains("symlink"), "{msg}");

        let real = t.path().join("real");
        write_credential(&real, &cred(), false).unwrap();
        let link = t.path().join("link");
        symlink(&real, &link).unwrap();
        let msg = load_credential(&link).unwrap_err().to_string();
        assert!(msg.contains("symlink"), "{msg}");
    }

    #[test]
    fn refuses_invalid_content_without_echoing_it() {
        let t = tmp();
        let root = t.path().join("root");
        mkdir_private(&root).unwrap();
        let bad = MachineCredential {
            url: "ftp://x".into(),
            ..cred()
        };
        write_private_file(
            &root.join("machine.json"),
            serde_json::to_string(&bad).unwrap().as_bytes(),
        )
        .unwrap();
        let msg = load_credential(&root).unwrap_err().to_string();
        assert!(msg.contains("invalid (url)"), "{msg}");
        assert!(!msg.contains("secret-xyz"));
        write_private_file(&root.join("machine.json"), b"{not json").unwrap();
        let msg = load_credential(&root).unwrap_err().to_string();
        assert!(
            msg.ends_with("is not valid JSON; enroll again with --force"),
            "{msg}"
        );
        write_private_file(&root.join("machine.json"), b"{\"url\":1}").unwrap();
        let msg = load_credential(&root).unwrap_err().to_string();
        assert!(
            msg.contains("invalid (url, machine_id, credential)"),
            "{msg}"
        );
    }

    #[test]
    fn a_symlinked_machine_json_is_refused_by_the_o_nofollow_open() {
        if ON_WINDOWS {
            return; // POSIX only (TD-118)
        }
        let t = tmp();
        let root = t.path().join("root");
        mkdir_private(&root).unwrap();
        let target = root.join("target.json");
        write_private_file(&target, credential_json(&cred()).as_bytes()).unwrap();
        symlink(&target, &root.join("machine.json")).unwrap();
        let msg = load_credential(&root).unwrap_err().to_string();
        assert!(
            msg.contains(&format!(
                "{} is a symlink",
                root.join("machine.json").display()
            )),
            "{msg}"
        );
    }

    struct Recording(RefCell<Vec<u64>>);
    impl DurableIo for Recording {
        fn fsync(&self, f: &File) -> io::Result<()> {
            // Tell the two files apart by what they are (a file, then the dir).
            let meta = f.metadata()?;
            self.0.borrow_mut().push(u64::from(meta.is_dir()));
            f.sync_all()
        }
    }

    #[test]
    fn a_write_fsyncs_the_file_and_then_the_root() {
        if ON_WINDOWS {
            return; // POSIX only (TD-118)
        }
        let t = tmp();
        let root = t.path().join("root");
        let rec = Recording(RefCell::new(Vec::new()));
        write_credential_with(&root, &cred(), false, &rec).unwrap();
        assert_eq!(*rec.0.borrow(), vec![0, 1]);
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&root.join("machine.json")), 0o600);
    }

    #[test]
    fn a_symlinked_root_is_refused_and_its_target_is_never_chmodded() {
        if ON_WINDOWS {
            return; // POSIX only (TD-118)
        }
        let t = tmp();
        let real = t.path().join("shared");
        std::fs::create_dir(&real).unwrap();
        set_posix_mode(&real, 0o755).unwrap();
        let link = t.path().join("link");
        symlink(&real, &link).unwrap();
        for force in [false, true] {
            let msg = write_credential(&link, &cred(), force)
                .unwrap_err()
                .to_string();
            assert!(msg.contains("symlink"), "{msg}");
        }
        assert_eq!(mode(&real), 0o755);
    }

    #[test]
    fn a_loose_existing_root_is_tightened_to_0700_by_a_write() {
        if ON_WINDOWS {
            return; // POSIX only (TD-118)
        }
        let t = tmp();
        let root = t.path().join("root");
        std::fs::create_dir(&root).unwrap();
        set_posix_mode(&root, 0o755).unwrap();
        write_credential(&root, &cred(), false).unwrap();
        assert_eq!(mode(&root), 0o700);
    }

    #[test]
    fn rejects_plain_http_to_a_non_loopback_host_on_load_and_on_write() {
        let t = tmp();
        let root = t.path().join("root");
        mkdir_private(&root).unwrap();
        let plain = MachineCredential {
            url: "http://conductor.example.com".into(),
            ..cred()
        };
        write_private_file(
            &root.join("machine.json"),
            serde_json::to_string(&plain).unwrap().as_bytes(),
        )
        .unwrap();
        let msg = load_credential(&root).unwrap_err().to_string();
        assert!(msg.contains("invalid (url)"), "{msg}");
        assert!(write_credential(&t.path().join("other"), &plain, false).is_err());
        let local = MachineCredential {
            url: "http://127.0.0.1:8080".into(),
            ..cred()
        };
        write_credential(&t.path().join("ok"), &local, false).unwrap();
        assert_eq!(
            load_credential(&t.path().join("ok")).unwrap().unwrap().url,
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn maps_https_to_wss_and_http_to_ws_on_the_daemon_ws_path() {
        assert_eq!(
            daemon_ws_url("https://conductor.example.com/").unwrap(),
            "wss://conductor.example.com/ws/daemon"
        );
        assert_eq!(
            daemon_ws_url("http://127.0.0.1:8080/x?y=1#z").unwrap(),
            "ws://127.0.0.1:8080/ws/daemon"
        );
        // WHATWG edge cases, as `new URL` gives them.
        assert_eq!(daemon_ws_url("https://x").unwrap(), "wss://x/ws/daemon");
        assert_eq!(
            daemon_ws_url("https://x:8443/p?q#h").unwrap(),
            "wss://x:8443/ws/daemon"
        );
        assert_eq!(
            daemon_ws_url("http://[::1]:1").unwrap(),
            "ws://[::1]:1/ws/daemon"
        );
    }

    #[test]
    fn loopback_hosts_include_bracketed_ipv6() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_secure_or_loopback(&u("http://[::1]:1/")));
        assert!(is_secure_or_loopback(&u("ws://localhost:1/")));
        assert!(is_secure_or_loopback(&u("wss://example.com/")));
        assert!(!is_secure_or_loopback(&u("http://example.com/")));
        assert!(!is_secure_or_loopback(&u("ftp://127.0.0.1/")));
    }
}
