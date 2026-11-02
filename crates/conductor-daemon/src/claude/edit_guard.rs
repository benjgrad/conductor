//! Port of `packages/daemon/src/claude/edit-guard.ts` (MR-T08).
//!
//! ADR-0006: agents inherit the user's Claude Code settings (permission mode, rules, hooks), so a
//! permission rule can no longer keep file edits inside the worktree: `Edit(./**)` only
//! pre-approves, and a deny rule cannot carve the worktree out of "everywhere". This PreToolUse
//! hook can: it runs before permission rules in every mode (bypassPermissions included) and exit
//! code 2 blocks the call. Bash is not covered (U-004).
//!
//! ADR-0026: the hook is the daemon's own executable, `conductor-daemon hook edit-guard
//! <worktree>` (no Node, no script file). [`run_edit_guard_hook`] is that subcommand's body; `main`
//! dispatches to it.
//!
//! The rules, as the TS `edit-guard.mjs`: read the PreToolUse JSON on stdin and exit 2 (block,
//! reason on stderr) unless every target path is inside the worktree. Fails closed: any error, a
//! missing or relative path, or unreadable input blocks. `~`/`~/` expand to the home directory as
//! Claude Code does. POSIX paths are resolved component by component with lstat/readlink, so a
//! symlink (a dangling one too) and a `..` after it go where the kernel would, not where the text
//! says.
//!
//! Windows (ADR-0024 §6): `.`/`..` are normalised textually first, as the Win32 layer does before
//! the file system sees the path. A path must start with a drive letter (`C:\` or `C:/`); UNC and
//! device paths (`\\host\`, `//host/`, `\\?\`, `\\.\`, `\??\`), root- and drive-relative paths and
//! any `:` after the drive (alternate data streams) are refused. Each existing component is
//! canonicalised (8.3 short names expanded, junctions followed: U-107); the comparison is per
//! drive and case-insensitive. `~\` expands like `~/`.
//!
//! The path logic is plain string code over a [`GuardFs`], so both OSes' rules are tested
//! everywhere; only [`StdFs`] touches the disk.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::claude::transcript::{realpath, strip_verbatim};
use crate::platform::fs::{is_reparse_point, resolve_for};
use crate::platform::{Platform, hook_command, win_path, write_private_file};

/// The file tools the hook checks.
pub const EDIT_GUARD_MATCHER: &str = "Edit|Write|MultiEdit|NotebookEdit";

/// The `hook` subcommand words before the worktree.
pub const EDIT_GUARD_SUBCOMMAND: [&str; 2] = ["hook", "edit-guard"];

/// The `--settings` JSON that registers the hook for `worktree`. `disableAllHooks: false` is
/// pinned: the flag scope outranks user settings, so the user's own `disableAllHooks` can't switch
/// the guard off (verified against claude 2.1.309). `CLAUDE_CODE_SAFE_MODE=1` also drops non-policy
/// hooks, so the flag-scope `env` pins it to "0". `|| exit 2` makes a missing executable block
/// instead of passing (only exit 2 blocks). The command is quoted for sh (POSIX) or for cmd.exe and
/// Git Bash alike (Windows, `platform::hook`; errs for a path it can't carry).
pub fn edit_guard_settings(exe: &Path, worktree: &Path) -> Result<Value, String> {
    let argv = [
        exe.to_string_lossy().into_owned(),
        EDIT_GUARD_SUBCOMMAND[0].to_string(),
        EDIT_GUARD_SUBCOMMAND[1].to_string(),
        worktree.to_string_lossy().into_owned(),
    ];
    let command = hook_command(&argv)?;
    Ok(json!({
        "disableAllHooks": false,
        "env": { "CLAUDE_CODE_SAFE_MODE": "0" },
        "hooks": {
            "PreToolUse": [{
                "matcher": EDIT_GUARD_MATCHER,
                "hooks": [{ "type": "command", "command": command }],
            }],
        },
    }))
}

/// Write the settings file into `dir` (the session's private directory, removed with it) and
/// return its path for `--settings`. `exe` defaults to this executable.
/// TD-083: same uid as the agent, so its Bash could rewrite the settings.
pub fn write_edit_guard(
    dir: &Path,
    worktree: &Path,
    exe: Option<&Path>,
) -> Result<PathBuf, String> {
    let exe = match exe {
        Some(e) => e.to_path_buf(),
        None => std::env::current_exe().map_err(|e| format!("edit guard: {e}"))?,
    };
    // Built first: a path the hook can't carry (Windows) fails before anything is written.
    let settings = edit_guard_settings(&exe, worktree)?;
    let path = dir.join("settings.json");
    write_private_file(&path, settings.to_string().as_bytes())
        .map_err(|e| format!("edit guard: {e}"))?;
    Ok(path)
}

/// What an lstat says about a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Missing,
    /// A symlink, a junction or another reparse point.
    Link,
    Other,
}

/// The file-system facts the guard reads (a fake in tests).
pub trait GuardFs {
    fn lstat(&self, path: &str) -> EntryKind;
    fn read_link(&self, path: &str) -> io::Result<String>;
    /// The canonical path (links followed; Windows: 8.3 names expanded), without `\\?\`.
    fn realpath(&self, path: &str) -> io::Result<String>;
    fn home_dir(&self) -> Option<String>;
    fn cwd(&self) -> String;
}

/// The real file system.
pub struct StdFs;

impl GuardFs for StdFs {
    fn lstat(&self, path: &str) -> EntryKind {
        match std::fs::symlink_metadata(path) {
            Err(_) => EntryKind::Missing,
            Ok(m) if m.file_type().is_symlink() || is_reparse_point(&m) => EntryKind::Link,
            Ok(_) => EntryKind::Other,
        }
    }

    fn read_link(&self, path: &str) -> io::Result<String> {
        std::fs::read_link(path).map(|p| strip_verbatim(&p.to_string_lossy()))
    }

    fn realpath(&self, path: &str) -> io::Result<String> {
        realpath(Path::new(path)).map(|p| p.to_string_lossy().into_owned())
    }

    fn home_dir(&self) -> Option<String> {
        std::env::home_dir().map(|p| p.to_string_lossy().into_owned())
    }

    fn cwd(&self) -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// A refusal: the text after `conductor: `.
type Deny = String;

fn failed(e: impl std::fmt::Display) -> Deny {
    format!("edit guard failed, so the edit is blocked: {e}")
}

const MAX_LINK_DEPTH: u32 = 40;

fn posix_dirname(p: &str) -> String {
    match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    }
}

fn posix_join(dir: &str, part: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{part}")
    } else {
        format!("{dir}/{part}")
    }
}

fn posix_canon(p: &str, fs: &dyn GuardFs, depth: u32) -> Result<String, Deny> {
    if depth > MAX_LINK_DEPTH {
        return Err(format!("too many levels of symlinks: {p}"));
    }
    let mut cur = "/".to_string();
    for part in p.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                cur = posix_dirname(&cur);
                continue;
            }
            _ => {}
        }
        let next = posix_join(&cur, part);
        cur = if fs.lstat(&next) == EntryKind::Link {
            let target = fs.read_link(&next).map_err(failed)?;
            posix_canon(&resolve_for(Platform::Posix, &cur, &target), fs, depth + 1)?
        } else {
            next
        };
    }
    Ok(cur)
}

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// `path.win32.dirname` for a canonical `C:\…` path.
fn win_dirname(p: &str) -> String {
    let t = p.trim_end_matches(is_sep);
    match t.rfind(is_sep) {
        Some(i) if i > 2 => t[..i].to_string(),
        _ => format!("{}\\", &p[..2.min(p.len())]),
    }
}

fn win_canon(raw: &str, fs: &dyn GuardFs, depth: u32) -> Result<String, Deny> {
    if depth > MAX_LINK_DEPTH {
        return Err(format!("too many levels of symlinks: {raw}"));
    }
    let mut chars = raw.chars();
    let (c0, c1, c2) = (chars.next(), chars.next(), chars.next());
    let c3 = chars.next();
    if c0.is_some_and(is_sep) && c1.is_some_and(is_sep) {
        return Err(format!("UNC and device paths are refused: {raw}"));
    }
    if c0.is_some_and(is_sep) && c1 == Some('?') && c2 == Some('?') && c3.is_some_and(is_sep) {
        return Err(format!("NT object paths are refused: {raw}"));
    }
    if !(c0.is_some_and(|c| c.is_ascii_alphabetic()) && c1 == Some(':') && c2.is_some_and(is_sep)) {
        return Err(format!(
            "file paths must start with a drive letter (C:\\...); refused {raw}"
        ));
    }
    // Win32 strips trailing dots and spaces from a component ('.. ' is '..'), which textual
    // resolution would read as a literal name: refuse such components rather than model it.
    for part in raw[3..].split(is_sep).filter(|p| !p.is_empty()) {
        if part != "." && part != ".." && (part.ends_with('.') || part.ends_with(' ')) {
            return Err(format!(
                "path components ending in a dot or space are refused: {raw}"
            ));
        }
    }
    // Win32 normalises '.' and '..' textually before the file system follows any link, so do the
    // same first: C:\wt\link\..\..\x is C:\x whatever 'link' points at.
    let p = win_path::resolve("", raw);
    let mut cur = format!("{}\\", p[..2].to_ascii_uppercase());
    for part in p.get(3..).unwrap_or("").split(is_sep) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part.contains(':') {
            return Err(format!("alternate data streams are refused: {p}"));
        }
        if part == ".." {
            cur = win_dirname(&cur);
            continue;
        }
        let next = win_path::join(&[&cur, part]);
        cur = match fs.lstat(&next) {
            EntryKind::Missing => next,
            EntryKind::Link => match fs.realpath(&next) {
                Ok(real) => win_canon(&real, fs, depth + 1)?,
                // Dangling: follow the link text.
                Err(_) => {
                    let target = fs.read_link(&next).map_err(failed)?;
                    win_canon(&win_path::resolve(&cur, &target), fs, depth + 1)?
                }
            },
            EntryKind::Other => fs.realpath(&next).map_err(failed)?,
        };
    }
    Ok(cur)
}

fn canon(platform: Platform, p: &str, fs: &dyn GuardFs) -> Result<String, Deny> {
    if platform.is_windows() {
        win_canon(p, fs, 0)
    } else {
        posix_canon(p, fs, 0)
    }
}

/// Is the canonical `p` outside the canonical `root`? (TS: `relative(root, p)` is `..`, starts
/// with `../`, or is absolute: another drive.) Windows compares case-insensitively.
fn outside(platform: Platform, root: &str, p: &str) -> bool {
    let (root, p, sep) = if platform.is_windows() {
        (root.to_lowercase(), p.to_lowercase(), '\\')
    } else {
        (root.to_string(), p.to_string(), '/')
    };
    if p == root {
        return false;
    }
    let prefix = if root.ends_with(sep) {
        root
    } else {
        format!("{root}{sep}")
    };
    !p.starts_with(&prefix)
}

fn is_absolute(platform: Platform, p: &str) -> bool {
    if platform.is_windows() {
        win_path::is_absolute(p)
    } else {
        p.starts_with('/')
    }
}

/// The guard's decision for one PreToolUse call: Ok = allow, Err = the reason it is blocked.
pub fn check(
    platform: Platform,
    fs: &dyn GuardFs,
    worktree: Option<&str>,
    input: &str,
) -> Result<(), Deny> {
    let worktree = worktree.ok_or_else(|| failed("no worktree argument"))?;
    let root = canon(platform, &resolve_for(platform, &fs.cwd(), worktree), fs)?;
    let input: Value = serde_json::from_str(input).map_err(failed)?;
    let empty = serde_json::Map::new();
    let ti = input
        .get("tool_input")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let targets: Vec<&Value> = ["file_path", "notebook_path"]
        .iter()
        .filter_map(|k| ti.get(*k))
        .collect();
    if targets.is_empty() {
        return Err("no file path to check".into());
    }
    for target in targets {
        let Some(target) = target.as_str().filter(|t| !t.is_empty()) else {
            return Err("empty file path".into());
        };
        let tilde =
            target.starts_with("~/") || (platform.is_windows() && target.starts_with("~\\"));
        let p = if target == "~" || tilde {
            let home = fs.home_dir().ok_or_else(|| failed("no home directory"))?;
            if target == "~" {
                home
            } else if platform.is_windows() {
                win_path::join(&[&home, &target[2..]])
            } else {
                resolve_for(Platform::Posix, "/", &posix_join(&home, &target[2..]))
            }
        } else {
            target.to_string()
        };
        if !is_absolute(platform, &p) {
            return Err(format!("file paths must be absolute; refused {target}"));
        }
        if outside(platform, &root, &canon(platform, &p, fs)?) {
            return Err(format!(
                "file edits are limited to the session worktree ({root}); refused {target}"
            ));
        }
    }
    Ok(())
}

/// The `hook edit-guard <worktree>` subcommand: reads the PreToolUse JSON from `stdin`, returns
/// the exit code (0 allow, 2 block, with `conductor: <why>` on `stderr`). Never panics: a panic
/// blocks too.
pub fn run_edit_guard_hook(args: &[OsString], stdin: &mut dyn Read, stderr: &mut dyn Write) -> i32 {
    let decision = catch_unwind(AssertUnwindSafe(|| {
        let worktree = args.first().map(|a| a.to_string_lossy().into_owned());
        let mut raw = Vec::new();
        stdin.read_to_end(&mut raw).map_err(failed)?;
        let raw = String::from_utf8(raw).map_err(failed)?;
        check(Platform::current(), &StdFs, worktree.as_deref(), &raw)
    }))
    .unwrap_or_else(|_| Err(failed("the guard crashed")));
    match decision {
        Ok(()) => 0,
        Err(why) => {
            let _ = writeln!(stderr, "conductor: {why}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A fake file system: `links` maps a path to its link text (with an optional resolved
    /// realpath), `dirs`/`files` exist as themselves, `short` maps 8.3 names to long ones.
    #[derive(Default)]
    struct FakeFs {
        win: bool,
        links: HashMap<String, (String, Option<String>)>,
        exist: Vec<String>,
        home: String,
    }

    impl FakeFs {
        fn key(&self, p: &str) -> String {
            if self.win {
                p.to_lowercase()
            } else {
                p.to_string()
            }
        }
    }

    impl GuardFs for FakeFs {
        fn lstat(&self, path: &str) -> EntryKind {
            let k = self.key(path);
            if self.links.keys().any(|l| self.key(l) == k) {
                EntryKind::Link
            } else if self.exist.iter().any(|e| self.key(e) == k) {
                EntryKind::Other
            } else {
                EntryKind::Missing
            }
        }
        fn read_link(&self, path: &str) -> io::Result<String> {
            let k = self.key(path);
            self.links
                .iter()
                .find(|(l, _)| self.key(l) == k)
                .map(|(_, (t, _))| t.clone())
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
        fn realpath(&self, path: &str) -> io::Result<String> {
            let k = self.key(path);
            if let Some((_, (_, real))) = self.links.iter().find(|(l, _)| self.key(l) == k) {
                return real
                    .clone()
                    .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound));
            }
            self.exist
                .iter()
                .find(|e| self.key(e) == k)
                .cloned()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
        fn home_dir(&self) -> Option<String> {
            Some(self.home.clone())
        }
        fn cwd(&self) -> String {
            if self.win { "C:\\".into() } else { "/".into() }
        }
    }

    fn input(p: &str) -> String {
        json!({"hook_event_name": "PreToolUse", "tool_input": {"file_path": p}}).to_string()
    }

    fn posix_fs() -> FakeFs {
        FakeFs {
            win: false,
            links: HashMap::from([
                ("/d/wt/link".into(), ("/d/secret".into(), None)),
                ("/d/wt/dangling".into(), ("/d/not-yet/f.txt".into(), None)),
                ("/d/wt/lnk".into(), ("/d/secret/sub".into(), None)),
                ("/d/wt/rel-link".into(), ("inner".into(), None)),
                ("/d/wt/loop".into(), ("/d/wt/loop".into(), None)),
            ]),
            exist: vec![
                "/d".into(),
                "/d/wt".into(),
                "/d/secret".into(),
                "/d/secret/sub".into(),
            ],
            home: "/home/me".into(),
        }
    }

    fn posix(p: &str) -> Result<(), Deny> {
        check(Platform::Posix, &posix_fs(), Some("/d/wt"), &input(p))
    }

    #[test]
    fn posix_rules_through_a_fake_fs() {
        for ok in [
            "/d/wt/src/deep/new.ts",
            "/d/wt/a/../b.txt",
            "/d/wt",
            "/d/wt/rel-link/f",
        ] {
            assert_eq!(posix(ok), Ok(()), "{ok}");
        }
        for bad in [
            "/d/outside.txt",
            "/d/wt/../x",
            "/etc/hosts",
            "/d/wt-sib/x",
            "/d/wt/link/id_rsa",
            "/d/wt/dangling",
            "/d/wt/lnk/../evil", // the kernel follows lnk first: secret/evil
            "~/.zshrc",
            "~",
        ] {
            let e = posix(bad).unwrap_err();
            assert!(
                e.contains("limited to the session worktree (/d/wt)"),
                "{bad}: {e}"
            );
        }
        assert!(posix("README.md").unwrap_err().contains("must be absolute"));
        assert!(
            posix("/d/wt/loop/x")
                .unwrap_err()
                .contains("too many levels")
        );
    }

    #[test]
    fn input_shapes_fail_closed() {
        let fs = posix_fs();
        let run = |i: &str| check(Platform::Posix, &fs, Some("/d/wt"), i);
        assert_eq!(
            run(r#"{"tool_input":{}}"#).unwrap_err(),
            "no file path to check"
        );
        assert_eq!(run("null").unwrap_err(), "no file path to check");
        assert_eq!(run("42").unwrap_err(), "no file path to check");
        assert_eq!(
            run(r#"{"tool_input":{"file_path":42}}"#).unwrap_err(),
            "empty file path"
        );
        assert_eq!(
            run(r#"{"tool_input":{"file_path":null}}"#).unwrap_err(),
            "empty file path"
        );
        assert_eq!(
            run(r#"{"tool_input":{"file_path":""}}"#).unwrap_err(),
            "empty file path"
        );
        assert!(
            run("not json")
                .unwrap_err()
                .starts_with("edit guard failed")
        );
        assert!(
            run(r#"{"tool_input":{"file_path":"/d/wt/ok","notebook_path":"/d/out.ipynb"}}"#)
                .is_err()
        );
        assert!(run(r#"{"tool_input":{"notebook_path":"/d/wt/n.ipynb"}}"#).is_ok());
        assert!(
            check(Platform::Posix, &fs, None, &input("/d/wt/x"))
                .unwrap_err()
                .starts_with("edit guard failed")
        );
    }

    fn win_fs() -> FakeFs {
        let wt = r"C:\Users\me\wt";
        FakeFs {
            win: true,
            links: HashMap::from([
                (
                    format!(r"{wt}\j"),
                    (
                        r"C:\Users\me\secret".into(),
                        Some(r"C:\Users\me\secret".into()),
                    ),
                ),
                (
                    format!(r"{wt}\k"),
                    (format!(r"{wt}\deep"), Some(format!(r"{wt}\deep"))),
                ),
                (
                    format!(r"{wt}\a"),
                    (
                        format!(r"{wt}\deep\deeper"),
                        Some(format!(r"{wt}\deep\deeper")),
                    ),
                ),
                (format!(r"{wt}\dangling"), (r"D:\elsewhere\f".into(), None)),
            ]),
            exist: vec![
                r"C:\Users".into(),
                r"C:\Users\me".into(),
                wt.into(),
                format!(r"{wt}\deep"),
                format!(r"{wt}\deep\deeper"),
                r"C:\Users\me\secret".into(),
                r"C:\Users\me\long outside name".into(),
            ],
            home: r"C:\Users\me".into(),
        }
    }

    #[test]
    fn windows_path_forms_through_a_fake_fs() {
        let fs = win_fs();
        let wt = r"C:\Users\me\wt";
        let run = |p: &str| check(Platform::Windows, &fs, Some(wt), &input(p));
        let rows: Vec<(String, bool)> = vec![
            (format!(r"{wt}\a.txt"), true),
            (format!("{}/b.txt", wt.replace('\\', "/")), true),
            (format!(r"{}\c.txt", wt.to_uppercase()), true),
            (format!(r"{}\d.txt", wt.to_lowercase()), true),
            (format!(r"{wt}\x\..\e.txt"), true),
            (format!(r"{wt}\.\f.txt"), true),
            (format!(r"{wt}\new\dir\g.txt"), true),
            (format!(r"{}/sub\h.txt", wt.replace('\\', "/")), true),
            (format!(r"{wt}\k\y.txt"), true),
            (format!(r"{wt}.\i.txt"), false),
            (format!(r"{wt}\.. \x"), false),
            (format!(r"{wt}\sub\.. \.. \x"), false),
            (format!(r"{wt}\name \x"), false),
            (r"C:\Users\me\outside.txt".into(), false),
            (format!(r"{wt}\..\x"), false),
            (format!(r"{wt}-sib\x"), false),
            (format!(r"{wt}\..\wt-evil\x"), false),
            (r"C:\Windows\System32\drivers\etc\hosts".into(), false),
            (r"D:\x.txt".into(), false),
            (r"\\server\share\x".into(), false),
            ("//server/share/x".into(), false),
            (format!(r"\\?\{wt}\x"), false),
            (format!(r"\\.\{wt}\x"), false),
            (r"\\?\UNC\server\share\x".into(), false),
            (format!(r"\??\{wt}\x"), false),
            ("C:x.txt".into(), false),
            (r"\Windows\x".into(), false),
            (format!(r"{wt}\file.txt:stream"), false),
            (format!("{wt}:stream"), false),
            (format!(r"{wt}\j\x"), false),
            (format!(r"{wt}\a\..\..\x"), false),
            (format!(r"{wt}\dangling"), false),
            (r"C:\Users\me\long outside name\x".into(), false),
            (r"~\x".into(), false),
            ("~/x".into(), false),
            ("x.txt".into(), false),
        ];
        let wrong: Vec<_> = rows
            .iter()
            .filter(|(p, ok)| run(p).is_ok() != *ok)
            .map(|(p, ok)| format!("{p} (want allow={ok}): {:?}", run(p)))
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
        assert!(run(r"\\server\x").unwrap_err().contains("UNC and device"));
        assert!(run(r"\??\C:\x").unwrap_err().contains("NT object"));
        assert!(
            run(r"\Windows\x")
                .unwrap_err()
                .contains("must start with a drive letter")
        );
        assert!(
            run(r"C:\x:y")
                .unwrap_err()
                .contains("alternate data streams")
        );
        assert!(
            run(r"C:\x.\y")
                .unwrap_err()
                .contains("ending in a dot or space")
        );
    }

    #[test]
    fn outside_and_dirname_edges() {
        assert!(!outside(Platform::Posix, "/", "/x"));
        assert!(!outside(Platform::Posix, "/a", "/a"));
        assert!(outside(Platform::Posix, "/a", "/ab"));
        assert!(!outside(Platform::Windows, r"C:\", r"c:\x"));
        assert!(outside(Platform::Windows, r"C:\a", r"D:\a"));
        assert!(!outside(Platform::Windows, r"C:\A", r"c:\a\b"));
        assert_eq!(win_dirname(r"C:\a\b"), r"C:\a");
        assert_eq!(win_dirname(r"C:\a"), r"C:\");
        assert_eq!(win_dirname(r"C:\"), r"C:\");
        assert_eq!(posix_dirname("/a/b"), "/a");
        assert_eq!(posix_dirname("/a"), "/");
        assert_eq!(posix_dirname("/"), "/");
    }

    #[test]
    fn settings_match_the_file_tools_and_pin_the_kill_switches_off() {
        let s =
            edit_guard_settings(Path::new("/opt/c d/conductor-daemon"), Path::new("/w t")).unwrap();
        assert_eq!(s["disableAllHooks"], json!(false));
        assert_eq!(s["env"], json!({"CLAUDE_CODE_SAFE_MODE": "0"}));
        let pre = &s["hooks"]["PreToolUse"][0];
        assert_eq!(pre["matcher"], json!(EDIT_GUARD_MATCHER));
        assert_eq!(pre["hooks"][0]["type"], json!("command"));
        let cmd = pre["hooks"][0]["command"].as_str().unwrap();
        if Platform::current().is_windows() {
            assert_eq!(
                cmd,
                "\"/opt/c d/conductor-daemon\" \"hook\" \"edit-guard\" \"/w t\" || exit 2"
            );
        } else {
            assert_eq!(
                cmd,
                "'/opt/c d/conductor-daemon' 'hook' 'edit-guard' '/w t' || exit 2"
            );
        }
    }

    #[test]
    fn the_hook_writes_the_reason_and_exits_2() {
        let mut err = Vec::new();
        let code = run_edit_guard_hook(&[], &mut "{}".as_bytes(), &mut err);
        assert_eq!(code, 2);
        assert!(
            String::from_utf8(err)
                .unwrap()
                .starts_with("conductor: edit guard failed")
        );
    }
}
