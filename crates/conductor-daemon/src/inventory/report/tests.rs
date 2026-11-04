//! Port of `inventory/report.test.ts` (the `inventoryHash` and `InventoryReporter` cases; the two
//! `daemon inventory over the link` cases need the daemon core: `daemon/tests/inventory_link.rs`), plus the
//! TS ↔ Rust payload vector and the rescan trigger file.

use super::*;
use crate::inventory::repos::no_log;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn repo(path: &str, head: char) -> InventoryRepo {
    InventoryRepo {
        path: path.try_into().unwrap(),
        remote: Some("github.com/org/app".into()),
        default_branch: "main".try_into().unwrap(),
        head_commit: head.to_string().repeat(40).as_str().try_into().unwrap(),
        mode: WorkingCopyMode::Reference,
    }
}

fn gh(version: &str) -> Capability {
    Capability::Cli {
        name: "gh".try_into().unwrap(),
        version: Some(version.into()),
        authed: true,
    }
}

fn slack() -> Capability {
    Capability::Mcp {
        name: "slack".try_into().unwrap(),
    }
}

const REPO: &str = "/Users/ben/code/app";

#[test]
fn the_payload_carries_git_identity_missing_which_the_hash_ignores() {
    let scan = InventoryScan {
        repos: vec![repo(REPO, 'a')],
        capabilities: vec![gh("2.50.0")],
        git_identity_missing: false,
    };
    let missing = inventory_payload(&InventoryScan {
        git_identity_missing: true,
        ..scan.clone()
    });
    assert_eq!(missing.git_identity_missing, Some(true));
    assert_eq!(inventory_payload(&scan).git_identity_missing, Some(false));
    assert_eq!(missing.hash.to_string(), inventory_hash(&scan));
}

#[test]
fn inventory_hash_is_stable_under_reordering_and_changes_with_a_version_or_a_repo() {
    let a = repo(REPO, 'a');
    let b = repo("/Users/ben/code/b", 'a');
    let scan = |repos: Vec<InventoryRepo>, capabilities: Vec<Capability>| InventoryScan {
        repos,
        capabilities,
        git_identity_missing: false,
    };
    let h = inventory_hash(&scan(
        vec![a.clone(), b.clone()],
        vec![gh("2.50.0"), slack()],
    ));
    assert_eq!(
        inventory_hash(&scan(
            vec![b.clone(), a.clone()],
            vec![slack(), gh("2.50.0")]
        )),
        h
    );
    assert_ne!(
        inventory_hash(&scan(
            vec![a.clone(), b.clone()],
            vec![gh("2.51.0"), slack()]
        )),
        h
    );
    assert_ne!(
        inventory_hash(&scan(
            vec![a, repo("/Users/ben/code/b", 'b')],
            vec![gh("2.50.0"), slack()]
        )),
        h
    );
}

#[test]
fn cap_string_is_the_ts_array_form() {
    assert_eq!(cap_string(&gh("2.50.0")), r#"["cli","gh","2.50.0",true]"#);
    let az = Capability::Cli {
        name: "az".try_into().unwrap(),
        version: None,
        authed: false,
    };
    assert_eq!(cap_string(&az), r#"["cli","az",null,false]"#);
    assert_eq!(cap_string(&slack()), r#"["mcp","slack"]"#);
    let skill = Capability::Skill {
        name: "review".try_into().unwrap(),
        repo: None,
    };
    assert_eq!(cap_string(&skill), r#"["skill","review",null]"#);
    let agent = Capability::Agent {
        name: "p".try_into().unwrap(),
        repo: Some("github.com/o/r".into()),
    };
    assert_eq!(cap_string(&agent), r#"["agent","p","github.com/o/r"]"#);
    let claude = Capability::Claude {
        version: "2.1.0".into(),
    };
    assert_eq!(cap_string(&claude), r#"["claude","2.1.0"]"#);
}

/// `tests/fixtures/ts/inventory-payload.json` is written by the TS daemon
/// (`UPDATE_TS_FIXTURES=1 pnpm vitest run --project daemon src/rust-compat.test.ts`): for each
/// scan, Rust computes the same payload (order and hash) as TS.
#[test]
fn the_payload_and_hash_match_the_ts_vector() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts/inventory-payload.json");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(cases.len() >= 3);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let scan = InventoryScan {
            repos: serde_json::from_value(case["scan"]["repos"].clone()).unwrap(),
            capabilities: serde_json::from_value(case["scan"]["capabilities"].clone()).unwrap(),
            git_identity_missing: false,
        };
        let payload = serde_json::to_value(inventory_payload(&scan)).unwrap();
        assert_eq!(payload, case["payload"], "{name}");
        // Value equality ignores object key order but not array order: check the order too.
        assert_eq!(
            payload["repos"].to_string(),
            case["payload"]["repos"].to_string(),
            "{name}"
        );
    }
}

/// A reporter over a scan the test controls, recording each sent hash.
struct Rig {
    reporter: InventoryReporter,
    scan: Arc<Mutex<InventoryScan>>,
    fail: Arc<AtomicBool>,
    scans: Arc<AtomicUsize>,
    sent: Arc<Mutex<Vec<String>>>,
}

fn rig(interval: Duration) -> Rig {
    let scan = Arc::new(Mutex::new(InventoryScan {
        repos: vec![repo(REPO, 'a')],
        capabilities: vec![gh("2.50.0")],
        git_identity_missing: false,
    }));
    let fail = Arc::new(AtomicBool::new(false));
    let scans = Arc::new(AtomicUsize::new(0));
    let sent = Arc::new(Mutex::new(Vec::new()));
    let (s, f, n) = (scan.clone(), fail.clone(), scans.clone());
    let scan_fn: ScanFn = Arc::new(move || {
        let (s, f, n) = (s.clone(), f.clone(), n.clone());
        Box::pin(async move {
            // A scan takes a while (the probes): lets a rescan arrive during it.
            tokio::time::sleep(Duration::from_millis(10)).await;
            n.fetch_add(1, Ordering::SeqCst);
            if f.load(Ordering::SeqCst) {
                Err("boom".to_string())
            } else {
                Ok(s.lock().unwrap().clone())
            }
        })
    });
    let out = sent.clone();
    let send_fn: SendFn =
        Arc::new(move |p: InventoryPayload| out.lock().unwrap().push(p.hash.to_string()));
    Rig {
        reporter: InventoryReporter::new(scan_fn, send_fn, interval, no_log()),
        scan,
        fail,
        scans,
        sent,
    }
}

impl Rig {
    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
}

#[tokio::test(start_paused = true)]
async fn sends_on_registered_and_the_10_minute_rescan_sends_only_on_change() {
    let ten_minutes = Duration::from_secs(600);
    let r = rig(ten_minutes);
    r.reporter.start();
    r.reporter.on_registered().await;
    assert_eq!(r.sent().len(), 1);
    assert_eq!(r.reporter.hash(), r.sent()[0]);

    tokio::time::sleep(ten_minutes + Duration::from_secs(1)).await;
    assert_eq!(r.scans.load(Ordering::SeqCst), 2);
    assert_eq!(r.sent().len(), 1); // unchanged: not re-sent

    r.scan.lock().unwrap().capabilities.push(slack());
    tokio::time::sleep(ten_minutes).await;
    assert_eq!(r.scans.load(Ordering::SeqCst), 3);
    assert_eq!(r.sent().len(), 2);

    // A reconnect always re-sends, changed or not.
    r.reporter.on_disconnected();
    r.reporter.rescan().await;
    assert_eq!(r.sent().len(), 2); // not connected: nothing sent
    r.reporter.on_registered().await;
    assert_eq!(r.sent().len(), 3);
    r.reporter.stop();

    // Stopped: the timer no longer scans.
    let before = r.scans.load(Ordering::SeqCst);
    tokio::time::sleep(ten_minutes * 2).await;
    assert_eq!(r.scans.load(Ordering::SeqCst), before);
}

#[tokio::test(start_paused = true)]
async fn a_failed_scan_keeps_the_previous_inventory() {
    let r = rig(Duration::from_secs(600));
    r.reporter.on_registered().await;
    r.fail.store(true, Ordering::SeqCst);
    r.reporter.rescan().await;
    assert_eq!(r.sent().len(), 1);
    assert_eq!(r.reporter.hash(), r.sent()[0]);
    r.reporter.stop();
}

#[tokio::test(start_paused = true)]
async fn a_rescan_during_a_scan_runs_once_after_it() {
    let r = rig(Duration::from_secs(600));
    r.reporter.start(); // scan 1 is running
    let (a, b) = tokio::join!(r.reporter.rescan(), r.reporter.rescan());
    let _ = (a, b);
    // The two requests during scan 1 fold into one more scan, not two.
    assert_eq!(r.scans.load(Ordering::SeqCst), 2);
    r.reporter.stop();
}

#[tokio::test(start_paused = true)]
async fn the_rescan_trigger_file_rescans_and_is_removed() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let r = rig(Duration::from_secs(600));
    r.reporter.on_registered().await;
    assert_eq!(r.sent().len(), 1);
    let watch = watch_rescan_trigger(&root, r.reporter.clone(), RESCAN_POLL);

    r.scan.lock().unwrap().capabilities.push(slack());
    request_rescan(&root).unwrap();
    assert!(rescan_trigger_path(&root).exists());
    assert_eq!(
        rescan_trigger_path(&root),
        root.join("state").join("rescan")
    );
    tokio::time::sleep(RESCAN_POLL + Duration::from_secs(1)).await;
    assert!(!rescan_trigger_path(&root).exists());
    assert_eq!(r.sent().len(), 2);

    // No trigger: no rescan.
    let scans = r.scans.load(Ordering::SeqCst);
    tokio::time::sleep(RESCAN_POLL * 3).await;
    assert_eq!(r.scans.load(Ordering::SeqCst), scans);
    watch.abort();
    r.reporter.stop();
}

#[tokio::test]
async fn scan_inventory_reads_roots_from_config_json() {
    use crate::actions::open_pr::tests::{git, ps};
    let tmp = tempfile::tempdir().unwrap();
    let base = crate::claude::transcript::realpath(tmp.path()).unwrap();
    let code = base.join("code");
    let app = code.join("app");
    std::fs::create_dir_all(&app).unwrap();
    git(&app, &["init", "--quiet", "-b", "main"]);
    git(
        &app,
        &[
            "-c",
            "user.email=t@localhost",
            "-c",
            "user.name=t",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "init",
        ],
    );
    let root = base.join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join("config.json"),
        serde_json::json!({ "roots": [ps(&code)], "repos": { ps(&app): { "mode": "checkout" } } })
            .to_string(),
    )
    .unwrap();
    let claude_dir = base.join("claude");
    std::fs::create_dir_all(claude_dir.join("skills").join("review")).unwrap();

    let mut env = crate::config::Env::new();
    env.insert("CONDUCTOR_ROOT".into(), ps(&root));
    env.insert("CONDUCTOR_MACHINE_ID".into(), "m".into());
    env.insert("CLAUDE_CONFIG_DIR".into(), ps(&claude_dir));
    let config = crate::config::load_config(&env, &crate::config::machine_facts()).unwrap();
    // This process's PATH (git must run); whatever CLIs it has are reported too, so only the
    // non-CLI capabilities are compared.
    let mut probe_env = crate::platform::spawn::process_env();
    probe_env.retain(|(k, _)| k != "CLAUDE_CONFIG_DIR" && k != "CONDUCTOR_CLAUDE_BIN");
    probe_env.push(("CLAUDE_CONFIG_DIR".into(), ps(&claude_dir)));
    probe_env.push((
        "CONDUCTOR_CLAUDE_BIN".into(),
        "conductor-no-such-claude".into(),
    ));
    let scan = scan_inventory(&config, &probe_env, no_log()).await;
    assert_eq!(scan.repos.len(), 1, "{scan:?}");
    assert_eq!(scan.repos[0].path.as_str(), ps(&app));
    assert_eq!(scan.repos[0].mode, WorkingCopyMode::Checkout);
    let others: Vec<&Capability> = scan
        .capabilities
        .iter()
        .filter(|c| !matches!(c, Capability::Cli { .. }))
        .collect();
    assert_eq!(
        others,
        vec![&Capability::Skill {
            name: "review".try_into().unwrap(),
            repo: None
        }]
    );
}

// Inventory log lines (why no tickets reach a machine).

#[test]
fn repo_warnings_no_roots_no_repos_or_a_repo_without_a_routable_remote() {
    assert_eq!(
        repo_warnings(&[], &[]),
        [
            "inventory: no repo roots configured, so no tickets can be routed here; run: conductor-daemon config roots <dir>"
        ]
    );
    assert_eq!(
        repo_warnings(&[PathBuf::from("/a"), PathBuf::from("/b")], &[]),
        ["inventory: no git repos found under /a, /b (searched 6 levels deep)"]
    );
    let mut local = repo("/Users/ben/code/local", 'a');
    local.remote = None;
    assert_eq!(
        repo_warnings(
            &[PathBuf::from("/Users/ben/code")],
            &[repo(REPO, 'a'), local]
        ),
        [
            "inventory: /Users/ben/code/local has no usable origin remote; tickets can't be routed to it"
        ]
    );
}

#[test]
fn inventory_summary_names_the_routable_remotes_deduplicated_and_cut_at_10() {
    let mut local = repo("/l", 'a');
    local.remote = None;
    let p = inventory_payload(&InventoryScan {
        repos: vec![repo(REPO, 'a'), repo("/twin", 'a'), local],
        capabilities: vec![gh("2.50.0")],
        git_identity_missing: false,
    });
    assert_eq!(
        inventory_summary(&p),
        "inventory: sent 3 repos (1 routable: github.com/org/app) and 1 capabilities"
    );
    assert_eq!(
        inventory_summary(&inventory_payload(&InventoryScan::default())),
        "inventory: sent 0 repos (0 routable) and 0 capabilities"
    );
    let many: Vec<InventoryRepo> = (0..12)
        .map(|i| {
            let mut r = repo(&format!("/r{i:02}"), 'a');
            r.remote = Some(format!("github.com/org/r{i:02}"));
            r
        })
        .collect();
    let line = inventory_summary(&inventory_payload(&InventoryScan {
        repos: many,
        capabilities: vec![],
        git_identity_missing: false,
    }));
    assert!(
        line.starts_with("inventory: sent 12 repos (12 routable: github.com/org/r00, "),
        "{line}"
    );
    assert!(line.contains("github.com/org/r09, …)"), "{line}");
    assert!(!line.contains("github.com/org/r10"), "{line}");
}

#[test]
fn once_log_prints_each_message_once_and_forgets_everything_at_its_cap() {
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let out = lines.clone();
    let log = once_log(
        Arc::new(move |m: &str| out.lock().unwrap().push(m.to_string())),
        2,
    );
    log("a");
    log("a");
    log("b");
    assert_eq!(*lines.lock().unwrap(), ["a", "b"]);
    log("c"); // cap reached: forgets a and b
    log("a");
    assert_eq!(*lines.lock().unwrap(), ["a", "b", "c", "a"]);
}

#[tokio::test(start_paused = true)]
async fn the_reporter_logs_the_summary_once_per_distinct_inventory_not_on_every_resend() {
    let scan = Arc::new(Mutex::new(InventoryScan {
        repos: vec![repo(REPO, 'a')],
        capabilities: vec![gh("2.50.0")],
        git_identity_missing: false,
    }));
    let s = scan.clone();
    let scan_fn: ScanFn = Arc::new(move || {
        let s = s.clone();
        Box::pin(async move { Ok(s.lock().unwrap().clone()) })
    });
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let out = lines.clone();
    let r = InventoryReporter::new(
        scan_fn,
        Arc::new(|_| {}),
        Duration::from_secs(600),
        Arc::new(move |m: &str| out.lock().unwrap().push(m.to_string())),
    );
    r.on_registered().await;
    r.on_disconnected();
    r.on_registered().await; // a reconnect re-sends the same inventory
    assert_eq!(
        *lines.lock().unwrap(),
        ["inventory: sent 1 repos (1 routable: github.com/org/app) and 1 capabilities"]
    );
    scan.lock().unwrap().capabilities.push(slack());
    r.rescan().await;
    let l = lines.lock().unwrap().clone();
    assert_eq!(l.len(), 2);
    assert!(l[1].contains("and 2 capabilities"), "{l:?}");
    r.stop();
}
