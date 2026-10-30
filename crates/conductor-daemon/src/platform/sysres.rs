//! Port of `packages/daemon/src/platform/sysres.ts` (MR-T04). ADR-0024 §8: machine resources
//! that each OS reports differently.
//!
//! Memory: macOS "free" counts only completely unused pages, so darwin reads `vm_stat`; Linux reads
//! `MemAvailable` (what Node's `os.freemem()` reads there); Windows `GlobalMemoryStatusEx`.
//! CPU: POSIX uses the 1-minute load average. Windows has none, so busy cores come from
//! `GetSystemTimes` deltas between two calls (the first call uses the totals since boot).

/// Available memory on macOS from `vm_stat`: free + inactive + speculative + purgeable pages, i.e.
/// what the kernel can hand out without swapping. None if the output can't be parsed.
pub fn parse_vm_stat_available_bytes(out: &str) -> Option<u64> {
    let page_size: u64 = {
        let rest = &out[out.find("page size of ")? + "page size of ".len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !rest[digits.len()..].starts_with(" bytes") {
            return None;
        }
        digits.parse().ok()?
    };
    let pages = |label: &str| -> Option<u64> {
        let key = format!("Pages {label}:");
        let rest = out[out.find(&key)? + key.len()..].trim_start();
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    };
    let mut total = 0u64;
    for label in ["free", "inactive", "speculative", "purgeable"] {
        total += pages(label)?;
    }
    Some(total * page_size)
}

/// Memory the OS can hand out without swapping, in bytes.
pub fn available_mem_bytes() -> u64 {
    imp::available_mem_bytes()
}

/// CPU time of one core (or of all of them, summed), in any unit.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuTimes {
    pub busy: f64,
    pub idle: f64,
}

/// Busy cores between two snapshots: the busy share of the elapsed CPU time times the core count
/// (`now.len()`). Pure. With no elapsed time, 0.
pub fn busy_cores_between(prev: &[CpuTimes], now: &[CpuTimes]) -> f64 {
    let sum = |s: &[CpuTimes]| {
        s.iter()
            .fold((0.0, 0.0), |(b, t), c| (b + c.busy, t + c.busy + c.idle))
    };
    let (a_busy, a_total) = sum(prev);
    let (b_busy, b_total) = sum(now);
    let total = b_total - a_total;
    if total <= 0.0 {
        return 0.0;
    }
    (b_busy - a_busy) / total * now.len() as f64
}

/// Busy cores now: POSIX the 1-minute load average; Windows the busy share since the last call.
pub fn busy_cores() -> f64 {
    imp::busy_cores()
}

#[cfg(unix)]
mod imp {
    pub fn busy_cores() -> f64 {
        let mut avg = [0f64; 3];
        // SAFETY: getloadavg writes at most `nelem` doubles into the buffer.
        let n = unsafe { libc::getloadavg(avg.as_mut_ptr(), 3) };
        if n < 1 { 0.0 } else { avg[0] }
    }

    #[cfg(target_os = "macos")]
    pub fn available_mem_bytes() -> u64 {
        let mut cmd = std::process::Command::new("/usr/bin/vm_stat");
        if let Ok(out) =
            super::super::spawn::output_with_timeout(&mut cmd, std::time::Duration::from_secs(2))
            && let Some(avail) =
                super::parse_vm_stat_available_bytes(&String::from_utf8_lossy(&out.stdout))
        {
            return avail;
        }
        free_pages_sysctl()
    }

    /// libuv's `uv_get_free_memory` on macOS: free pages × page size.
    #[cfg(target_os = "macos")]
    fn free_pages_sysctl() -> u64 {
        let mut free: u32 = 0;
        let mut len = std::mem::size_of::<u32>();
        // SAFETY: a NUL-terminated name and an out buffer of the size we pass.
        let rc = unsafe {
            libc::sysctlbyname(
                c"vm.page_free_count".as_ptr(),
                (&mut free as *mut u32).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return 0;
        }
        u64::from(free) * page_size()
    }

    #[cfg(not(target_os = "macos"))]
    pub fn available_mem_bytes() -> u64 {
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            for line in meminfo.lines() {
                if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    let kb: String = rest
                        .trim()
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    if let Ok(kb) = kb.parse::<u64>() {
                        return kb * 1024;
                    }
                }
            }
        }
        // SAFETY: sysconf has no preconditions.
        let pages = unsafe { libc::sysconf(libc::_SC_AVPHYS_PAGES) };
        u64::try_from(pages).unwrap_or(0) * page_size()
    }

    fn page_size() -> u64 {
        // SAFETY: sysconf has no preconditions.
        u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096)
    }
}

#[cfg(windows)]
mod imp {
    use super::CpuTimes;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::GetSystemTimes;

    pub fn available_mem_bytes() -> u64 {
        // SAFETY: a zeroed MEMORYSTATUSEX with dwLength set, as the API requires.
        unsafe {
            let mut st: MEMORYSTATUSEX = std::mem::zeroed();
            st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut st) == 0 {
                return 0;
            }
            st.ullAvailPhys
        }
    }

    fn ft(f: FILETIME) -> f64 {
        ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64
    }

    static LAST: Mutex<Option<CpuTimes>> = Mutex::new(None);

    /// The whole machine's CPU times (all cores summed). Kernel time includes idle time.
    fn system_times() -> Option<CpuTimes> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut idle, mut kernel, mut user) = (zero, zero, zero);
        // SAFETY: three valid out pointers.
        if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
            return None;
        }
        let idle = ft(idle);
        Some(CpuTimes {
            busy: ft(kernel) - idle + ft(user),
            idle,
        })
    }

    pub fn busy_cores() -> f64 {
        let Some(now) = system_times() else {
            return 0.0;
        };
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let prev = last.replace(now).unwrap_or_default();
        // One aggregate sample: the busy share, times the core count.
        super::busy_cores_between(&[prev], &[now]) * cores
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core(busy: f64, idle: f64) -> CpuTimes {
        CpuTimes { busy, idle }
    }

    #[test]
    fn busy_cores_between_is_the_busy_share_times_the_cores() {
        let prev = [core(100.0, 100.0), core(100.0, 100.0)];
        // core 1: 100 busy of 200 elapsed; core 2: 0 busy of 200 → 25 % of 2 cores
        let now = [core(200.0, 200.0), core(100.0, 300.0)];
        assert!((busy_cores_between(&prev, &now) - 0.5).abs() < 1e-9);
        assert_eq!(busy_cores_between(&now, &now), 0.0);
    }

    #[test]
    fn busy_cores_is_a_finite_non_negative_number_on_every_os() {
        for _ in 0..2 {
            let b = busy_cores();
            assert!(b >= 0.0 && b.is_finite(), "{b}");
        }
    }

    #[test]
    fn vm_stat_parse() {
        let out = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                   Pages free:                               1000.\n\
                   Pages active:                             5.\n\
                   Pages inactive:                           200.\n\
                   Pages speculative:                        30.\n\
                   Pages throttled:                          0.\n\
                   Pages purgeable:                          4.\n";
        assert_eq!(parse_vm_stat_available_bytes(out), Some(1234 * 16384));
        assert_eq!(parse_vm_stat_available_bytes("garbage"), None);
        assert_eq!(
            parse_vm_stat_available_bytes("(page size of 4096 bytes)\nPages free: 1.\n"),
            None
        );
    }

    #[test]
    fn available_memory_is_positive() {
        assert!(available_mem_bytes() > 0);
    }
}
