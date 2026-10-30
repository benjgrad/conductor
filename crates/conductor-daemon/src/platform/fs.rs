//! Port of `packages/daemon/src/platform/fs.ts` (MR-T04): comparing paths on each OS, plus the
//! small file-system facts `test_support` needs without an OS `cfg` of its own.

use std::fs::Metadata;
use std::io;
use std::path::Path;

/// Do `a` and `b` name the same existing file or directory? POSIX: equal realpaths. Windows:
/// canonical paths (`GetFinalPathNameByHandle`: it expands 8.3 short names such as `RUNNER~1`,
/// which git never prints, and resolves junctions), compared case-insensitively. False when either
/// is missing.
pub fn same_path(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) else {
        return false;
    };
    imp::same_canonical(&a, &b)
}

/// Make `path` executable by everyone (0755) on POSIX; Windows has no exec bit (a no-op).
pub fn set_executable(path: &Path) -> io::Result<()> {
    imp::set_executable(path)
}

/// Is `err` "the file is still held open by some process"? Windows: a sharing violation or an
/// access denial (what deleting a dir that a running process uses as its cwd reports). POSIX
/// never refuses a delete for that, so: false.
pub fn is_held_open(err: &io::Error) -> bool {
    imp::is_held_open(err)
}

/// Is this (lstat) metadata a reparse point: a symlink, a junction or another name surrogate?
/// POSIX: a symlink.
pub fn is_reparse_point(meta: &Metadata) -> bool {
    imp::is_reparse_point(meta)
}

#[cfg(unix)]
mod imp {
    use std::fs::Metadata;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    pub fn same_canonical(a: &Path, b: &Path) -> bool {
        a == b
    }

    pub fn set_executable(path: &Path) -> io::Result<()> {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
    }

    pub fn is_held_open(_err: &io::Error) -> bool {
        false
    }

    pub fn is_reparse_point(meta: &Metadata) -> bool {
        meta.file_type().is_symlink()
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::Metadata;
    use std::io;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    pub fn same_canonical(a: &Path, b: &Path) -> bool {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }

    pub fn set_executable(_path: &Path) -> io::Result<()> {
        Ok(())
    }

    pub fn is_held_open(err: &io::Error) -> bool {
        matches!(
            err.raw_os_error(),
            Some(c) if c == ERROR_SHARING_VIOLATION as i32 || c == ERROR_ACCESS_DENIED as i32
        ) || err.kind() == io::ErrorKind::PermissionDenied
    }

    pub fn is_reparse_point(meta: &Metadata) -> bool {
        meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
}

/// Test helpers that need the OS (Windows junctions).
#[cfg(all(test, windows))]
pub(crate) mod tests_support {
    use std::path::Path;

    /// `mklink /J link target` (std has no junction API). Test-only.
    pub fn make_junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .expect("run mklink");
        assert!(status.success(), "mklink /J failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_through_links_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::create_dir(&a).unwrap();
        assert!(same_path(&a, dir.path().join(".").join("a")));
        assert!(!same_path(&a, dir.path()));
        assert!(!same_path(&a, dir.path().join("missing")));
    }

    #[cfg(windows)]
    #[test]
    fn same_path_is_case_insensitive_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("Abc");
        std::fs::create_dir(&a).unwrap();
        assert!(same_path(&a, dir.path().join("aBC")));
    }

    #[test]
    fn held_open_is_windows_only() {
        let e = io::Error::from(io::ErrorKind::NotFound);
        assert!(!is_held_open(&e));
    }
}
