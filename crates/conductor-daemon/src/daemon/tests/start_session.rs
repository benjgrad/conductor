//! `daemon.test.ts › daemon core: start_session`.

use super::*;
use crate::claude::transcript::transcript_path_for;
use crate::system_prompt::CONDUCTOR_INSTRUCTIONS;
use conductor_protocol::tool_policy::resolve_tool_policy;

/// A Claude transcript for `claude_id`: in the project dir of session `sid`'s worktree (where
/// `claude --resume` looks), or under an unrelated project dir with `elsewhere`.
pub fn write_transcript_for(c: &Ctx, d: &Daemon, sid: Uuid, claude_id: &str, elsewhere: bool) {
    let wt = d.workspace().worktree_path(&sid.to_string());
    std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
    let file = if elsewhere {
        c.claude_dir()
            .join("projects")
            .join("-elsewhere")
            .join(format!("{claude_id}.jsonl"))
    } else {
        transcript_path_for(&c.claude_dir(), &wt, claude_id).unwrap()
    };
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, "{\"type\":\"user\"}\n").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creates_the_worktree_on_the_session_branch_spawns_the_driver_and_forwards_events() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let start = c.start(sid, json!({}), 1);
    c.send(&start.msg);
    c.first_event("exit").await;
    assert_eq!(
        serde_json::to_value(c.acks(start.cid)).unwrap(),
        json!([{ "command_id": start.cid, "accepted": true }])
    );
    let evs = c.events(None);
    let kinds: Vec<&str> = evs
        .iter()
        .map(|e| e["payload"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "started",
            "claude_session_id",
            "complete_state",
            "spend",
            "exit"
        ]
    );
    // seq strictly increasing from 0; the envelope carries the start's token.
    let seqs: Vec<i64> = evs.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [0, 1, 2, 3, 4]);
    assert!(
        evs.iter()
            .all(|e| e["fencing_token"] == 1 && e["session_id"] == json!(sid))
    );

    let started = &c.data("started")[0];
    assert_eq!(started["command_id"], json!(start.cid));
    assert_eq!(started["branch"], branch_for(sid));
    assert_eq!(started["port_range"], json!({ "base": 42000, "count": 10 }));
    let wt = PathBuf::from(started["worktree_path"].as_str().unwrap());
    assert_eq!(git(&wt, &["branch", "--show-current"]), branch_for(sid));

    let opts = drv.starts()[0].clone();
    assert_eq!(opts.cwd, wt);
    assert!(!opts.resume);
    assert_eq!(
        opts.tools,
        resolve_tool_policy(&["read", "edit", "bash", "git"]).unwrap()
    );
    let prompt = opts.append_system_prompt.clone().unwrap();
    assert!(prompt.contains(CONDUCTOR_INSTRUCTIONS));
    assert!(prompt.contains("Always run npm test."));
    // 09 §Budgets (TD-022): the remaining budget is the CLI's --max-budget-usd.
    assert_eq!(opts.max_budget_usd, Some(5.0));
    assert_eq!(opts.env["CONDUCTOR_SESSION_ID"], sid.to_string());
    assert_eq!(opts.env["CONDUCTOR_PORT_BASE"], "42000");
    assert_eq!(opts.env["PORT"], "42000");
    assert_eq!(opts.env["CONDUCTOR_PORT_COUNT"], "10");

    assert_eq!(
        c.data("claude_session_id")[0],
        json!({ "id": opts.claude_session_id })
    );
    assert_eq!(
        c.data("complete_state")[0],
        json!({ "result": { "summary": "done" } })
    );
    let spend = &c.data("spend")[0];
    assert_eq!(spend["claude_session_id"], json!(opts.claude_session_id));
    assert_eq!(spend["total_usd"], 0.01);
    assert_eq!(
        c.data("exit")[0],
        json!({ "command_id": start.cid, "code": 0, "signal": null })
    );
    // After complete_state + turn_end the daemon ended the session gracefully.
    assert!(drv.last().unwrap().ended());
    assert!(
        c.of_type("output")
            .iter()
            .any(|o| o["payload"]["text"] == "working")
    );
    // The shared clone shows up in the inventory.
    let repo = c.repo.to_string_lossy().into_owned();
    c.until_true(|| {
        c.of_type("repo_inventory").iter().any(|m| {
            m["payload"]["repos"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["repo"] == repo)
        })
    })
    .await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persists_the_pre_assigned_claude_session_id_before_spawning() {
    let c = Ctx::new().await;
    let drv = driver(script(vec![vec![ask("q?")]]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("ask_user").await;
    let store = DaemonStore::for_root(&c.root()).unwrap();
    assert_eq!(
        store.session(&sid.to_string()).unwrap().claude_session_id,
        Some(drv.starts()[0].claude_session_id.clone())
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0039_permission_mode_bypass_sets_skip_permissions_for_a_worker_only() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({})));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(
        &c.start(sid, json!({ "permission_mode": "bypassPermissions" }), 1)
            .msg,
    );
    c.first_event("exit").await;
    assert!(drv.starts()[0].skip_permissions);
    c.send(
        &c.start(
            sid,
            json!({
                "workflow_state": "implement → build (review)",
                "prompt": "# Requirements review",
                "tools": ["review"],
                "review": true,
                "permission_mode": "bypassPermissions",
            }),
            1,
        )
        .msg,
    );
    c.until_true(|| c.events(Some("exit")).len() >= 2).await;
    assert!(!drv.starts()[1].skip_permissions);
    let other = Uuid::new_v4();
    c.send(&c.start(other, json!({}), 1).msg);
    c.until_true(|| c.events(Some("exit")).len() >= 3).await;
    assert!(!drv.starts()[2].skip_permissions);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adr_0009_a_reviewer_start_is_fresh_read_only_and_never_replaces_the_worker_s_stored_id() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({})));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("exit").await;
    let worker = drv.starts()[0].claude_session_id.clone();
    c.send(
        &c.start(
            sid,
            json!({
                "workflow_state": "implement → build (review)",
                "prompt": "# Requirements review",
                "tools": ["review"],
                "review": true,
            }),
            1,
        )
        .msg,
    );
    c.until_true(|| c.events(Some("exit")).len() >= 2).await;
    let reviewer = drv.starts()[1].clone();
    assert!(!reviewer.resume);
    assert!(reviewer.review); // → --permission-mode dontAsk in the driver
    assert!(!drv.starts()[0].review); // the worker keeps the user's mode
    assert_ne!(reviewer.claude_session_id, worker);
    assert!(!reviewer.tools.builtin.contains(&"Edit".to_string()));
    assert!(!reviewer.tools.builtin.contains(&"Write".to_string()));
    assert!(reviewer.tools.allow.contains(&"Bash(git diff)".to_string()));
    // The session's transcript (history, reopen) stays the worker's conversation.
    let store = DaemonStore::for_root(&c.root()).unwrap();
    assert_eq!(
        store.session(&sid.to_string()).unwrap().claude_session_id,
        Some(worker)
    );
    // Spend is reported under the reviewer's own id, so it adds to the session budget.
    assert!(
        c.data("spend")
            .iter()
            .any(|d| d["claude_session_id"] == json!(reviewer.claude_session_id))
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resumes_with_resume_semantics_when_resume_claude_session_id_is_set() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({})));
    let d = c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let claude_id = Uuid::new_v4().to_string();
    let sid = Uuid::new_v4();
    write_transcript_for(&c, &d, sid, &claude_id, false);
    let start = c.start(
        sid,
        json!({ "resume_claude_session_id": claude_id, "prompt": "the answer" }),
        1,
    );
    c.send(&start.msg);
    c.first_event("exit").await;
    assert!(c.acks(start.cid)[0].accepted);
    let o = &drv.starts()[0];
    assert_eq!(o.claude_session_id, claude_id);
    assert!(o.resume);
    assert_eq!(o.prompt, "the answer");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_no_conversation_never_spawns_when_the_resumed_conversation_is_not_on_this_machine()
{
    let c = Ctx::new().await;
    let logs = Logs::default();
    let drv = driver(complete(json!({})));
    let d = c.make(
        drv.clone(),
        Make {
            logs: Some(logs.clone()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let claude_id = Uuid::new_v4().to_string(); // ran on another machine: no transcript here
    // A transcript under another project dir doesn't count: `claude --resume` only looks in the
    // worktree's own.
    write_transcript_for(&c, &d, sid, &claude_id, true);
    for review in [false, true] {
        let mut over = json!({ "resume_claude_session_id": claude_id, "prompt": "the answer" });
        if review {
            over["review"] = json!(true);
            over["tools"] = json!(["review"]);
        }
        let start = c.start(sid, over, 1);
        c.send(&start.msg);
        assert_eq!(
            c.ack(start.cid).await,
            json!({ "command_id": start.cid, "accepted": false, "reason": NO_CONVERSATION_REASON })
        );
    }
    assert!(drv.starts().is_empty());
    assert!(c.events(None).is_empty());
    assert_eq!(
        logs.lines()
            .iter()
            .filter(|l| l.contains(NO_CONVERSATION_REASON))
            .count(),
        2
    );
    // The slot is free again: a fresh start for the session runs.
    let fresh = c.start(sid, json!({}), 1);
    c.send(&fresh.msg);
    c.first_event("exit").await;
    assert!(c.acks(fresh.cid)[0].accepted);
    assert!(!drv.starts()[0].resume);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_has_conversation_seam_decides_the_resume_check() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({})));
    let asked = Arc::new(Mutex::new(Vec::<String>::new()));
    let a = asked.clone();
    c.make(
        drv.clone(),
        Make {
            has_conversation: Some(Arc::new(move |_: &Path, id: &str| {
                a.lock().unwrap().push(id.to_string());
                true
            })),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let start = c.start(
        Uuid::new_v4(),
        json!({ "resume_claude_session_id": "claude-abc" }),
        1,
    );
    c.send(&start.msg);
    c.first_event("exit").await;
    assert_eq!(*asked.lock().unwrap(), ["claude-abc"]);
    assert_eq!(drv.starts()[0].claude_session_id, "claude-abc");
    assert!(drv.starts()[0].resume);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sends_the_last_stderr_lines_on_exit_stderr_tail() {
    let c = Ctx::new().await;
    let stderr = |t: &str| {
        FakeTurnAction::Emit(DriverEvent::Output {
            stream: OutputStream::Stderr,
            text: t.into(),
        })
    };
    let drv = driver(script(vec![vec![
        stderr("line 1\nNo conversation "),
        stderr("found with session ID: x\n"),
        FakeTurnAction::crash(Some(1)),
    ]]));
    c.make(drv, Make::default());
    c.registered_and_asked().await;
    let start = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&start.msg);
    let exit = c.first_data("exit").await;
    assert_eq!(
        exit,
        json!({
            "command_id": start.cid,
            "code": 1,
            "signal": null,
            "stderr_tail": "line 1\nNo conversation found with session ID: x\n",
        })
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parks_after_ask_user_process_alive_and_feeds_send_input_into_the_live_process() {
    let c = Ctx::new().await;
    let options = json!({
        "multi_select": false,
        "items": [{ "label": "postgres", "description": "recommended" }, { "label": "sqlite" }],
    });
    let drv = Arc::new(FakeClaudeDriver::new(FakeClaudeScript::new(vec![
        FakeTurn::from(vec![FakeTurnAction::ask_user_with_options(
            "Which DB?",
            serde_json::from_value(options.clone()).unwrap(),
        )]),
        FakeTurn::dynamic(|answer| vec![complete_with(json!({ "db": answer }))]),
    ])));
    c.orch
        .set_heartbeat_interval_ms(std::num::NonZeroU64::new(30).unwrap());
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("ask_user").await;
    // Questions UX: the options travel in the session_event as given.
    assert_eq!(
        c.data("ask_user")[0],
        json!({ "question": "Which DB?", "options": options })
    );
    // Parked: the process is still alive after its turn ended.
    wait_ms(50).await;
    assert!(!drv.last().unwrap().exited());
    assert!(c.events(Some("exit")).is_empty());
    let hb = c
        .until(|| {
            c.of_type("heartbeat")
                .into_iter()
                .find(|h| !h["payload"]["sessions"].as_array().unwrap().is_empty())
        })
        .await;
    assert_eq!(
        hb["payload"]["sessions"],
        json!([{ "session_id": sid, "fencing_token": 1 }])
    );
    let (input, cid) = send_input(sid, "postgres");
    c.send(&input);
    c.first_event("exit").await;
    assert_eq!(drv.last().unwrap().inputs(), ["postgres"]);
    assert_eq!(
        c.data("complete_state")[0],
        json!({ "result": { "db": "postgres" } })
    );
    assert!(c.acks(cid)[0].accepted);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn u_028_an_outcome_less_turn_gets_one_nudge_the_agent_then_completes() {
    let c = Ctx::new().await;
    let drv = driver(script(vec![
        vec![say("I made the change.")],
        vec![complete_with(json!({ "ok": true }))],
    ]));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    c.first_event("exit").await;
    assert_eq!(drv.last().unwrap().inputs(), [NO_OUTCOME_NUDGE]);
    assert_eq!(
        NO_OUTCOME_NUDGE,
        "You must finish by calling complete_state with your result, or ask_user if you need a human"
    );
    assert_eq!(
        c.data("complete_state"),
        [json!({ "result": { "ok": true } })]
    );
    assert!(c.events(Some("no_outcome")).is_empty());
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn u_028_a_second_outcome_less_turn_emits_no_outcome_parked_an_answer_re_arms_the_nudge() {
    let c = Ctx::new().await;
    let drv = Arc::new(FakeClaudeDriver::new(FakeClaudeScript::new(vec![
        FakeTurn::from(vec![say("first")]),
        FakeTurn::from(vec![say("still no outcome")]),
        // After the human answer: outcome-less again → a new nudge, then complete.
        FakeTurn::dynamic(|answer| vec![say(&format!("got {answer}"))]),
        FakeTurn::from(vec![complete_with(json!({ "done": true }))]),
    ])));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("no_outcome").await;
    assert_eq!(
        c.data("no_outcome"),
        [json!({ "last_output": "first\nstill no outcome" })]
    );
    assert_eq!(drv.last().unwrap().inputs(), [NO_OUTCOME_NUDGE]);
    // Parked like after ask_user: the process stays alive, no further nudge.
    wait_ms(50).await;
    assert!(!drv.last().unwrap().exited());
    assert_eq!(drv.last().unwrap().inputs().len(), 1);

    c.send(&send_input(sid, "go on").0);
    c.first_event("exit").await;
    assert_eq!(
        drv.last().unwrap().inputs(),
        [NO_OUTCOME_NUDGE, "go on", NO_OUTCOME_NUDGE]
    );
    assert_eq!(
        c.data("complete_state"),
        [json!({ "result": { "done": true } })]
    );
    assert_eq!(c.events(Some("no_outcome")).len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn u_028_no_outcome_carries_only_the_tail_of_the_assistant_output() {
    let c = Ctx::new().await;
    let long = "x".repeat(NO_OUTCOME_OUTPUT_CHARS);
    let drv = driver(script(vec![vec![say("head")], vec![say(&long)]]));
    c.make(drv, Make::default());
    c.registered_and_asked().await;
    c.send(&c.start(Uuid::new_v4(), json!({}), 1).msg);
    let ev = c.first_data("no_outcome").await;
    assert_eq!(ev["last_output"], json!(long));
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_send_input_with_no_live_process_when_the_process_is_gone() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    c.send(&c.start(sid, json!({}), 1).msg);
    c.first_event("exit").await;
    let (input, cid) = send_input(sid, "x");
    c.send(&input);
    assert_eq!(
        c.ack(cid).await,
        json!({ "command_id": cid, "accepted": false, "reason": "no_live_process" })
    );
    assert_eq!(c.ack_frames(cid)[0]["session_id"], json!(sid));
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_start_session_with_max_sessions_and_memory_pressure() {
    let c = Ctx::new().await;
    c.make(driver(script(vec![vec![ask("hold")]])), Make::default());
    c.registered_and_asked().await;
    let a = c.start(Uuid::new_v4(), json!({}), 1);
    let b = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&a.msg);
    c.send(&b.msg);
    c.until_true(|| c.events(Some("ask_user")).len() == 2).await;
    let third = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&third.msg);
    assert_eq!(c.ack(third.cid).await["reason"], "max_sessions");

    // Free one slot, then fail on memory.
    c.send(&kill(a.sid, Some(Uuid::new_v4()), None, "cancel", 1));
    c.first_event("exit").await;
    c.set_mem_free(100);
    let d = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&d.msg);
    assert_eq!(c.ack(d.cid).await["reason"], "memory_pressure");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_arms_request_work_after_a_memory_pressure_refusal_of_an_assigned_session_max_sessions_1()
 {
    const WORK_POLL_MS: u64 = 300;
    let c = Ctx::new().await;
    let sid = Uuid::new_v4();
    // The test sends the work_assignment itself, then the start_session, on the same socket: an
    // auto-reply could reach the daemon after the start (seen on the Windows runner), and the
    // assignment would then hold the only slot for the whole hold.
    c.orch.set_work_reply(|_| None);
    c.make(
        driver(complete(json!({}))),
        Make {
            max_sessions: Some("1"),
            env: vec![("CONDUCTOR_WORK_POLL_MS", WORK_POLL_MS.to_string())],
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    c.send(&work_assignment(sid));
    c.set_mem_free(100);
    let s = c.start(sid, json!({}), 1);
    c.send(&s.msg);
    let ack = c.ack(s.cid).await;
    let refused_at = std::time::Instant::now();
    assert_eq!(ack["reason"], "memory_pressure");
    // The assignment held the only slot: no request_work was sent while it was held.
    assert_eq!(c.of_type("request_work").len(), 1);
    c.until_true(|| c.of_type("request_work").len() == 2).await;
    let waited = refused_at.elapsed().as_millis() as u64;
    // Waits ~work_poll_ms (no claim/refuse spin), but does not stall.
    assert!(waited >= WORK_POLL_MS - 50, "waited {waited} ms");
    assert!(waited < WORK_POLL_MS + 2000, "waited {waited} ms");
    assert_eq!(c.of_type("request_work")[1]["payload"]["free_slots"], 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_arms_request_work_right_after_a_max_sessions_refusal_and_when_a_hold_expires() {
    let c = Ctx::new().await;
    let assigned = Uuid::new_v4();
    // Sent by the test before the other start, in order (see the memory_pressure case above).
    c.orch.set_work_reply(|_| None);
    c.make(
        driver(complete(json!({}))),
        Make {
            max_sessions: Some("1"),
            config: Some(Box::new(|cfg| cfg.assignment_hold_ms = 300)),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    c.send(&work_assignment(assigned));
    // A start for another session finds the only slot held: refused, the loop stays armed.
    let other = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&other.msg);
    assert_eq!(c.ack(other.cid).await["reason"], "max_sessions");
    assert_eq!(c.of_type("request_work").len(), 1);
    // The assigned session's start_session never arrives: the hold expires and frees the slot.
    c.until_true(|| c.of_type("request_work").len() == 2).await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_start_failed_when_the_repo_cannot_be_cloned() {
    let c = Ctx::new().await;
    c.make(driver(complete(json!({}))), Make::default());
    c.registered_and_asked().await;
    let s = c.start(
        Uuid::new_v4(),
        json!({ "repo": c.tmp.join("missing").to_string_lossy() }),
        1,
    );
    c.send(&s.msg);
    let ack = c.ack(s.cid).await;
    assert_eq!(ack["accepted"], false);
    assert!(
        ack["reason"]
            .as_str()
            .unwrap()
            .starts_with("start_failed: "),
        "{ack}"
    );
    c.done().await;
}

/// 06 §Attachments (Rust only): a start with attachments downloads them before the spawn. Here
/// the orchestrator (the fake, WS only) can't serve them: the start still spawns, the prompt says
/// what couldn't be downloaded, and Claude gets the attachments dir as `--add-dir`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_attachment_download_never_refuses_the_start() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let register = &c.of_type("register")[0];
    assert!(
        register["payload"]["features"]
            .as_array()
            .unwrap()
            .contains(&json!("ticket_attachments"))
    );
    let sid = Uuid::new_v4();
    let start = c.start(
        sid,
        json!({ "attachments": [{
            "id": "00000000-0000-4000-8000-0000000a7002",
            "name": "../mockup.png",
            "mime": "image/png",
            "size": 4,
            "sha256": "a".repeat(64),
        }] }),
        1,
    );
    c.send(&start.msg);
    c.first_event("exit").await;
    assert!(c.acks(start.cid)[0].accepted);
    let opts = drv.starts()[0].clone();
    assert!(
        opts.prompt
            .starts_with("Implement the ticket\n\n## Attachments\n")
    );
    assert!(
        opts.prompt
            .contains("- mockup.png (image) could not be downloaded:"),
        "{}",
        opts.prompt
    );
    let dir = c
        .root()
        .join("artifacts")
        .join(sid.to_string())
        .join("attachments");
    assert_eq!(opts.add_dirs, vec![dir.clone()]);
    assert!(dir.is_dir());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_without_attachments_adds_no_dir() {
    let c = Ctx::new().await;
    let drv = driver(complete(json!({ "summary": "done" })));
    c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let start = c.start(Uuid::new_v4(), json!({}), 1);
    c.send(&start.msg);
    c.first_event("exit").await;
    let opts = drv.starts()[0].clone();
    assert_eq!(opts.prompt, "Implement the ticket");
    assert!(opts.add_dirs.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passes_the_remaining_budget_as_max_budget_usd_on_a_resume_too_and_omits_zero() {
    // 09 §Budgets, TD-022 / U-018: the CLI caps what one process spends, so a resume gets the
    // remaining budget too. 0 (or absent) passes no cap: 0 would stop the CLI at once.
    let c = Ctx::new().await;
    let drv = driver(complete(json!({})));
    let d = c.make(drv.clone(), Make::default());
    c.registered_and_asked().await;
    let claude_id = Uuid::new_v4().to_string();
    let sid = Uuid::new_v4();
    write_transcript_for(&c, &d, sid, &claude_id, false);
    let start = c.start(
        sid,
        json!({ "resume_claude_session_id": claude_id, "prompt": "go on", "max_budget_usd": 1.25 }),
        1,
    );
    c.send(&start.msg);
    c.first_event("exit").await;
    assert!(drv.starts()[0].resume);
    assert_eq!(drv.starts()[0].max_budget_usd, Some(1.25));

    let zero = c.start(Uuid::new_v4(), json!({ "max_budget_usd": 0 }), 1);
    c.send(&zero.msg);
    c.until_true(|| drv.starts().len() == 2).await;
    assert_eq!(drv.starts()[1].max_budget_usd, None);
    c.done().await;
}

/// A `work_assignment` reply to the daemon's request_work, sent by the test itself.
fn work_assignment(sid: Uuid) -> OrchestratorToDaemon {
    cmd(
        "work_assignment",
        sid,
        json!({ "ticket_id": TICKET, "session_id": sid }),
        1,
    )
}
