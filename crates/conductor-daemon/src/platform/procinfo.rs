//! Port of `packages/daemon/src/platform/procinfo.ts` (MR-T04). ADR-0024 §1: the start time and
//! command line of a live pid, for the orphan sweep (BUG-1b, 10-contracts §Orphaned processes
//! rule 7). The start time defeats pid reuse, which is fast on Windows, so it is read from the same
//! process as the command line.
//!
//! POSIX: `ps -ww -o lstart= -o command= -p <pid>` (LC_ALL=C, TZ=UTC), exactly as the TS daemon.
//! `argv` is the command line split on whitespace, the same lossy view `checkOurs` used.
//! Windows: native calls on one process handle, no PowerShell (ADR-0026): `GetProcessTimes` for
//! the start, `NtQueryInformationProcess(ProcessCommandLineInformation)` for the command line
//! (split with CommandLineToArgvW rules), `QueryFullProcessImageNameW` for the image path.

use super::{Platform, win_path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    /// Process start, ms since the epoch (POSIX: 1 s precision; Windows: 1 ms).
    pub started_at_ms: i64,
    /// The raw command line.
    pub command: String,
    /// The command line split into arguments (see the header for how exact that is per OS).
    pub argv: Vec<String>,
    /// Windows only: the image path.
    pub executable_path: Option<String>,
}

// ---------------------------------------------------------------- POSIX (as orphan.ts)

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Days from 1970-01-01 to the civil date `y-m-d` (proleptic Gregorian, `m` 1-based).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.UTC(y, month0, d, h, mi, s)` in ms.
pub(crate) fn utc_ms(y: i64, month0: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    // Date.UTC lets the month overflow into the year; the parsers here never pass one that does.
    (days_from_civil(y, month0 + 1, d) * 86_400 + h * 3600 + mi * 60 + s) * 1000
}

/// A cursor over a `ps` line, matching the TS LSTART regex piece by piece:
/// `^\s*[A-Za-z]{3}\s+(?:([A-Za-z]{3})\s+(\d{1,2})|(\d{1,2})\s+([A-Za-z]{3}))\s+(\d{1,2}):(\d\d):(\d\d)\s+(\d{4})`
struct Cur<'a> {
    s: &'a [u8],
    i: usize,
}

impl Cur<'_> {
    fn ws(&mut self, at_least_one: bool) -> Option<()> {
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
        (!at_least_one || self.i > start).then_some(())
    }
    fn alpha3(&mut self) -> Option<&str> {
        let w = self.s.get(self.i..self.i + 3)?;
        if !w.iter().all(u8::is_ascii_alphabetic) {
            return None;
        }
        self.i += 3;
        std::str::from_utf8(w).ok()
    }
    /// Between `min` and `max` digits (greedy, as the regex then needs a non-digit).
    fn digits(&mut self, min: usize, max: usize) -> Option<i64> {
        let start = self.i;
        while self.i < self.s.len() && self.i - start < max && self.s[self.i].is_ascii_digit() {
            self.i += 1;
        }
        if self.i - start < min {
            return None;
        }
        std::str::from_utf8(&self.s[start..self.i])
            .ok()?
            .parse()
            .ok()
    }
    fn byte(&mut self, b: u8) -> Option<()> {
        (self.s.get(self.i) == Some(&b)).then(|| self.i += 1)
    }
}

/// Parse one `ps -o lstart= -o command=` line (lstart printed in UTC). Pure. `ps -o lstart`
/// (LC_ALL=C) prints `Tue Oct 27 10:11:12 2026`, the day space-padded; some locales put the day
/// before the month (`Tue 27 Oct …`): both are accepted.
pub fn parse_ps_line(line: &str) -> Option<ProcInfo> {
    let mut c = Cur {
        s: line.as_bytes(),
        i: 0,
    };
    c.ws(false)?;
    c.alpha3()?;
    c.ws(true)?;
    let save = c.i;
    let (month, day) = match (|| {
        let m = c.alpha3()?.to_string();
        c.ws(true)?;
        Some((m, c.digits(1, 2)?))
    })() {
        Some(v) => v,
        None => {
            c.i = save;
            let d = c.digits(1, 2)?;
            c.ws(true)?;
            (c.alpha3()?.to_string(), d)
        }
    };
    c.ws(true)?;
    let h = c.digits(1, 2)?;
    c.byte(b':')?;
    let mi = c.digits(2, 2)?;
    c.byte(b':')?;
    let s = c.digits(2, 2)?;
    c.ws(true)?;
    let y = c.digits(4, 4)?;
    let month0 = MONTHS.iter().position(|m| *m == month)? as i64;
    let command = line[c.i..].trim().to_string();
    let argv = if command.is_empty() {
        Vec::new()
    } else {
        command.split_whitespace().map(str::to_string).collect()
    };
    Some(ProcInfo {
        started_at_ms: utc_ms(y, month0, day, h, mi, s),
        command,
        argv,
        executable_path: None,
    })
}

// ---------------------------------------------------------------- Windows

/// Split a Windows command line the way `CommandLineToArgvW` does (Wine's implementation of it,
/// which matches Windows):
/// - argv[0] is special: if it starts with `"` it runs to the next `"` (no escapes), otherwise to
///   the first space or tab;
/// - later arguments are separated by spaces/tabs outside quotes;
/// - 2n backslashes + `"` → n backslashes and the quote toggles quoting; 2n+1 backslashes + `"` →
///   n backslashes and a literal `"`; other backslashes are literal;
/// - a run of quotes counts towards 3: every third quote is a literal `"` and the run ends quoting
///   if the count is then 0 or 2 (so `""` inside quotes is a literal `"` and ends them).
///
/// Pure.
pub fn parse_windows_command_line(cmdline: &str) -> Vec<String> {
    let s: Vec<char> = cmdline.chars().collect();
    let at = |i: usize| s.get(i).copied();
    let mut out = Vec::new();
    let mut i = 0;
    let mut arg0 = String::new();
    if at(0) == Some('"') {
        i = 1;
        while i < s.len() && s[i] != '"' {
            arg0.push(s[i]);
            i += 1;
        }
        if i < s.len() {
            i += 1;
        }
    } else {
        while i < s.len() && s[i] != ' ' && s[i] != '\t' {
            arg0.push(s[i]);
            i += 1;
        }
    }
    out.push(arg0);
    while matches!(at(i), Some(' ' | '\t')) {
        i += 1;
    }

    let mut cur: Vec<char> = Vec::new();
    let mut in_arg = false;
    let mut qcount = 0;
    let mut bcount = 0;
    while i < s.len() {
        let c = s[i];
        if (c == ' ' || c == '\t') && qcount == 0 {
            if in_arg {
                out.push(cur.iter().collect());
            }
            cur.clear();
            in_arg = false;
            bcount = 0;
            i += 1;
            continue;
        }
        in_arg = true;
        if c == '\\' {
            cur.push(c);
            bcount += 1;
            i += 1;
            continue;
        }
        if c == '"' {
            if bcount % 2 == 0 {
                cur.truncate(cur.len() - bcount / 2);
                qcount += 1;
            } else {
                cur.truncate(cur.len() - bcount.div_ceil(2));
                cur.push('"');
            }
            i += 1;
            bcount = 0;
            while at(i) == Some('"') {
                qcount += 1;
                if qcount == 3 {
                    cur.push('"');
                    qcount = 0;
                }
                i += 1;
            }
            if qcount == 2 {
                qcount = 0;
            }
            continue;
        }
        cur.push(c);
        bcount = 0;
        i += 1;
    }
    if in_arg {
        out.push(cur.iter().collect());
    }
    out
}

/// The start time and command line of a pid, read from one process (so both describe the same
/// one), or None when it is gone, unreadable, or `pid` is 0.
pub fn read_proc_info(pid: u32) -> Option<ProcInfo> {
    if pid == 0 {
        return None;
    }
    imp::read(pid)
}

/// The comparable name of an executable: its basename, and on Windows also lower-cased without an
/// `.exe`/`.cmd`/`.bat`/`.com` extension (`C:\…\Claude.EXE` → `claude`).
pub fn exe_name(path: &str, platform: Platform) -> String {
    match platform {
        Platform::Posix => path.rsplit('/').next().unwrap_or(path).to_string(),
        Platform::Windows => strip_exe_ext(win_path::basename(path)).to_lowercase(),
    }
}

fn strip_exe_ext(p: &str) -> &str {
    let lower = p.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if lower.ends_with(ext) {
            return &p[..p.len() - ext.len()];
        }
    }
    p
}

/// Same executable path: exact on POSIX; case- and extension-insensitive on Windows.
pub fn same_executable(a: &str, b: &str, platform: Platform) -> bool {
    match platform {
        Platform::Posix => a == b,
        Platform::Windows => {
            let norm = |p: &str| strip_exe_ext(&win_path::normalize(p)).to_lowercase();
            norm(a) == norm(b)
        }
    }
}

#[cfg(unix)]
mod imp {
    use super::{ProcInfo, parse_ps_line};
    use std::process::{Command, Stdio};

    pub fn read(pid: u32) -> Option<ProcInfo> {
        let out = Command::new("ps")
            .args([
                "-ww",
                "-o",
                "lstart=",
                "-o",
                "command=",
                "-p",
                &pid.to_string(),
            ])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_ps_line(String::from_utf8_lossy(&out.stdout).trim())
    }
}

#[cfg(windows)]
mod imp {
    use super::{ProcInfo, parse_windows_command_line};
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HANDLE, UNICODE_STRING, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, WaitForSingleObject,
    };

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: a handle we opened and own.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// FILETIME (100 ns since 1601) → ms since the epoch, truncated.
    fn filetime_ms(f: FILETIME) -> i64 {
        let t = (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime);
        (t / 10_000) as i64 - 11_644_473_600_000
    }

    fn command_line(h: HANDLE) -> Option<String> {
        let mut len: u32 = 0;
        // SAFETY: a size query with a null buffer; the call reports the size it needs.
        unsafe {
            NtQueryInformationProcess(
                h,
                ProcessCommandLineInformation,
                std::ptr::null_mut(),
                0,
                &mut len,
            )
        };
        if len == 0 {
            return None;
        }
        // u64-aligned, as the UNICODE_STRING header at its start needs.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: the buffer holds `len` bytes; NTSTATUS < 0 is a failure.
        let st = unsafe {
            NtQueryInformationProcess(
                h,
                ProcessCommandLineInformation,
                buf.as_mut_ptr().cast(),
                len,
                &mut len,
            )
        };
        if st < 0 {
            return None;
        }
        // SAFETY: on success the buffer starts with a UNICODE_STRING whose Buffer points into it.
        unsafe {
            let us = &*(buf.as_ptr() as *const UNICODE_STRING);
            if us.Buffer.is_null() {
                return Some(String::new());
            }
            let chars = std::slice::from_raw_parts(us.Buffer, us.Length as usize / 2);
            Some(String::from_utf16_lossy(chars))
        }
    }

    fn image_path(h: HANDLE) -> Option<String> {
        let mut buf = vec![0u16; 32_768];
        let mut size = buf.len() as u32;
        // SAFETY: the buffer holds `size` UTF-16 units.
        let ok = unsafe {
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size)
        };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..size as usize]))
    }

    pub fn read(pid: u32) -> Option<ProcInfo> {
        // SAFETY: plain Win32 calls on a handle owned by `Handle`.
        unsafe {
            let h = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            if h.is_null() {
                return None; // gone, or another user's process: unreadable
            }
            let h = Handle(h);
            // A dead process stays openable while anyone (our own Child) holds a handle to it.
            if WaitForSingleObject(h.0, 0) != WAIT_TIMEOUT {
                return None;
            }
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            if GetProcessTimes(h.0, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
                return None;
            }
            let command = command_line(h.0)?;
            Some(ProcInfo {
                started_at_ms: filetime_ms(created),
                argv: parse_windows_command_line(&command),
                command,
                executable_path: image_path(h.0),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn t() -> i64 {
        utc_ms(2026, 9, 27, 10, 11, 12)
    }

    #[test]
    fn parse_ps_line_parses_lstart_utc_and_the_command() {
        assert_eq!(
            parse_ps_line("Tue Oct 27 10:11:12 2026 /usr/bin/claude --resume x"),
            Some(ProcInfo {
                started_at_ms: t(),
                command: "/usr/bin/claude --resume x".into(),
                argv: vec!["/usr/bin/claude".into(), "--resume".into(), "x".into()],
                executable_path: None,
            })
        );
        assert_eq!(
            parse_ps_line("Wed Oct  7 01:02:03 2026 node").map(|p| p.started_at_ms),
            Some(utc_ms(2026, 9, 7, 1, 2, 3))
        );
        assert_eq!(
            parse_ps_line("Tue 27 Oct 10:11:12 2026"),
            Some(ProcInfo {
                started_at_ms: t(),
                command: String::new(),
                argv: vec![],
                executable_path: None
            })
        );
        // 2026-10-27T10:11:12Z
        assert_eq!(t(), 1_793_095_872_000);
    }

    #[test]
    fn parse_ps_line_returns_none_for_anything_else() {
        assert_eq!(parse_ps_line(""), None);
        assert_eq!(parse_ps_line("yesterday"), None);
        assert_eq!(parse_ps_line("Tue Foo 27 10:11:12 2026"), None);
    }

    #[test]
    fn parse_windows_command_line_cases() {
        let cases: &[(&str, &[&str])] = &[
            (
                "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\b\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" --session-id 3c1f --print",
                &[
                    "C:\\Program Files\\nodejs\\node.exe",
                    "C:\\Users\\b\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
                    "--session-id",
                    "3c1f",
                    "--print",
                ],
            ),
            (
                "C:\\bin\\claude.exe --resume abc",
                &["C:\\bin\\claude.exe", "--resume", "abc"],
            ),
            ("\"C:\\a\\\"b c", &["C:\\a\\", "b", "c"]),
            ("\"C:\\x y\\a.exe\"rest b", &["C:\\x y\\a.exe", "rest", "b"]),
            ("p \"abc\" d e", &["p", "abc", "d", "e"]),
            ("p a\\\\\\b d\"e f\"g h", &["p", "a\\\\\\b", "de fg", "h"]),
            ("p a\\\\\\\"b c d", &["p", "a\\\"b", "c", "d"]),
            ("p a\\\\\\\\\"b c\" d e", &["p", "a\\\\b c", "d", "e"]),
            ("p \"a\"\"b\"", &["p", "a\"b"]),
            ("p \"a\"\"b c\"", &["p", "a\"b", "c"]),
            ("p \"\"\"a b\"\"\"", &["p", "\"a", "b\""]),
            ("p \"\" x", &["p", "", "x"]),
            ("p a\"\" b", &["p", "a", "b"]),
            ("p\t a\t\tb  ", &["p", "a", "b"]),
            ("p \"trailing\\\\\"", &["p", "trailing\\"]),
            ("p \"unterminated arg", &["p", "unterminated arg"]),
            ("p", &["p"]),
            ("", &[""]),
        ];
        for (line, argv) in cases {
            assert_eq!(parse_windows_command_line(line), *argv, "{line:?}");
        }
    }

    #[test]
    fn exe_names_and_same_executable() {
        assert_eq!(exe_name("C:\\x\\Claude.EXE", Platform::Windows), "claude");
        assert_eq!(exe_name("/usr/bin/claude", Platform::Posix), "claude");
        assert!(same_executable(
            "C:/x/Claude.exe",
            "c:\\x\\claude",
            Platform::Windows
        ));
        assert!(!same_executable("/a/claude", "/b/claude", Platform::Posix));
        assert!(same_executable(
            "/a b/claude",
            "/a b/claude",
            Platform::Posix
        ));
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn node() -> String {
        super::super::spawn::tests_support::node_bin()
    }

    #[test]
    fn read_proc_info_reads_a_spawned_child_then_none_once_dead() {
        let before = now_ms();
        let mut child = std::process::Command::new(node())
            .args([
                "-e",
                "setInterval(()=>{},1000)",
                "conductor-procinfo-marker",
                "second",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let info = read_proc_info(pid);
        let result = std::panic::catch_unwind(|| {
            let info = info.expect("a live child is readable");
            // POSIX lstart has 1 s precision (truncated); Windows has sub-ms.
            assert!(
                info.started_at_ms >= before / 1000 * 1000 - 2_000,
                "{info:?}"
            );
            assert!(info.started_at_ms <= now_ms() + 2_000);
            assert_eq!(
                info.argv[info.argv.len() - 2..],
                ["conductor-procinfo-marker", "second"]
            );
            assert!(info.command.contains("conductor-procinfo-marker"));
            if cfg!(windows) {
                let exe = info.executable_path.clone().unwrap().to_lowercase();
                assert!(exe.ends_with("node.exe"), "{exe}");
            }
            // Stable across reads (the orphan check compares it for equality).
            assert_eq!(
                read_proc_info(pid).map(|i| i.started_at_ms),
                Some(info.started_at_ms)
            );
        });
        child.kill().unwrap();
        child.wait().unwrap();
        // Still holding the Child (and, on Windows, its handle): a dead process reads as gone.
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(read_proc_info(pid), None);
        drop(child);
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn read_proc_info_none_for_a_missing_or_invalid_pid() {
        assert_eq!(read_proc_info((1 << 22) + 12345), None);
        assert_eq!(read_proc_info(0), None);
        assert_eq!(read_proc_info(u32::MAX), None);
    }
}
