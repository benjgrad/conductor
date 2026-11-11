//! `daemon.test.ts › daemon core: BUG-1b orphan sweep only kills provably-ours processes`.
//!
//! Harmless stand-ins (`sh -c 'sleep 300 & …; wait'`, each the leader of its own process group)
//! with a crafted argv0/argv at the stored pid. Only pids these tests spawned are signalled.
//! POSIX only, as in TS (argv0 spoofing of /bin/sh); win32 is covered against a real fake-claude
//! process in `kill_real`.

use super::*;
use crate::platform::kill_tree::tests_support::stand_in;

const BIN: &str = "/opt/conductor-test/claude";
const GRACE: u64 = 200;

struct StandIn {
    leader: u32,
    child: u32,
    started_at: i64,
}

/// Kills every stand-in a test started (the TS afterEach), then checks none is left (NFR-2).
#[derive(Default)]
struct Spawned(Mutex<Vec<(u32, u32)>>);

impl Spawned {
    fn stand_in(&self, argv0: &str, extra: &[&str], ignore_term: bool) -> StandIn {
        let extra: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
        let (leader, child) = stand_in(argv0, &extra, ignore_term).expect("a POSIX stand-in");
        self.0.lock().unwrap().push((leader, child));
        let info = read_proc_info(leader).expect("the stand-in's proc info");
        StandIn {
            leader,
            child,
            started_at: info.started_at_ms,
        }
    }

    async fn reap(&self, c: &Ctx) {
        let pids: Vec<(u32, u32)> = self.0.lock().unwrap().drain(..).collect();
        for (leader, _) in &pids {
            platform::signal_tree(*leader, Signal::Kill);
        }
        c.until_for(5_000, || {
            pids.iter()
                .all(|(l, ch)| !alive(*l) && !alive(*ch))
                .then_some(())
        })
        .await;
    }
}

fn seed(c: &Ctx, agents: Vec<AgentRecord>) -> Vec<String> {
    let mut store = DaemonStore::for_root(&c.root()).unwrap();
    agents
        .into_iter()
        .map(|agent| {
            let sid = Uuid::new_v4().to_string();
            store
                .put_session(
                    &sid,
                    PersistedSession {
                        ticket_id: TICKET.into(),
                        repo: c.repo.to_string_lossy().into_owned(),
                        worktree_path: c.tmp.join("wt").to_string_lossy().into_owned(),
                        branch: "b".into(),
                        port_range: None,
                        claude_session_id: agent.claude_session_id.clone(),
                        last_used_at: 0,
                        agent: Some(Some(agent)),
                        base: None,
                    },
                )
                .unwrap();
            sid
        })
        .collect()
}

fn agent_of(pid: u32, claude_session_id: Option<&str>, started_at: Option<i64>) -> AgentRecord {
    AgentRecord {
        command_id: Uuid::new_v4().to_string(),
        fencing_token: 4,
        pid: Some(pid),
        claude_session_id: claude_session_id.map(String::from),
        started_at,
    }
}

async fn exits(c: &Ctx, n: usize) -> Vec<Value> {
    c.until(|| {
        let e = c.data("exit");
        (e.len() == n).then_some(e)
    })
    .await
}

async fn settle() {
    wait_ms(GRACE + 300).await;
}

fn make_sweeper(c: &Ctx, logs: &Logs, proc_info: Option<ProcInfoFn>) -> Daemon {
    c.make(
        driver(complete(json!({}))),
        Make {
            claude_bin: Some(BIN.into()),
            logs: Some(logs.clone()),
            proc_info,
            config: Some(Box::new(|cfg| cfg.kill_grace_ms = GRACE)),
            ..Make::default()
        },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_2_c_our_argv_start_time_and_uuid_killed_with_its_whole_group() {
    if windows() {
        return;
    }
    let c = Ctx::new().await;
    let sp = Spawned::default();
    let id = Uuid::new_v4().to_string();
    let s = sp.stand_in(BIN, &["--session-id", &id], false);
    let sid = seed(&c, vec![agent_of(s.leader, Some(&id), Some(s.started_at))]).remove(0);
    let logs = Logs::default();
    let d = make_sweeper(&c, &logs, None);
    c.until_for(5_000, || {
        (!alive(s.leader) && !alive(s.child)).then_some(())
    })
    .await;
    assert!(logs.lines().contains(&format!(
        "startup: killed orphaned claude process {} of session {sid}",
        s.leader
    )));
    let signals: Vec<Value> = exits(&c, 1)
        .await
        .iter()
        .map(|e| e["signal"].clone())
        .collect();
    assert_eq!(signals, [json!("daemon_restart")]);
    assert_eq!(d.store().session(&sid).unwrap().agent, Some(None));
    sp.reap(&c).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_2_a_b_d_e_anything_not_provably_ours_is_untouched_and_logged() {
    if windows() {
        return;
    }
    let c = Ctx::new().await;
    let sp = Spawned::default();
    let id = Uuid::new_v4().to_string();
    // (a) the user's own `claude --resume <same uuid>` at the stored pid, started at another time.
    let a = sp.stand_in(BIN, &["--resume", &id], false);
    // (b) an argv that only mentions the id.
    let b = sp.stand_in("grep", &["-r", &id, "."], false);
    // (d) an empty and a non-UUID stored id, with argv carrying the same.
    let d1 = sp.stand_in(BIN, &["--session-id", ""], false);
    let d2 = sp.stand_in(BIN, &["--session-id", "not-a-uuid"], false);
    // (e) another binary with matching tokens.
    let e = sp.stand_in("/usr/bin/notclaude", &["--session-id", &id], false);
    seed(
        &c,
        vec![
            agent_of(a.leader, Some(&id), Some(a.started_at - 60_000)),
            agent_of(b.leader, Some(&id), Some(b.started_at)),
            agent_of(d1.leader, Some(""), Some(d1.started_at)),
            agent_of(d2.leader, Some("not-a-uuid"), Some(d2.started_at)),
            agent_of(e.leader, Some(&id), Some(e.started_at)),
        ],
    );
    let logs = Logs::default();
    make_sweeper(&c, &logs, None);
    let signals: Vec<Value> = exits(&c, 5)
        .await
        .iter()
        .map(|x| x["signal"].clone())
        .collect();
    assert_eq!(signals, vec![json!("daemon_restart"); 5]);
    settle().await;
    for p in [&a, &b, &d1, &d2, &e] {
        assert!(alive(p.leader));
        assert!(alive(p.child));
    }
    let not_ours = |pid: u32, reason: &str| {
        format!("orphan sweep: pid {pid} alive but not ours ({reason}); left alone")
    };
    let lines = logs.lines();
    for want in [
        not_ours(a.leader, "start time differs (pid reused)"),
        not_ours(b.leader, "not the claude binary"),
        not_ours(d1.leader, "invalid stored claude session id"),
        not_ours(d2.leader, "invalid stored claude session id"),
        not_ours(e.leader, "not the claude binary"),
    ] {
        assert!(lines.contains(&want), "missing {want:?} in {lines:?}");
    }
    assert!(!lines.iter().any(|l| l.starts_with("startup: killed")));
    sp.reap(&c).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_4_an_old_entry_without_started_at_is_untouched_logged_and_cleared() {
    if windows() {
        return;
    }
    let c = Ctx::new().await;
    let sp = Spawned::default();
    let id = Uuid::new_v4().to_string();
    let s = sp.stand_in(BIN, &["--session-id", &id], false);
    let sid = seed(&c, vec![agent_of(s.leader, Some(&id), None)]).remove(0);
    let logs = Logs::default();
    let d = make_sweeper(&c, &logs, None);
    let signals: Vec<Value> = exits(&c, 1)
        .await
        .iter()
        .map(|x| x["signal"].clone())
        .collect();
    assert_eq!(signals, [json!("daemon_restart")]);
    settle().await;
    assert!(alive(s.leader));
    assert!(logs.lines().contains(&format!(
        "orphan sweep: pid {} of session {sid} has no recorded start time (old entry); left alone",
        s.leader
    )));
    assert_eq!(d.store().session(&sid).unwrap().agent, Some(None));
    sp.reap(&c).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_3_a_process_replaced_between_sigterm_and_sigkill_gets_no_sigkill() {
    if windows() {
        return;
    }
    let c = Ctx::new().await;
    let sp = Spawned::default();
    let id = Uuid::new_v4().to_string();
    // Ignores SIGTERM, so only a SIGKILL would end it.
    let s = sp.stand_in(BIN, &["--session-id", &id], true);
    let sid = seed(&c, vec![agent_of(s.leader, Some(&id), Some(s.started_at))]).remove(0);
    let calls = Arc::new(Mutex::new(0u32));
    let n = calls.clone();
    // The re-check sees another start time: the pid now belongs to another process.
    let proc_info: ProcInfoFn = Arc::new(move |pid: u32| {
        let info = read_proc_info(pid);
        let mut n = n.lock().unwrap();
        let later = *n > 0;
        *n += 1;
        info.map(|mut i| {
            if later {
                i.started_at_ms += 1000;
            }
            i
        })
    });
    let logs = Logs::default();
    make_sweeper(&c, &logs, Some(proc_info));
    exits(&c, 1).await;
    assert!(logs.lines().contains(&format!(
        "startup: killed orphaned claude process {} of session {sid}",
        s.leader
    )));
    c.until_for(5_000, || (*calls.lock().unwrap() >= 2).then_some(()))
        .await;
    settle().await;
    assert!(alive(s.leader));
    assert!(logs.lines().contains(&format!(
        "orphan sweep: pid {} alive but not ours (start time differs (pid reused)); left alone (no SIGKILL)",
        s.leader
    )));
    sp.reap(&c).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_3_control_a_process_still_ours_after_the_grace_period_is_sigkilled() {
    if windows() {
        return;
    }
    let c = Ctx::new().await;
    let sp = Spawned::default();
    let id = Uuid::new_v4().to_string();
    let s = sp.stand_in(BIN, &["--session-id", &id], true);
    seed(&c, vec![agent_of(s.leader, Some(&id), Some(s.started_at))]);
    make_sweeper(&c, &Logs::default(), None);
    exits(&c, 1).await;
    // It ignores SIGTERM: only the SIGKILL after the grace period ends it (and its group).
    c.until_for(5_000, || {
        (!alive(s.leader) && !alive(s.child)).then_some(())
    })
    .await;
    sp.reap(&c).await;
    c.done().await;
}
