//! Machine facts the TS daemon read from `node:os` and `node:fs` (MR-T05): `config.ts`'s
//! `machineFacts` (`os.cpus().length`, `os.totalmem()`, `os.hostname()`, `os.homedir()`) and
//! `sysinfo.ts`'s disk space (`fs.statfsSync`). Added by MR-T05 because each one is a different
//! syscall per OS, and the seam rule keeps those here.
//!
//! The CPU count is the number of online CPUs (what `os.cpus().length` lists), not
//! `std::thread::available_parallelism`, which honours cgroup quotas and affinity and would change
//! the daemon's default budgets inside a container.

use std::path::{Path, PathBuf};

/// Online CPUs (`os.cpus().length`), at least 1.
pub fn cpu_count() -> usize {
    imp::cpu_count().max(1)
}

/// Total physical memory in bytes (`os.totalmem()`); 0 if it can't be read.
pub fn total_mem_bytes() -> u64 {
    imp::total_mem_bytes()
}

/// The host name (`os.hostname()`); empty if it can't be read.
pub fn hostname() -> String {
    imp::hostname()
}

/// The user's home dir (`os.homedir()`: `HOME` on POSIX, `USERPROFILE` on Windows).
pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// Bytes free to this user on the file system holding `path` (`statfs` `bavail * bsize`); None if
/// the path doesn't exist or can't be read.
pub fn disk_free_bytes(path: &Path) -> Option<u64> {
    imp::disk_free_bytes(path)
}

/// Is this build for macOS? A runtime answer for tests outside `platform/` (the seam rule).
pub const fn is_macos() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(unix)]
mod imp {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    pub fn cpu_count() -> usize {
        // SAFETY: sysconf has no preconditions.
        let n = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
        usize::try_from(n).unwrap_or(1)
    }

    #[cfg(target_os = "macos")]
    pub fn total_mem_bytes() -> u64 {
        let mut mem: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: a NUL-terminated name and an out buffer of the size we pass.
        let rc = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut mem as *mut u64).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 { mem } else { 0 }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn total_mem_bytes() -> u64 {
        // SAFETY: sysconf has no preconditions.
        let (pages, size) = unsafe {
            (
                libc::sysconf(libc::_SC_PHYS_PAGES),
                libc::sysconf(libc::_SC_PAGESIZE),
            )
        };
        match (u64::try_from(pages), u64::try_from(size)) {
            (Ok(p), Ok(s)) => p * s,
            _ => 0,
        }
    }

    pub fn hostname() -> String {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for `len` bytes; gethostname NUL-terminates within it when
        // the name fits, and the last byte is kept 0 for the case where it doesn't.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len() - 1) };
        if rc != 0 {
            return String::new();
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    }

    pub fn disk_free_bytes(path: &Path) -> Option<u64> {
        let c = CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: a zeroed statvfs out struct and a NUL-terminated path.
        unsafe {
            let mut st: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c.as_ptr(), &mut st) != 0 {
                return None;
            }
            #[allow(clippy::unnecessary_cast)]
            Some(st.f_bavail as u64 * st.f_frsize as u64)
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW, GetSystemInfo, GlobalMemoryStatusEx,
        MEMORYSTATUSEX, SYSTEM_INFO,
    };

    pub fn cpu_count() -> usize {
        // SAFETY: a zeroed SYSTEM_INFO out struct.
        unsafe {
            let mut si: SYSTEM_INFO = std::mem::zeroed();
            GetSystemInfo(&mut si);
            si.dwNumberOfProcessors as usize
        }
    }

    pub fn total_mem_bytes() -> u64 {
        // SAFETY: a zeroed MEMORYSTATUSEX with dwLength set, as the API requires.
        unsafe {
            let mut st: MEMORYSTATUSEX = std::mem::zeroed();
            st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut st) == 0 {
                return 0;
            }
            st.ullTotalPhys
        }
    }

    pub fn hostname() -> String {
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        // SAFETY: the buffer holds `len` UTF-16 units; the API writes the length back.
        let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) };
        if ok == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    pub fn disk_free_bytes(path: &Path) -> Option<u64> {
        let w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: a NUL-terminated path and one out pointer; the others may be null.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                w.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(free)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_machine_facts() {
        assert!(cpu_count() >= 1);
        assert!(total_mem_bytes() > 0);
        assert!(!hostname().is_empty());
        assert!(home_dir().is_absolute());
    }

    #[test]
    fn disk_free_for_an_existing_dir_and_none_for_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        assert!(disk_free_bytes(dir.path()).is_some_and(|b| b > 0));
        assert_eq!(disk_free_bytes(&dir.path().join("missing")), None);
    }
}
