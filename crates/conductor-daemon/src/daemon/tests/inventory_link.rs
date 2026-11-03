//! `inventory/report.test.ts › daemon inventory over the link (M2-T10)`.
//!
//! SIGHUP itself is `main`'s (MR-T13); the daemon watches the portable twin, the
//! `<root>/state/rescan` trigger file (MW-T09), which `rescan` writes and SIGHUP stands for.

use super::*;
use crate::inventory::report::{inventory_hash, request_rescan};
use conductor_protocol::{Capability, InventoryRepo, WorkingCopyMode};

fn repo() -> InventoryRepo {
    InventoryRepo {
        path: "/Users/ben/code/app".try_into().unwrap(),
        remote: Some("github.com/org/app".into()),
        default_branch: "main".try_into().unwrap(),
        head_commit: "a".repeat(40).as_str().try_into().unwrap(),
        mode: WorkingCopyMode::Reference,
    }
}

fn gh() -> Capability {
    Capability::Cli {
        name: "gh".try_into().unwrap(),
        version: Some("2.50.0".into()),
        authed: true,
    }
}

fn slack() -> Capability {
    Capability::Mcp {
        name: "slack".try_into().unwrap(),
    }
}

/// A scan whose result the test can change.
fn scan_of(cell: Arc<Mutex<InventoryScan>>) -> ScanFn {
    Arc::new(move || {
        let s = cell.lock().unwrap().clone();
        async move { Ok(s) }.boxed()
    })
}

fn start(c: &Ctx, cell: Arc<Mutex<InventoryScan>>) -> Daemon {
    c.make(
        Arc::new(FakeClaudeDriver::new(FakeClaudeScript::new(vec![]))),
        Make {
            max_sessions: Some("1"),
            scan: Some(scan_of(cell)),
            ..Make::default()
        },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sent_after_registered_before_request_work_with_the_legacy_repo_inventory_too() {
    let c = Ctx::new().await;
    let scan = InventoryScan {
        repos: vec![repo()],
        capabilities: vec![gh()],
    };
    start(&c, Arc::new(Mutex::new(scan.clone())));
    c.registered_and_asked().await;
    let types = c.types();
    let at = |t: &str| types.iter().position(|x| x == t).unwrap();
    assert!(at("inventory") > at("register"));
    assert!(at("inventory") < at("request_work"));
    assert!(types.iter().any(|t| t == "repo_inventory")); // TD-110 until M2-T21
    let inv = &c.of_type("inventory")[0]["payload"];
    assert_eq!(
        *inv,
        json!({
            "repos": [serde_json::to_value(repo()).unwrap()],
            "capabilities": [serde_json::to_value(gh()).unwrap()],
            "hash": inventory_hash(&scan),
        })
    );
    assert_eq!(
        c.of_type("request_work")[0]["payload"]["repos_digest"],
        inv["hash"]
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn not_re_sent_when_unchanged_re_sent_on_sighup_after_a_change() {
    let c = Ctx::new().await;
    let cell = Arc::new(Mutex::new(InventoryScan {
        repos: vec![repo()],
        capabilities: vec![gh()],
    }));
    let d = start(&c, cell.clone());
    c.until(|| c.of_type("inventory").into_iter().next()).await;
    d.rescan_inventory().await;
    assert_eq!(c.of_type("inventory").len(), 1);

    // The rescan trigger (SIGHUP's twin): still one inventory (nothing changed).
    request_rescan(d.config().root_dir.as_path()).unwrap();
    let trigger = crate::inventory::report::rescan_trigger_path(&d.config().root_dir);
    c.until_true(|| !trigger.exists()).await;
    d.rescan_inventory().await;
    assert_eq!(c.of_type("inventory").len(), 1);

    *cell.lock().unwrap() = InventoryScan {
        repos: vec![repo()],
        capabilities: vec![gh(), slack()],
    };
    request_rescan(d.config().root_dir.as_path()).unwrap();
    let second = c.until(|| c.of_type("inventory").get(1).cloned()).await;
    assert_eq!(
        second["payload"]["capabilities"],
        json!([
            serde_json::to_value(gh()).unwrap(),
            serde_json::to_value(slack()).unwrap()
        ])
    );
    assert_ne!(
        second["payload"]["hash"],
        c.of_type("inventory")[0]["payload"]["hash"]
    );
    c.done().await;
}
