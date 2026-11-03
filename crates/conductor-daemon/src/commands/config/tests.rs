//! Port of the `conductor-daemon config` cases of `commands/config.test.ts` (M2-T10). The
//! `config.json` and `loadConfig inventory env` cases test `src/config.rs` and live there.

use super::*;
use crate::commands::CapturedOutput;
use crate::config::DaemonFileConfig;
use crate::platform::fs::posix_mode;
use crate::platform::{
    AclKind, AssertOwnerOnlyOptions, Platform, assert_owner_only, mkdir_private,
};

struct Fx {
    _tmp: tempfile::TempDir,
    tmp: PathBuf,
    root: PathBuf,
    io: CapturedOutput,
}

impl Fx {
    fn new() -> Self {
        let t = tempfile::tempdir().unwrap();
        let tmp = realpath(t.path()).unwrap();
        // Windows: the daemon root must be created under a private parent.
        mkdir_private(&tmp).unwrap();
        let root = tmp.join("daemon-root");
        Fx {
            _tmp: t,
            tmp,
            root,
            io: CapturedOutput::default(),
        }
    }

    fn run(&mut self, argv: &[&str], extra: &[(&str, &str)]) -> i32 {
        let mut env: Env = [(
            "CONDUCTOR_ROOT".to_string(),
            self.root.to_string_lossy().into_owned(),
        )]
        .into();
        for (k, v) in extra {
            env.insert(k.to_string(), v.to_string());
        }
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        config_command(&argv, &env, &self.tmp, &mut self.io)
    }

    fn cfg(&self) -> DaemonFileConfig {
        read_file_config(&self.root).unwrap()
    }

    fn p(&self, rel: &str) -> String {
        self.tmp.join(rel).to_string_lossy().into_owned()
    }

    /// A work tree as `config repo` sees one: a `.git` entry (no git process needed).
    fn repo(&self, rel: &str) -> String {
        let dir = self.tmp.join(rel);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        dir.to_string_lossy().into_owned()
    }
}

/// 0600 on POSIX; an owner-only DACL on Windows (ADR-0024 §3).
fn expect_private_file(path: &Path) {
    if Platform::current().is_windows() {
        assert_owner_only(path, AssertOwnerOnlyOptions::new(AclKind::File)).unwrap();
    } else {
        assert_eq!(posix_mode(path).unwrap() & 0o777, 0o600);
    }
}

#[test]
fn roots_saves_realpaths_deduped_at_0600() {
    let mut f = Fx::new();
    let a = f.p("code");
    std::fs::create_dir(&a).unwrap();
    let sep = std::path::MAIN_SEPARATOR;
    let dot = format!("{a}{sep}.");
    let slash = format!("{a}{sep}");
    assert_eq!(
        f.run(&["roots", &a, &dot, &slash], &[]),
        0,
        "{}",
        f.io.all()
    );
    assert_eq!(f.cfg().roots, vec![a]);
    expect_private_file(&file_config_path(&f.root));
    assert!(f.io.out.join("\n").contains("kill -HUP"));
    assert!(f.io.out.join("\n").contains("conductor-daemon rescan"));
}

#[test]
fn roots_a_missing_directory_or_none_is_2_nothing_written() {
    let mut f = Fx::new();
    let nope = f.p("nope");
    assert_eq!(f.run(&["roots", &nope], &[]), 2);
    assert!(f.io.err.join("\n").contains("does not exist"));
    assert_eq!(f.run(&["roots"], &[]), 2);
    assert!(f.cfg().roots.is_empty());
    assert!(!file_config_path(&f.root).exists());
}

#[test]
fn repo_mode_checkout_stored_by_path_warns_when_not_under_a_root() {
    let mut f = Fx::new();
    let code = f.p("code");
    let app = f.repo("code/app");
    assert_eq!(
        f.run(&["repo", &app, "--mode", "checkout"], &[]),
        0,
        "{}",
        f.io.all()
    );
    assert_eq!(
        f.cfg().repos.get(&app),
        Some(&RepoFileConfig {
            mode: WorkingCopyMode::Checkout
        })
    );
    assert!(f.io.err.join("\n").contains("not under a configured root"));
    f.io.err.clear();
    assert_eq!(f.run(&["roots", &code], &[]), 0);
    assert_eq!(f.run(&["repo", &app, "--mode=reference"], &[]), 0);
    assert_eq!(f.cfg().repos[&app].mode, WorkingCopyMode::Reference);
    assert!(f.io.err.is_empty(), "{:?}", f.io.err);
}

#[test]
fn repo_a_bad_mode_a_non_repo_or_extra_args_is_2() {
    let mut f = Fx::new();
    let app = f.p("app");
    std::fs::create_dir(&app).unwrap();
    assert_eq!(f.run(&["repo", &app, "--mode", "checkout"], &[]), 2); // no .git
    let app = f.repo("app");
    assert_eq!(f.run(&["repo", &app, "--mode", "yolo"], &[]), 2);
    assert_eq!(f.run(&["repo", &app], &[]), 2);
    assert_eq!(f.run(&["repo", &app, &app, "--mode", "checkout"], &[]), 2);
    assert_eq!(f.run(&["repo", &app, "--mood", "checkout"], &[]), 2);
    assert!(f.cfg().repos.is_empty());
    let err = f.io.err.join("\n");
    assert!(err.contains("is not a git work tree"), "{err}");
    assert!(
        err.contains("--mode must be reference or checkout (got yolo)"),
        "{err}"
    );
    assert!(
        err.contains("--mode must be reference or checkout (got nothing)"),
        "{err}"
    );
    assert!(
        err.contains("config repo needs exactly one <path>"),
        "{err}"
    );
    assert!(err.contains("Unknown option '--mood'"), "{err}");
}

#[test]
fn show_the_file_effective_roots_and_repos_conductor_roots_wins() {
    let mut f = Fx::new();
    let cfg = DaemonFileConfig {
        roots: vec!["/from/file".into()],
        ..Default::default()
    };
    write_file_config(&f.root, &cfg).unwrap();
    assert_eq!(f.run(&["show"], &[]), 0);
    let shown: serde_json::Value = serde_json::from_str(&f.io.out.join("\n")).unwrap();
    assert_eq!(
        shown,
        serde_json::json!({
            "file": file_config_path(&f.root).to_string_lossy(),
            "roots": ["/from/file"],
            "roots_from": "file",
            "repos": {},
        })
    );
    // Key order as TS: file, roots, roots_from, repos.
    let text = f.io.out.join("\n");
    let at = |k: &str| text.find(&format!("\"{k}\"")).unwrap();
    assert!(
        at("file") < at("roots")
            && at("roots") < at("roots_from")
            && at("roots_from") < at("repos")
    );
    f.io.out.clear();
    assert_eq!(f.run(&["show"], &[("CONDUCTOR_ROOTS", "/from/env")]), 0);
    let shown: serde_json::Value = serde_json::from_str(&f.io.out.join("\n")).unwrap();
    assert_eq!(
        shown["roots"],
        serde_json::json!([platform::resolve("/from/env").to_string_lossy()])
    );
    assert_eq!(shown["roots_from"], "CONDUCTOR_ROOTS");
    assert!(
        std::fs::read_to_string(file_config_path(&f.root))
            .unwrap()
            .contains("/from/file")
    );
}

#[test]
fn no_or_an_unknown_subcommand_is_usage_2() {
    let mut f = Fx::new();
    assert_eq!(f.run(&[], &[]), 2);
    assert_eq!(f.run(&["frobnicate"], &[]), 2);
    assert!(
        f.io.err
            .join("\n")
            .contains("usage: conductor-daemon config roots")
    );
}

#[test]
fn an_invalid_config_json_is_exit_1_naming_the_file() {
    let mut f = Fx::new();
    mkdir_private(&f.root).unwrap();
    std::fs::write(file_config_path(&f.root), "{nope").unwrap();
    assert_eq!(f.run(&["show"], &[]), 1);
    assert!(
        f.io.err
            .join("\n")
            .contains("config.json is not valid JSON")
    );
}

/// `loadConfig inventory env › CONDUCTOR_ROOTS with drive letters` (win32 only in TS): `;` splits,
/// so a drive letter's `:` stays inside its root.
#[test]
fn conductor_roots_with_drive_letters_is_two_roots_on_windows() {
    if !Platform::current().is_windows() {
        return;
    }
    let env: Env = [("CONDUCTOR_ROOTS".to_string(), r"C:\a;D:\b".to_string())].into();
    assert_eq!(
        roots_from_env(&env).unwrap(),
        vec![PathBuf::from(r"C:\a"), PathBuf::from(r"D:\b")]
    );
}
