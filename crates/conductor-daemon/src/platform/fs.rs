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

/// POSIX: the permission bits of `path` (lstat, `mode & 0o7777`). Windows has none: None.
pub fn posix_mode(path: &Path) -> Option<u32> {
    imp::posix_mode(path)
}

/// POSIX: chmod `path` (follows symlinks, as chmod(2)). Windows: a no-op.
pub fn set_posix_mode(path: &Path, mode: u32) -> io::Result<()> {
    imp::set_posix_mode(path, mode)
}

/// A symbolic link at `link` pointing to `target` (a file or a dir symlink, by what `target` is).
/// Windows needs Developer Mode or admin for this; tests that need it skip there.
pub fn symlink(target: &Path, link: &Path) -> io::Result<()> {
    imp::symlink(target, link)
}

/// Is this (lstat) metadata a reparse point: a symlink, a junction or another name surrogate?
/// POSIX: a symlink.
pub fn is_reparse_point(meta: &Metadata) -> bool {
    imp::is_reparse_point(meta)
}

/// Node's `path.resolve(p)` for this OS: absolute against the cwd, `.` and `..` resolved lexically
/// (never through the file system), no trailing separator except at the root. `std::path::absolute`
/// keeps `..` on POSIX, which `config.ts` never did.
pub fn resolve(p: impl AsRef<Path>) -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_default();
    resolve_for(
        super::Platform::current(),
        &cwd.to_string_lossy(),
        &p.as_ref().to_string_lossy(),
    )
    .into()
}

/// `path.posix.resolve(cwd, p)` or `path.win32.resolve(cwd, p)`: pure, for tests on every OS.
pub fn resolve_for(platform: super::Platform, cwd: &str, p: &str) -> String {
    if platform.is_windows() {
        return super::win_path::resolve(cwd, p);
    }
    let joined = if p.starts_with('/') {
        p.to_string()
    } else {
        format!("{cwd}/{p}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
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

    pub fn posix_mode(path: &Path) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(path)
            .ok()
            .map(|m| m.mode() & 0o7777)
    }

    pub fn set_posix_mode(path: &Path, mode: u32) -> io::Result<()> {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }

    pub fn symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
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

    pub fn posix_mode(_path: &Path) -> Option<u32> {
        None
    }

    pub fn set_posix_mode(_path: &Path, _mode: u32) -> io::Result<()> {
        Ok(())
    }

    pub fn symlink(target: &Path, link: &Path) -> io::Result<()> {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
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
    fn resolve_is_lexical_like_path_resolve() {
        use super::super::Platform::{Posix, Windows};
        assert_eq!(resolve_for(Posix, "/home/me", "a/../b"), "/home/me/b");
        assert_eq!(resolve_for(Posix, "/home/me", "./x/"), "/home/me/x");
        assert_eq!(resolve_for(Posix, "/home/me", "/abs//p/."), "/abs/p");
        assert_eq!(resolve_for(Posix, "/", "../.."), "/");
        assert_eq!(
            resolve_for(Windows, "C:\\Users\\me", "a\\..\\b"),
            "C:\\Users\\me\\b"
        );
        assert_eq!(resolve_for(Windows, "C:\\Users\\me", "D:\\x"), "D:\\x");
        assert!(resolve("x").is_absolute());
    }

    #[test]
    fn posix_modes_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        std::fs::write(&f, "x").unwrap();
        set_posix_mode(&f, 0o640).unwrap();
        if !super::super::Platform::current().is_windows() {
            assert_eq!(posix_mode(&f), Some(0o640));
            symlink(&f, &dir.path().join("l")).unwrap();
            assert!(is_reparse_point(
                &std::fs::symlink_metadata(dir.path().join("l")).unwrap()
            ));
        } else {
            assert_eq!(posix_mode(&f), None);
        }
    }

    #[test]
    fn held_open_is_windows_only() {
        let e = io::Error::from(io::ErrorKind::NotFound);
        assert!(!is_held_open(&e));
    }
}
