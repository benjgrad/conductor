//! R4 (Rust only): the daemon core's side of the outcome server's `run_gate` (05 §Self-checks).
//!
//! The agent asks for the checks of a transition it intends to take. In order:
//!   1. the worktree must be clean (FR-3): otherwise the agent is told to commit, and nothing is
//!      sent anywhere;
//!   2. the orchestrator says what the transition's gate runs (repo override applied) and records
//!      the call (`actions::run_gate::fetch_spec`);
//!   3. the checks run like a gate step's (`run_cmd_work`): in a fresh conductor-owned checkout of
//!      HEAD (its own, never the session's held gate checkout), the setup first, each command
//!      through the build semaphore (`CommandRunner`, so `build_slot` and the output stream reach
//!      the board), stopping at the first failure;
//!   4. the outcome goes back to the orchestrator (best effort) and to the agent as text.
//!
//! Nothing reaches the engine: no `cmd_exit`, no move step, no counter (FR-2). The run is
//! registered among the session's commands, so a `kill` of the session cancels it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;
use uuid::Uuid;

use super::{Core, RunningCmd};
use crate::actions::checkout::{
    FreshCheckout, FreshCheckoutInput, detect_setup, fetch_budget, fresh_checkout, managed_command,
    missing_manager, no_commits_ahead, remove_checkout,
};
use crate::actions::open_pr::check_clean;
use crate::actions::run_gate::{
    DIRTY_TEXT, GateOutcome, GateSpec, ItemOutcome, RUN_GATE_BUDGET, Status, fetch_spec,
    format_run_gate, parse_duration, post_result,
};
use crate::attachments::upload::AttachTarget;
use crate::claude::driver::RunGateHook;
use crate::claude::outcome_server::RunGateRequest;
use crate::commands::runner::{CancelToken, CommandOutputChunk, CommandRunner, RunCommandOptions};
use crate::ports::port_env;
use crate::store::PortRange;

/// FR-3: the agent's text for a dirty worktree (pure).
pub(crate) fn dirty_text(lines: &[String]) -> String {
    let shown: Vec<&str> = lines.iter().take(30).map(String::as_str).collect();
    let more = lines.len().saturating_sub(shown.len());
    let mut t = format!("{DIRTY_TEXT}\n{}", shown.join("\n"));
    if more > 0 {
        t.push_str(&format!("\n… and {more} more"));
    }
    t
}

/// What one `exec` needs besides the command.
struct ExecCtx {
    sid: Uuid,
    token: i64,
    cmd_id: Uuid,
    ticket_id: String,
    range: PortRange,
    runner: Arc<dyn CommandRunner>,
    cancel: CancelToken,
}

impl Core {
    /// The `run_gate` handler of a working agent's session (`DriverStartOptions.run_gate`).
    pub(super) fn run_gate_hook(&self, sid: Uuid, token: i64, target: AttachTarget) -> RunGateHook {
        let weak = self.me.clone();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        RunGateHook(Arc::new(move |req: RunGateRequest| {
            let (weak, client, target) = (weak.clone(), client.clone(), target.clone());
            Box::pin(async move {
                let Some(core) = weak.upgrade() else {
                    return Err("the conductor daemon is shutting down".to_string());
                };
                core.run_gate(sid, token, &client, &target, &req.transition)
                    .await
            })
        }))
    }

    /// The whole run: Ok(the text for the agent, pass, fail or refused), Err(why nothing ran).
    async fn run_gate(
        &self,
        sid: Uuid,
        token: i64,
        client: &reqwest::Client,
        target: &AttachTarget,
        transition: &str,
    ) -> Result<String, String> {
        let s = self.store().session(&sid.to_string()).cloned();
        let Some(s) = s.filter(|s| Path::new(&s.worktree_path).exists()) else {
            return Err("this session's worktree is gone".into());
        };
        let wt = PathBuf::from(&s.worktree_path);
        // FR-3: only committed work is checked, as the gate does; nothing is sent when dirty.
        let clean = check_clean(&wt, None).await;
        if let Some(lines) = &clean.dirty {
            return Ok(dirty_text(lines));
        }
        let Some(head) = clean.head else {
            return Err("could not resolve your HEAD commit".into());
        };
        let spec = fetch_spec(client, target, transition, &head).await?;
        let cancel = CancelToken::new();
        let cmd_id = Uuid::new_v4();
        let (runner, range) = {
            let mut st = self.lock();
            let range = self.allocate_ports(&mut st, &sid)?;
            st.live.entry(sid).or_default().cmds.insert(
                cmd_id,
                RunningCmd {
                    fencing_token: token,
                    cancel: cancel.clone(),
                },
            );
            (self.command_runner(&mut st), range)
        };
        self.touch(&sid);
        // The budget: past it, the running command is killed and the rest is not run.
        let over = Arc::new(AtomicBool::new(false));
        let timer = {
            let (over, cancel) = (over.clone(), cancel.clone());
            tokio::spawn(async move {
                tokio::time::sleep(RUN_GATE_BUDGET).await;
                over.store(true, Ordering::SeqCst);
                cancel.cancel();
            })
        };
        let ctx = ExecCtx {
            sid,
            token,
            cmd_id,
            ticket_id: s.ticket_id.clone(),
            range,
            runner,
            cancel: cancel.clone(),
        };
        let started = Instant::now();
        let mut outcome = self.gate_work(&ctx, &wt, &s.branch, &head, &spec).await;
        timer.abort();
        if over.load(Ordering::SeqCst) && outcome.not_run.is_none() {
            outcome.not_run = Some(format!(
                "run_gate stops after {} min (the gate itself has no such limit)",
                RUN_GATE_BUDGET.as_secs() / 60
            ));
        } else if cancel.is_cancelled() && outcome.not_run.is_none() {
            outcome.not_run = Some("the session was stopped".into());
        }
        outcome.duration_ms = started.elapsed().as_millis() as u64;
        {
            let mut st = self.lock();
            if let Some(l) = st.live.get_mut(&sid) {
                l.cmds.remove(&cmd_id);
            }
        }
        if let Err(e) = post_result(client, target, &outcome.result_body(&spec.run_id)).await {
            self.log(&format!("session {sid}: run_gate result not recorded: {e}"));
        }
        self.debug_line(
            sid,
            token,
            &format!(
                "conductor: run_gate {} on {head}: {}",
                spec.transition,
                if outcome.passed() { "passed" } else { "failed" }
            ),
        );
        Ok(format_run_gate(&outcome))
    }

    /// Steps 3: the fresh checkout, the setup, the checks (the checkout always goes).
    async fn gate_work(
        &self,
        ctx: &ExecCtx,
        wt: &Path,
        branch: &str,
        head: &str,
        spec: &GateSpec,
    ) -> GateOutcome {
        let mut out = GateOutcome {
            transition: spec.transition.clone(),
            sha: head.to_string(),
            setup: None,
            checks: Vec::new(),
            not_run: None,
            duration_ms: 0,
        };
        let skip_all = |out: &mut GateOutcome, why: String| {
            out.not_run = Some(why);
            out.checks = spec
                .checks
                .iter()
                .map(|c| ItemOutcome::skipped(&c.name))
                .collect();
        };
        if let Some(base) = no_commits_ahead(wt, head, None).await {
            skip_all(
                &mut out,
                format!(
                    "the branch `{branch}` has no commits ahead of {base}, so there is nothing to check"
                ),
            );
            return out;
        }
        self.debug_line(
            ctx.sid,
            ctx.token,
            &format!(
                "conductor: run_gate {}: a fresh checkout of {head}",
                spec.transition
            ),
        );
        let longest = spec
            .checks
            .iter()
            .filter_map(|c| c.timeout.as_deref().and_then(parse_duration))
            .max();
        let dir = match fresh_checkout(&FreshCheckoutInput {
            root: self.config.root_dir.clone(),
            worktree: wt.to_path_buf(),
            branch: branch.to_string(),
            sha: head.to_string(),
            env: None,
            timeout: Some(fetch_budget(longest)),
        })
        .await
        {
            FreshCheckout::Ok { dir, .. } => dir,
            FreshCheckout::Err { error, .. } => {
                skip_all(&mut out, format!("the fresh checkout failed: {error}"));
                return out;
            }
        };
        self.gate_items(ctx, &dir, spec, &mut out).await;
        remove_checkout(&dir);
        out
    }

    async fn gate_items(&self, ctx: &ExecCtx, dir: &Path, spec: &GateSpec, out: &mut GateOutcome) {
        let mut stopped = false;
        if let Some(setup) = detect_setup(dir, spec.setup.as_deref()) {
            let item = self.gate_exec(ctx, dir, &setup, &setup, None).await;
            stopped = item.status != Status::Pass;
            out.setup = Some(item);
        }
        for c in &spec.checks {
            if stopped || ctx.cancel.is_cancelled() {
                out.checks.push(ItemOutcome::skipped(&c.name));
                continue;
            }
            let cmd = managed_command(dir, &c.cmd);
            let timeout = c.timeout.as_deref().and_then(parse_duration);
            let item = self.gate_exec(ctx, dir, &c.name, &cmd, timeout).await;
            stopped = item.status != Status::Pass;
            out.checks.push(item);
        }
    }

    /// One command, through the build semaphore; a missing package manager is `not_run`.
    async fn gate_exec(
        &self,
        ctx: &ExecCtx,
        dir: &Path,
        name: &str,
        cmd: &str,
        timeout: Option<Duration>,
    ) -> ItemOutcome {
        let mut item = ItemOutcome::skipped(name);
        if let Some(missing) = missing_manager(cmd, None) {
            item.status = Status::NotRun;
            item.output = missing;
            return item;
        }
        self.debug_line(
            ctx.sid,
            ctx.token,
            &format!("conductor: run_gate: `{cmd}` in a fresh checkout"),
        );
        let mut o = RunCommandOptions::new(ctx.cmd_id, ctx.sid, cmd, dir);
        o.timeout = timeout;
        let mut env = BTreeMap::new();
        env.insert("CONDUCTOR_SESSION_ID".into(), ctx.sid.to_string());
        env.insert("CONDUCTOR_TICKET_ID".into(), ctx.ticket_id.clone());
        env.extend(port_env(ctx.range));
        env.extend(self.git_env());
        o.env = env;
        o.cancel = Some(ctx.cancel.clone());
        let (sid, token) = (ctx.sid, ctx.token);
        let weak = self.me.clone();
        o.on_output = Some(Arc::new(move |c: CommandOutputChunk| {
            if let Some(core) = weak.upgrade() {
                let st = core.lock();
                core.send_output(&st, sid, token, c.stream.as_str(), &c.text);
            }
        }));
        let weak = self.me.clone();
        o.on_waiting_for_slot = Some(Arc::new(move |waiting: bool| {
            if let Some(core) = weak.upgrade() {
                let st = core.lock();
                core.emit(
                    &st,
                    sid,
                    token,
                    json!({ "kind": "build_slot", "data": { "waiting": waiting } }),
                );
            }
        }));
        match ctx.runner.run(o).await {
            Ok(r) => {
                item.status = if r.exit_code == Some(0) && !r.timed_out {
                    Status::Pass
                } else {
                    Status::Fail
                };
                item.exit_code = r.exit_code;
                item.timed_out = r.timed_out;
                item.duration_ms = r.duration_ms;
                item.output = r.output_tail;
            }
            Err(e) => {
                item.status = Status::NotRun;
                item.output = format!("could not run it: {e}");
            }
        }
        item
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dirty_text_tells_the_agent_to_commit_and_lists_the_files() {
        let lines: Vec<String> = (0..35).map(|i| format!("?? f{i}.txt")).collect();
        let t = dirty_text(&lines);
        assert!(t.starts_with("Not run: you have uncommitted changes. Commit them first"));
        assert!(t.contains("?? f0.txt"));
        assert!(t.contains("?? f29.txt"));
        assert!(!t.contains("?? f30.txt"));
        assert!(t.ends_with("… and 5 more"));
    }
}
