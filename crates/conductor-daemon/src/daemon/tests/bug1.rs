//! `daemon.test.ts › daemon core: BUG-1 no process outlives its session`.

use super::*;
use crate::claude::fake_driver::FakeDriverSession;

/// The TS `driver.start = (o) => { s.pid = 4242 }`: a fake whose sessions have a pid.
pub struct PidDriver(pub Arc<FakeClaudeDriver>, pub u32);

impl ClaudeDriver for PidDriver {
    fn start(
        &self,
        opts: DriverStartOptions,
    ) -> Result<Arc<dyn DriverSession>, crate::claude::driver::DriverError> {
        let s: Arc<FakeDriverSession> = self.0.start_fake(opts);
        s.set_pid(Some(self.1));
        Ok(s)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_3_a_start_superseding_a_parked_process_kills_it_before_the_new_one_runs() {
    let c = Ctx::new().await;
    let drv = driver(script(vec![vec![ask("q")]]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let a = c.start(sid, json!({}), 1);
    c.send(&a.msg);
    c.first_event("ask_user").await;
    let b = c.start(sid, json!({}), 2);
    c.send(&b.msg);
    assert_eq!(c.ack(b.cid).await["accepted"], true);
    let sessions = drv.sessions();
    assert!(sessions[0].killed());
    assert!(!sessions[1].killed());
    c.until(|| {
        c.data("exit")
            .into_iter()
            .find(|e| e["command_id"] == json!(a.cid))
    })
    .await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_3_two_starts_racing_through_worktree_preparation_leave_exactly_one_process() {
    let c = Ctx::new().await;
    let drv = driver(script(vec![vec![ask("q")]]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let a = c.start(sid, json!({}), 1);
    let b = c.start(sid, json!({ "prompt": "the second start" }), 2);
    c.send(&a.msg); // still preparing its worktree when b arrives
    c.send(&b.msg);
    let ack_a = c.ack(a.cid).await;
    let ack_b = c.ack(b.cid).await;
    wait_ms(50).await;
    assert_eq!(ack_b["accepted"], true);
    let alive: Vec<_> = drv
        .sessions()
        .into_iter()
        .filter(|x| !x.killed() && !x.exited())
        .collect();
    assert_eq!(alive.len(), 1);
    assert_eq!(alive[0].opts().prompt, "the second start");
    // a either never spawned (refused `superseded`) or was killed: never left running.
    if ack_a["accepted"] == false {
        assert_eq!(ack_a["reason"], "superseded");
    }
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_4_repeated_heartbeat_backstop_kills_stop_a_parked_process_once_logged_once() {
    let c = Ctx::new().await;
    let logs = Logs::default();
    let drv = driver(script(vec![vec![ask("q")]]));
    c.make(
        drv.clone(),
        Make {
            logs: Some(logs.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 3);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    // The session went terminal (token bumped); each heartbeat listing the old token gets this.
    c.send(&kill(sid, None, None, "stale_fencing_token", 3));
    c.send(&kill(sid, None, None, "stale_fencing_token", 3));
    c.first_event("exit").await;
    assert!(drv.last().unwrap().killed());
    assert_eq!(drv.last().unwrap().kill_calls(), 1);
    let lines: Vec<String> = logs
        .lines()
        .into_iter()
        .filter(|l| l.contains("kill (stale_fencing_token)"))
        .collect();
    assert_eq!(
        lines,
        [format!(
            "session {sid}: kill (stale_fencing_token) stops process {}",
            start.cid
        )]
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fr_4_the_pid_and_start_time_of_a_started_process_are_persisted_for_the_startup_sweep() {
    let c = Ctx::new().await;
    let fake = Arc::new(FakeClaudeDriver::new(script(vec![vec![ask("q")]])));
    let d = c.make(
        Arc::new(PidDriver(fake.clone(), 4242)),
        Make {
            proc_info: Some(Arc::new(|pid: u32| {
                (pid == 4242).then(|| ProcInfo {
                    started_at_ms: 1_700_000_000_000,
                    command: String::new(),
                    argv: vec![],
                    executable_path: None,
                })
            })),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    assert_eq!(
        d.store().session(&sid.to_string()).unwrap().agent,
        Some(Some(AgentRecord {
            command_id: start.cid.to_string(),
            fencing_token: 1,
            pid: Some(4242),
            claude_session_id: Some(fake.last().unwrap().opts().claude_session_id.clone()),
            started_at: Some(1_700_000_000_000),
        }))
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bug_1b_fr_1_a_process_whose_start_time_cannot_be_read_is_not_tracked_for_the_sweep() {
    let c = Ctx::new().await;
    let fake = Arc::new(FakeClaudeDriver::new(script(vec![vec![ask("q")]])));
    let logs = Logs::default();
    let d = c.make(
        Arc::new(PidDriver(fake, 4242)),
        Make {
            proc_info: Some(Arc::new(|_: u32| None)),
            logs: Some(logs.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.first_event("ask_user").await;
    assert_eq!(
        d.store().session(&sid.to_string()).unwrap().agent,
        Some(Some(AgentRecord {
            command_id: start.cid.to_string(),
            fencing_token: 1,
            pid: None,
            claude_session_id: None,
            started_at: None,
        }))
    );
    assert!(logs.lines().contains(&format!(
        "session {sid}: cannot read start time of process 4242; not tracked for the orphan sweep"
    )));
    c.done().await;
}
