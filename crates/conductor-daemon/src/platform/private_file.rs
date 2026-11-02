//! Port of `packages/daemon/src/platform/private-file.ts` (added by MR-T05: MR-T04 left it out, and
//! the machine credential needs it). TD-118 (M2-T18): private files without a check-then-use
//! window.
//!
//! POSIX: the file is opened with `O_NOFOLLOW` and checked with `fstat` on that same fd; a strict
//! dir is 0700-style and ours; a write chmods the dir through an `O_NOFOLLOW` fd (never by path, so
//! never through a symlink), and fsyncs the file and then the dir. Windows: `acl`'s owner-only DACL
//! checks and writes (ADR-0024 §3); NTFS has no `O_NOFOLLOW`, and lstat already refuses junctions.

use super::acl::{AclKind, AssertOwnerOnlyOptions, PrivateError};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// Test hook: the fsync calls (file, then dir) are observable.
pub trait DurableIo {
    fn fsync(&self, f: &File) -> io::Result<()>;
}

/// The real fsync.
pub struct SyncAll;

impl DurableIo for SyncAll {
    fn fsync(&self, f: &File) -> io::Result<()> {
        f.sync_all()
    }
}

/// Refuse `dir` unless it is a real directory owned by this user that nobody else can access:
/// POSIX `mode & 0o077` is 0 too (`acl` checks only a dir's type and owner there), Windows the
/// DACL.
pub fn assert_private_dir(dir: &Path) -> Result<(), PrivateError> {
    super::acl::assert_owner_only(dir, AssertOwnerOnlyOptions::new(AclKind::Dir))?;
    imp::assert_dir_mode(dir)
}

/// Read a file only this user can read: type, owner and mode are checked on the open fd (POSIX).
pub fn read_private_file(path: &Path) -> Result<String, PrivateError> {
    imp::read_private_file(path)
}

/// Write `<dir>/<name>` atomically and durably, readable only by this user, creating `dir`
/// private. `before_write` runs once `dir` is private and before anything is written (e.g. "no
/// file yet"). Returns the file's path.
pub fn write_private_file_durable<E: From<PrivateError>>(
    dir: &Path,
    name: &str,
    data: &[u8],
    before_write: impl FnOnce() -> Result<(), E>,
    io: &dyn DurableIo,
) -> Result<PathBuf, E> {
    imp::write_private_file_durable(dir, name, data, before_write, io)
}

#[cfg(unix)]
mod imp {
    use super::DurableIo;
    use crate::platform::acl::{AclError, AclRefusal, PrivateError};
    use std::fs::{self, File, OpenOptions, Permissions};
    use std::io::{self, Read, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    fn uid() -> u32 {
        nix::unistd::getuid().as_raw()
    }

    fn symlink_refusal(path: &Path) -> PrivateError {
        AclError::new(
            AclRefusal::WrongType,
            format!("{} is a symlink; refusing to use it", path.display()),
        )
        .into()
    }

    pub fn assert_dir_mode(dir: &Path) -> Result<(), PrivateError> {
        if fs::symlink_metadata(dir)?.mode() & 0o077 != 0 {
            let d = dir.display();
            return Err(AclError::new(
                AclRefusal::TooOpen,
                format!("{d} is accessible to other users; run: chmod 700 {d}"),
            )
            .into());
        }
        Ok(())
    }

    pub fn read_private_file(path: &Path) -> Result<String, PrivateError> {
        let mut f = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
        {
            Ok(f) => f,
            Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Err(symlink_refusal(path)),
            Err(e) => return Err(e.into()),
        };
        let st = f.metadata()?;
        let p = path.display();
        if !st.is_file() {
            return Err(
                AclError::new(AclRefusal::WrongType, format!("{p} is not a regular file")).into(),
            );
        }
        if st.uid() != uid() {
            return Err(AclError::new(
                AclRefusal::ForeignOwner,
                format!("{p} is owned by another user; refusing to use it"),
            )
            .into());
        }
        if st.mode() & 0o077 != 0 {
            return Err(AclError::new(
                AclRefusal::TooOpen,
                format!("{p} is readable by other users; run: chmod 600 {p}"),
            )
            .into());
        }
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        Ok(s)
    }

    /// An fd on `dir` that is a real directory (not a symlink) owned by us.
    fn open_private_dir(dir: &Path) -> Result<File, PrivateError> {
        let f = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(dir)
        {
            Ok(f) => f,
            Err(e) => {
                // O_DIRECTORY | O_NOFOLLOW on a symlink: ELOOP (macOS) or ENOTDIR (Linux).
                let code = e.raw_os_error();
                let link = code == Some(libc::ELOOP)
                    || (code == Some(libc::ENOTDIR)
                        && fs::symlink_metadata(dir).is_ok_and(|m| m.file_type().is_symlink()));
                if link {
                    return Err(symlink_refusal(dir));
                }
                if code == Some(libc::ENOTDIR) {
                    return Err(AclError::new(
                        AclRefusal::WrongType,
                        format!("{} is not a directory", dir.display()),
                    )
                    .into());
                }
                return Err(e.into());
            }
        };
        let st = f.metadata()?;
        if !st.is_dir() || st.uid() != uid() {
            return Err(AclError::new(
                AclRefusal::ForeignOwner,
                format!(
                    "{} is owned by another user; refusing to use it",
                    dir.display()
                ),
            )
            .into());
        }
        Ok(f)
    }

    pub fn write_private_file_durable<E: From<PrivateError>>(
        dir: &Path,
        name: &str,
        data: &[u8],
        before_write: impl FnOnce() -> Result<(), E>,
        io: &dyn DurableIo,
    ) -> Result<PathBuf, E> {
        let path = dir.join(name);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| E::from(e.into()))?;
        let dir_fd = open_private_dir(dir)?;
        dir_fd
            .set_permissions(Permissions::from_mode(0o700))
            .map_err(|e| E::from(e.into()))?;
        before_write()?;
        let tmp = PathBuf::from(format!(
            "{}.{}.tmp",
            path.to_string_lossy(),
            hex::encode(rand::random::<[u8; 6]>())
        ));
        let write = || -> io::Result<()> {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&tmp)?;
            f.set_permissions(Permissions::from_mode(0o600))?; // umask-proof
            f.write_all(data)?;
            io.fsync(&f)?;
            drop(f);
            fs::rename(&tmp, &path)
        };
        if let Err(e) = write() {
            let _ = fs::remove_file(&tmp);
            return Err(E::from(e.into()));
        }
        // The rename itself survives a power cut only once the directory is synced.
        io.fsync(&dir_fd).map_err(|e| E::from(e.into()))?;
        Ok(path)
    }
}

#[cfg(windows)]
mod imp {
    use super::DurableIo;
    use crate::platform::acl::{
        AclKind, AssertOwnerOnlyOptions, PrivateError, assert_owner_only, mkdir_private,
        write_private_file,
    };
    use std::path::{Path, PathBuf};

    pub fn assert_dir_mode(_dir: &Path) -> Result<(), PrivateError> {
        Ok(()) // the DACL check in assert_owner_only covers it
    }

    pub fn read_private_file(path: &Path) -> Result<String, PrivateError> {
        assert_owner_only(path, AssertOwnerOnlyOptions::new(AclKind::File))?;
        Ok(std::fs::read_to_string(path)?)
    }

    pub fn write_private_file_durable<E: From<PrivateError>>(
        dir: &Path,
        name: &str,
        data: &[u8],
        before_write: impl FnOnce() -> Result<(), E>,
        _io: &dyn DurableIo,
    ) -> Result<PathBuf, E> {
        let path = dir.join(name);
        mkdir_private(dir)?;
        before_write()?;
        write_private_file(&path, data)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::acl::{AclError, AclRefusal};

    #[test]
    fn writes_then_reads_back_a_private_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("root");
        let path = write_private_file_durable::<PrivateError>(
            &dir,
            "x.json",
            b"{}\n",
            || Ok(()),
            &SyncAll,
        )
        .unwrap();
        assert_eq!(path, dir.join("x.json"));
        assert_private_dir(&dir).unwrap();
        assert_eq!(read_private_file(&path).unwrap(), "{}\n");
    }

    #[test]
    fn before_write_can_refuse_and_nothing_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("root");
        let r = write_private_file_durable::<PrivateError>(
            &dir,
            "x.json",
            b"{}",
            || Err(AclError::new(AclRefusal::TooOpen, "no").into()),
            &SyncAll,
        );
        assert!(r.is_err());
        assert!(!dir.join("x.json").exists());
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let e = read_private_file(&tmp.path().join("nope")).unwrap_err();
        assert!(matches!(e, PrivateError::Io(ref io) if io.kind() == io::ErrorKind::NotFound));
    }
}
