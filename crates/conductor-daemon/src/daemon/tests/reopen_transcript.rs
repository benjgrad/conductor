//! `reopen-transcript.test.ts`: ADR-0008 on the daemon. `fetch_transcript` → `transcript`
//! (located from the daemon's own store only), and a reopened session's start on a branch still
//! checked out in the earlier session's worktree (that worktree is reused).

use super::*;
use crate::claude::transcript::transcript_path_for;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/transcript.jsonl")
}

fn complete_twice() -> FakeClaudeScript {
    script(vec![
        vec![say("working"), complete_with(json!({ "ok": true }))],
        vec![complete_with(json!({ "ok": 2 }))],
    ])
}

fn make(c: &Ctx, drv: Arc<FakeClaudeDriver>) -> Daemon {
    c.make(
        drv,
        Make {
            max_sessions: Some("3"),
            ..Make::default()
        },
    )
}

fn fetch(c: &Ctx, sid: Uuid) -> Uuid {
    let request_id = Uuid::new_v4();
    c.send(&machine_msg(
        "fetch_transcript",
        json!({ "request_id": request_id, "session_id": sid }),
    ));
    request_id
}

async fn reply(c: &Ctx, request_id: Uuid) -> Value {
    c.until(|| {
        c.of_type("transcript")
            .into_iter()
            .find(|m| m["payload"]["request_id"] == json!(request_id))
    })
    .await
}

/// Start a session and wait for its process to finish; the started worktree and Claude id.
async fn run_to_exit(c: &Ctx, drv: &FakeClaudeDriver, start: &Start) -> (PathBuf, String) {
    c.send(&start.msg);
    c.until(|| {
        c.data("exit")
            .into_iter()
            .find(|e| e["command_id"] == json!(start.cid))
    })
    .await;
    let started = c
        .data("started")
        .into_iter()
        .find(|s| s["command_id"] == json!(start.cid))
        .unwrap();
    let opts = drv.starts().last().unwrap().clone();
    (
        PathBuf::from(started["worktree_path"].as_str().unwrap()),
        opts.claude_session_id,
    )
}

fn write_transcript(c: &Ctx, worktree: &Path, claude_id: &str) -> PathBuf {
    let file = transcript_path_for(&c.claude_dir(), worktree, claude_id).unwrap();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::copy(fixture(), &file).unwrap();
    file
}

fn chunks(r: &Value) -> usize {
    r["payload"]["chunks"].as_array().map_or(0, Vec::len)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_with_the_session_transcript_located_from_the_store() {
    let c = Ctx::new().await;
    let drv = driver(complete_twice());
    make(&c, drv.clone());
    c.registered_and_asked().await;
    let sid = Uuid::new_v4();
    let (worktree, claude_id) = run_to_exit(&c, &drv, &c.start(sid, json!({ "env": {} }), 1)).await;

    // Before Claude wrote anything: no_transcript.
    let r0 = reply(&c, fetch(&c, sid)).await;
    assert_eq!(
        r0["payload"],
        json!({ "request_id": r0["payload"]["request_id"], "error": "no_transcript" })
    );
    assert_eq!(r0["session_id"], Value::Null);

    write_transcript(&c, &worktree, &claude_id);
    let r1 = reply(&c, fetch(&c, sid)).await;
    assert!(r1["payload"].get("error").is_none(), "{r1}");
    assert_eq!(r1["payload"]["truncated"], false);
    assert_eq!(chunks(&r1), 11);
    let ch = r1["payload"]["chunks"].as_array().unwrap();
    assert_eq!(ch[0]["stream"], "user");
    assert_eq!(ch[10]["stream"], "assistant");
    assert_eq!(ch[10]["text"], "Created greeting.txt and committed it.");

    // The worktree may be gone (cleaned up): the transcript path doesn't need it.
    crate::test_support::remove_tree::remove_tree_default(&worktree)
        .await
        .unwrap();
    let r2 = reply(&c, fetch(&c, sid)).await;
    assert_eq!(chunks(&r2), 11);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_session_for_a_session_this_daemon_never_ran() {
    let c = Ctx::new().await;
    make(&c, driver(complete_twice()));
    c.registered_and_asked().await;
    let r = reply(&c, fetch(&c, Uuid::new_v4())).await;
    assert_eq!(r["payload"]["error"], "unknown_session");
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reuses_the_old_worktree_resumes_the_claude_session_and_both_transcripts_resolve() {
    let c = Ctx::new().await;
    let drv = driver(complete_twice());
    make(&c, drv.clone());
    c.registered_and_asked().await;
    let old_sid = Uuid::new_v4();
    let (first_wt, first_id) =
        run_to_exit(&c, &drv, &c.start(old_sid, json!({ "env": {} }), 1)).await;
    std::fs::write(first_wt.join("uncommitted.txt"), "keep me\n").unwrap();
    // The fake driver writes no transcript; the resume check needs one on this machine.
    write_transcript(&c, &first_wt, &first_id);

    let new_sid = Uuid::new_v4();
    let start = c.start(
        new_sid,
        json!({
            "env": {},
            "branch": branch_for(old_sid), // carried by the reopen
            "resume_claude_session_id": first_id,
            "prompt": "Make it blue",
        }),
        1,
    );
    let (second_wt, _) = run_to_exit(&c, &drv, &start).await;
    assert!(c.acks(start.cid)[0].accepted);
    assert_eq!(second_wt, first_wt);
    let opts = drv.starts().last().unwrap().clone();
    assert_eq!(opts.cwd, first_wt);
    assert!(opts.resume);
    assert_eq!(opts.claude_session_id, first_id);
    assert_eq!(opts.prompt, "Make it blue");
    // Same files, uncommitted ones too, on the same branch.
    assert_eq!(
        git(&second_wt, &["branch", "--show-current"]),
        branch_for(old_sid)
    );
    assert_eq!(
        std::fs::read_to_string(second_wt.join("uncommitted.txt")).unwrap(),
        "keep me\n"
    );
    for sid in [old_sid, new_sid] {
        let r = reply(&c, fetch(&c, sid)).await;
        assert_eq!(chunks(&r), 11, "{sid}");
    }
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_the_start_while_the_earlier_session_still_has_a_live_process_in_that_worktree() {
    let c = Ctx::new().await;
    make(&c, driver(script(vec![vec![ask("Which port?")]])));
    c.registered_and_asked().await;
    let old_sid = Uuid::new_v4();
    c.send(&c.start(old_sid, json!({ "env": {} }), 1).msg);
    c.first_event("ask_user").await; // parked: alive and idle

    let start = c.start(
        Uuid::new_v4(),
        json!({ "env": {}, "branch": branch_for(old_sid) }),
        1,
    );
    c.send(&start.msg);
    let ack = c.ack(start.cid).await;
    assert_eq!(ack["accepted"], false);
    let reason = ack["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("start_failed: worktree ") && reason.contains(" is in use by session"),
        "{reason}"
    );
    c.done().await;
}
