//! MR-T01 FR-3: kill a whole process tree. `cmd /c` → `node` (parent) → `node` (child, exits) →
//! `node` (grandchild, detached, reparented): fixtures/tree.mjs.
//!
//! Windows (asserted): the tree runs in a kill-on-close Job Object (`windows-sys`). Variants:
//!   a. TerminateJobObject
//!   b. CloseHandle(job), kill-on-close
//!   c. the job's owner crashes (a `--holder` subprocess is TerminateProcess'd), so the OS closes
//!      the handle: the daemon-crash case
//!   d. control, no job: `taskkill /T /F` (today's TS kill, TD-189). Informational only.
//! Any survivor in a–c fails the run.
//!
//! Unix (informational): the TS daemon's process-group kill. The detached grandchild calls setsid,
//! so it is expected to escape; reported, then cleaned up by pid.
//! Throwaway spike code: never shipped.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};

#[derive(Debug, Clone, Copy)]
struct Pids {
    parent: u32,
    grandchild: u32,
}

fn tree_script() -> PathBuf {
    std::env::var_os("TREE_MJS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/tree.mjs"))
}

fn read_pid(dir: &Path, name: &str) -> Option<u32> {
    std::fs::read_to_string(dir.join(name))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Wait (≤ 15 s) until the tree is up and the child has exited (the grandchild is reparented).
fn wait_tree(dir: &Path) -> Result<Pids> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let (Some(parent), Some(grandchild), true) = (
            read_pid(dir, "parent.pid"),
            read_pid(dir, "grandchild.pid"),
            dir.join("child.exited").exists(),
        ) {
            return Ok(Pids { parent, grandchild });
        }
        if Instant::now() > deadline {
            bail!(
                "the tree did not come up within 15 s (pid dir {})",
                dir.display()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    {
        if args.get(1).map(String::as_str) == Some("--holder") {
            return win::holder(Path::new(&args[2]));
        }
        win::run()
    }
    #[cfg(unix)]
    {
        let _ = args;
        unix::run()
    }
}

// ================================================================== Windows

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::OsStr;
    use std::io::{BufRead, BufReader};
    use std::os::windows::ffi::OsStrExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, OpenProcess,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE, ResumeThread, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn last_error() -> std::io::Error {
        std::io::Error::last_os_error()
    }

    /// An owned process handle.
    struct Proc {
        name: &'static str,
        pid: u32,
        h: HANDLE,
    }

    impl Drop for Proc {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.h) };
        }
    }

    impl Proc {
        /// Opened BEFORE the kill: waiting on the handle is immune to pid reuse.
        fn open(name: &'static str, pid: u32) -> Result<Self> {
            let h = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                    0,
                    pid,
                )
            };
            if h.is_null() {
                bail!("OpenProcess({name} {pid}): {}", last_error());
            }
            Ok(Self { name, pid, h })
        }

        fn alive(&self) -> bool {
            let mut code = 0u32;
            unsafe { GetExitCodeProcess(self.h, &mut code) != 0 && code == STILL_ACTIVE as u32 }
        }

        fn in_job(&self, job: HANDLE) -> bool {
            let mut r = 0;
            unsafe { IsProcessInJob(self.h, job, &mut r) != 0 && r != 0 }
        }
    }

    struct Job(HANDLE);

    impl Job {
        fn kill_on_close() -> Result<Self> {
            let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if h.is_null() {
                bail!("CreateJobObjectW: {}", last_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                let e = last_error();
                unsafe { CloseHandle(h) };
                bail!("SetInformationJobObject: {e}");
            }
            Ok(Self(h))
        }

        fn close(self) {
            unsafe { CloseHandle(self.0) };
            std::mem::forget(self);
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// `cmd.exe /d /s /c "node "<tree.mjs>" parent "<dir>""`: with /s cmd strips only the outer
    /// quotes, so the inner ones survive.
    fn tree_cmdline(dir: &Path) -> String {
        format!(
            "cmd.exe /d /s /c \"node \"{}\" parent \"{}\"\"",
            tree_script().display(),
            dir.display()
        )
    }

    /// Start the tree inside `job`: CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread, so
    /// cmd can't spawn node before it is in the job.
    fn start_in_job(job: &Job, dir: &Path) -> Result<Proc> {
        let mut cmdline = wide(&tree_cmdline(dir));
        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut pi = PROCESS_INFORMATION::default();
        let ok = unsafe {
            CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                std::ptr::null(),
                std::ptr::null(),
                &si,
                &mut pi,
            )
        };
        if ok == 0 {
            bail!("CreateProcessW: {}", last_error());
        }
        let cmd = Proc {
            name: "cmd",
            pid: pi.dwProcessId,
            h: pi.hProcess,
        };
        unsafe {
            if AssignProcessToJobObject(job.0, pi.hProcess) == 0 {
                let e = last_error();
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                bail!("AssignProcessToJobObject: {e}");
            }
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
        }
        Ok(cmd)
    }

    fn tasklist(pid: u32) -> String {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default()
    }

    /// Wait ≤ 5 s for every process to exit. Survivors are listed, killed, and returned.
    fn survivors(procs: &[Proc]) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut left = vec![];
        for p in procs {
            let ms = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u32;
            let r = unsafe { WaitForSingleObject(p.h, ms) };
            if r == WAIT_OBJECT_0 {
                println!("    {:<10} pid {:>6}: gone", p.name, p.pid);
            } else {
                println!(
                    "    {:<10} pid {:>6}: SURVIVED  tasklist: {}",
                    p.name,
                    p.pid,
                    tasklist(p.pid)
                );
                unsafe { TerminateProcess(p.h, 1) };
                left.push(p.pid);
            }
        }
        left
    }

    fn open_tree(cmd: Proc, pids: Pids, job: Option<HANDLE>) -> Result<Vec<Proc>> {
        let procs = vec![
            cmd,
            Proc::open("parent", pids.parent)?,
            Proc::open("grandchild", pids.grandchild)?,
        ];
        for p in &procs {
            let job_note = job
                .map(|j| format!(", in job: {}", p.in_job(j)))
                .unwrap_or_default();
            println!(
                "    {:<10} pid {:>6}: alive {}{job_note}",
                p.name,
                p.pid,
                p.alive()
            );
            if !p.alive() {
                bail!("{} {} is not alive before the kill", p.name, p.pid);
            }
            if let Some(j) = job
                && !p.in_job(j)
            {
                bail!("{} {} is not in the job", p.name, p.pid);
            }
        }
        Ok(procs)
    }

    fn variant(name: &str, kill: impl FnOnce(Job)) -> Result<bool> {
        println!("== {name}");
        let dir = tempfile::tempdir()?;
        let job = Job::kill_on_close()?;
        let cmd = start_in_job(&job, dir.path())?;
        let pids = wait_tree(dir.path())?;
        let procs = open_tree(cmd, pids, Some(job.0))?;
        let t = Instant::now();
        kill(job);
        let left = survivors(&procs);
        println!(
            "  {name}: {} ({} ms)",
            if left.is_empty() {
                "PASS, no survivor"
            } else {
                "FAIL"
            },
            t.elapsed().as_millis()
        );
        Ok(left.is_empty())
    }

    /// Variant c's job owner: build the job and tree, report the pids, then wait to be killed.
    pub fn holder(dir: &Path) -> Result<()> {
        let job = Job::kill_on_close()?;
        let cmd = start_in_job(&job, dir)?;
        let pids = wait_tree(dir)?;
        println!("READY {} {} {}", cmd.pid, pids.parent, pids.grandchild);
        std::mem::forget(cmd);
        std::mem::forget(job); // only the OS closes it: when this process dies
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    fn variant_owner_crash() -> Result<bool> {
        let name = "c. job owner crashes (TerminateProcess of the holder)";
        println!("== {name}");
        let dir = tempfile::tempdir()?;
        let mut holder = Command::new(std::env::current_exe()?)
            .arg("--holder")
            .arg(dir.path())
            .stdout(Stdio::piped())
            .spawn()?;
        let mut line = String::new();
        BufReader::new(holder.stdout.take().unwrap()).read_line(&mut line)?;
        let p: Vec<u32> = line
            .strip_prefix("READY ")
            .unwrap_or("")
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        if p.len() != 3 {
            let _ = holder.kill();
            bail!("holder said {line:?}");
        }
        let procs = vec![
            Proc::open("cmd", p[0])?,
            Proc::open("parent", p[1])?,
            Proc::open("grandchild", p[2])?,
        ];
        for q in &procs {
            println!("    {:<10} pid {:>6}: alive {}", q.name, q.pid, q.alive());
        }
        let t = Instant::now();
        holder.kill()?; // TerminateProcess: no cleanup code runs in the holder
        holder.wait()?;
        let left = survivors(&procs);
        println!(
            "  {name}: {} ({} ms)",
            if left.is_empty() {
                "PASS, no survivor"
            } else {
                "FAIL"
            },
            t.elapsed().as_millis()
        );
        Ok(left.is_empty())
    }

    /// d. No job: today's TS kill (`taskkill /T /F /PID <cmd>`). Informational.
    fn control_taskkill() -> Result<()> {
        println!("== d. control: no job, taskkill /T /F (TD-189), informational");
        let dir = tempfile::tempdir()?;
        let mut cmd = Command::new("cmd.exe")
            .args(["/d", "/c", "node"])
            .arg(tree_script())
            .arg("parent")
            .arg(dir.path())
            .spawn()?;
        let pids = wait_tree(dir.path())?;
        let procs = vec![
            Proc::open("parent", pids.parent)?,
            Proc::open("grandchild", pids.grandchild)?,
        ];
        let out = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &cmd.id().to_string()])
            .output()?;
        println!(
            "    taskkill exit {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stdout).trim()
        );
        let _ = cmd.wait();
        let left = survivors(&procs);
        println!(
            "  d: {}",
            if left.is_empty() {
                "no survivor".to_owned()
            } else {
                format!("survivors {left:?} (expected: the reparented grandchild; killed now)")
            }
        );
        Ok(())
    }

    pub fn run() -> Result<()> {
        let mut r = 0;
        let self_in_job = unsafe {
            IsProcessInJob(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                std::ptr::null_mut(),
                &mut r,
            ) != 0
                && r != 0
        };
        println!(
            "job-probe (windows): this process already in a job: {self_in_job} (nested jobs: Win 8+)"
        );
        let a = variant("a. TerminateJobObject", |job| unsafe {
            TerminateJobObject(job.0, 1);
        })?;
        let b = variant("b. CloseHandle(job), kill-on-close", Job::close)?;
        let c = variant_owner_crash()?;
        if let Err(e) = control_taskkill() {
            println!("  d: control failed to run: {e:#}");
        }
        if a && b && c {
            println!("job-probe: PASS (a, b, c: no survivor)");
            Ok(())
        } else {
            println!("job-probe: FAIL (a={a} b={b} c={c})");
            std::process::exit(1);
        }
    }
}

// ================================================================== Unix

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    fn alive(pid: u32) -> bool {
        // A zombie still answers kill(0) until it is reaped; read its state where /proc exists.
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            return !stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z'));
        }
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    pub fn run() -> Result<()> {
        println!("job-probe (unix, informational): process-group kill, as the TS daemon does");
        let dir = tempfile::tempdir()?;
        let mut parent = Command::new("node")
            .arg(tree_script())
            .arg("parent")
            .arg(dir.path())
            .process_group(0)
            .spawn()?;
        let pids = wait_tree(dir.path())?;
        println!(
            "    parent pid {} (group leader), grandchild pid {} (setsid)",
            pids.parent, pids.grandchild
        );
        unsafe { libc::killpg(parent.id() as i32, libc::SIGKILL) };
        parent.wait()?;
        std::thread::sleep(Duration::from_millis(500));
        let p = alive(pids.parent);
        let g = alive(pids.grandchild);
        println!("    parent alive after killpg: {p}");
        println!("    grandchild alive after killpg: {g} (expected true: setsid left the group)");
        if g {
            unsafe { libc::kill(pids.grandchild as i32, libc::SIGKILL) };
        }
        if p {
            bail!("the process-group kill missed the parent");
        }
        println!("job-probe: unix contrast done (not asserted beyond the parent)");
        Ok(())
    }
}
