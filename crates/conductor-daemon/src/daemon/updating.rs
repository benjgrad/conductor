//! ADR-0021 in the daemon core (MR-T14a): what the daemon does with `update_available`, the drain
//! (§2.2–§2.5), the switch (§2.4) and the trial rules (§3). The file-system parts are in
//! `crate::update`; this is the part that needs the daemon's state.
//!
//! 1. `update_available` → [`Policy`] → stage the build in the background (work goes on).
//! 2. Staged, supervised and a trial-aware launcher: **drain**. No more `request_work`,
//!    `heartbeat.draining = {reason: update, version}`; queued commands are still honoured.
//! 3. **Idle** = no live turn, no starting session, no `run_cmd` / `run_action`, no assistant job,
//!    no assignment waiting for its `start_session`. A session parked for a human (`ask_user`,
//!    `no_outcome`) does not block: after the restart the orphan sweep reports it and the
//!    existing resume path picks it up on the next answer.
//! 4. Idle: write `trial`, repoint `current`, and call `on_restart_for_update` (`run` exits 75).
//! 5. Not idle after `UPDATE_MAX_DRAIN_MS`: resume work, `alert drain_timeout`, cool down
//!    (`Policy::failed`).
//!
//! Trial: a daemon started on the version a `trial` names commits it on its first `registered`
//! (`update::commit`), and exits 75 if it reached the server but got no `registered` within
//! `UPDATE_TRIAL_REGISTER_MS` (offline doesn't count: the timer starts when the socket opens).
//! After a rollback, the old version reports each new `bad-versions` entry once.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use conductor_protocol::{AlertPayload, UpdateAvailablePayload, UpdateFailedStage};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{Core, DurableMessage, State, Timer, wire};
use crate::claude::outcome_server::iso_string;
use crate::config::read_file_config;
use crate::update::layout::{bad_versions, mark_reported, read_trial};
use crate::update::policy::{Decision, Policy};
use crate::update::switch::{CanSwitch, can_switch, switch};
use crate::update::{DaemonBuild, UpdateError, alert_error, commit};

/// While draining, how often idleness is re-checked (it is also checked whenever work ends).
pub const DRAIN_CHECK_MS: u64 = 5_000;

/// A drain in progress.
pub(super) struct Drain {
    version: String,
    from: String,
    deadline: Timer,
    tick: Option<Timer>,
}

/// The daemon's update state (in `State`).
#[derive(Default)]
pub(super) struct UpdateState {
    policy: Policy,
    drain: Option<Drain>,
    /// Messages logged once per process (ADR-0021 §2.6 "logs … once").
    logged: HashSet<String>,
    /// `current` was switched: the process is on its way out.
    switched: bool,
    /// The 120 s connected-but-unregistered timer of a trial start.
    trial_timer: Option<Timer>,
}

impl UpdateState {
    /// Draining (or switched): no new work is asked for.
    pub(super) fn holds_work(&self) -> bool {
        self.drain.is_some() || self.switched
    }
}

impl Core {
    fn update_now_ms(&self) -> u64 {
        self.clock_start.elapsed().as_millis() as u64
    }

    fn log_once(&self, st: &mut State, msg: String) {
        if st.update.logged.insert(msg.clone()) {
            self.log(&msg);
        }
    }

    /// ADR-0021 §1: the orchestrator says this machine is behind.
    pub(super) fn on_update_available(&self, st: &mut State, p: UpdateAvailablePayload) {
        let build = DaemonBuild::from(&p);
        let root = &self.config.root_dir;
        let auto_update = read_file_config(root).map_or(true, |c| c.auto_update);
        let decision = st.update.policy.decide(
            &build.version,
            &self.config.daemon_version,
            auto_update,
            &bad_versions(root),
            self.update_now_ms(),
        );
        match decision {
            Decision::Ignore(why) => self.log_once(st, why),
            Decision::Stage => {
                let Some(core) = self.arc() else {
                    st.update.policy.idle();
                    return;
                };
                self.log(&format!("update {}: staging {}", build.version, build.file));
                let stage = self.stage_update.clone();
                tokio::spawn(async move {
                    let r = stage(build.clone()).await;
                    let st = &mut core.lock();
                    if !st.stopped {
                        core.update_staged(st, build, r);
                    }
                });
            }
        }
    }

    fn update_staged(&self, st: &mut State, build: DaemonBuild, r: Result<PathBuf, UpdateError>) {
        let v = build.version;
        match r {
            Err(e) => {
                self.log(&format!("update {v} failed: {e}"));
                st.update.policy.failed(self.update_now_ms());
                self.send_update_alert(st, &v, e.stage, &e.error);
            }
            Ok(dir) => match can_switch(self.supervised.as_deref(), &self.config.root_dir, &v) {
                CanSwitch::No(msg) => {
                    self.log_once(st, msg);
                    st.update.policy.idle();
                }
                CanSwitch::Yes { from } => {
                    self.log(&format!(
                        "update {v} staged in {}; draining: no new work until running work ends",
                        dir.display()
                    ));
                    self.begin_drain(st, v, from);
                }
            },
        }
    }

    fn begin_drain(&self, st: &mut State, version: String, from: String) {
        let deadline = self.after(st, self.update_max_drain_ms, |c, st, id| {
            if st
                .update
                .drain
                .as_ref()
                .is_some_and(|d| d.deadline.id == id)
            {
                c.abandon_drain(
                    st,
                    UpdateFailedStage::DrainTimeout,
                    &format!(
                        "work was still running after {} min; the update was put off",
                        c.update_max_drain_ms / 60_000
                    ),
                );
            }
        });
        st.update.drain = Some(Drain {
            version,
            from,
            deadline,
            tick: None,
        });
        // Tell the orchestrator now (machine.status = draining), not at the next heartbeat.
        self.send_heartbeat(st);
        self.check_drained(st);
    }

    /// `heartbeat.draining`, while draining.
    pub(super) fn draining_payload(&self, st: &State) -> Option<Value> {
        st.update
            .drain
            .as_ref()
            .map(|d| json!({ "reason": "update", "version": d.version }))
    }

    /// Nothing is running that a restart would cut (see the module doc, 3).
    fn update_idle(&self, st: &State) -> bool {
        st.startings.is_empty()
            && st.assignments.is_empty()
            && st.live.values().all(|l| l.cmds.is_empty())
            && st
                .agents
                .values()
                .all(|a| a.exited || (a.ask_pending && a.turn_over))
            && self.assistant.admitted() == 0
    }

    /// While draining: switch when idle, else look again in DRAIN_CHECK_MS.
    pub(super) fn check_drained(&self, st: &mut State) {
        let Some(d) = st.update.drain.as_mut() else {
            return;
        };
        if let Some(t) = d.tick.take() {
            t.cancel();
        }
        if !self.update_idle(st) {
            let tick = self.after(st, DRAIN_CHECK_MS, |c, st, id| {
                if st
                    .update
                    .drain
                    .as_ref()
                    .and_then(|d| d.tick.as_ref())
                    .is_some_and(|t| t.id == id)
                {
                    c.check_drained(st);
                }
            });
            if let Some(d) = st.update.drain.as_mut() {
                d.tick = Some(tick);
            }
            return;
        }
        let Some(d) = st.update.drain.take() else {
            return;
        };
        d.deadline.cancel();
        match switch(&self.config.root_dir, &d.from, &d.version) {
            Ok(()) => {
                st.update.switched = true;
                self.log(&format!(
                    "update {}: idle; switched current from {}; restarting",
                    d.version, d.from
                ));
                (self.on_restart_for_update)();
            }
            Err(e) => self.give_up(
                st,
                &d.version,
                UpdateFailedStage::Unpack,
                &format!("could not switch to it: {e}"),
            ),
        }
    }

    /// Give up this drain: take work again, tell a human, cool down.
    fn abandon_drain(&self, st: &mut State, stage: UpdateFailedStage, error: &str) {
        let Some(d) = st.update.drain.take() else {
            return;
        };
        d.deadline.cancel();
        if let Some(t) = d.tick {
            t.cancel();
        }
        self.give_up(st, &d.version, stage, error);
    }

    /// After a drain ended without a switch: count it, tell a human, take work again.
    fn give_up(&self, st: &mut State, version: &str, stage: UpdateFailedStage, error: &str) {
        self.log(&format!("update {version} put off: {error}"));
        st.update.policy.failed(self.update_now_ms());
        self.send_update_alert(st, version, stage, error);
        self.send_heartbeat(st);
        self.maybe_request_work(st);
    }

    /// `alert {kind: update_failed}`: durable, like a session event (the Machines page shows it).
    pub(super) fn send_update_alert(
        &self,
        st: &State,
        version: &str,
        stage: UpdateFailedStage,
        error: &str,
    ) {
        let payload = json!({
            "kind": "update_failed",
            "version": version,
            "stage": stage,
            "error": alert_error(error),
            "at": iso_string(SystemTime::now()),
        });
        match wire::<AlertPayload>(payload) {
            Ok(payload) => self.push_durable(
                st,
                DurableMessage::Alert {
                    msg_id: Uuid::new_v4(),
                    session_id: (),
                    fencing_token: (),
                    payload,
                },
            ),
            Err(e) => self.log(&format!("bug: an invalid update_failed alert: {e}")),
        }
    }

    /// The socket opened. On a trial start, arm the 120 s connected-but-unregistered rule.
    pub(super) fn update_on_open(&self, st: &mut State) {
        if st.update.trial_timer.is_some() {
            return;
        }
        let own = &self.config.daemon_version;
        if !read_trial(&self.config.root_dir).is_some_and(|t| &t.to == own) {
            return;
        }
        st.update.trial_timer = Some(self.after(st, self.update_trial_register_ms, |c, st, id| {
            if !st.update.trial_timer.as_ref().is_some_and(|t| t.id == id) {
                return;
            }
            st.update.trial_timer = None;
            if st.registered || st.stopped {
                return;
            }
            c.log(&format!(
                "trial of {}: the server was reached but no registered came in {} s; exiting \
                 so the launcher counts a failed start",
                c.config.daemon_version,
                c.update_trial_register_ms / 1000
            ));
            st.update.switched = true;
            (c.on_restart_for_update)();
        }));
    }

    /// `registered`: commit a trial of this version, clean up, report rollbacks once.
    pub(super) fn update_on_registered(&self, st: &mut State) {
        if let Some(t) = st.update.trial_timer.take() {
            t.cancel();
        }
        let root = self.config.root_dir.clone();
        let r = commit::on_registered(&root, &self.config.daemon_version);
        if let Some(t) = &r.committed {
            self.log(&format!(
                "update to {} committed (from {}); removed old versions: {}",
                t.to,
                t.from,
                if r.removed.is_empty() {
                    "none".to_string()
                } else {
                    r.removed.join(", ")
                }
            ));
        }
        for v in r.to_report {
            self.log(&format!(
                "update {v} was rolled back by the launcher (it failed to start); reporting it"
            ));
            self.send_update_alert(
                st,
                &v,
                UpdateFailedStage::Trial,
                &format!("{v} failed to start; the launcher rolled back to the previous version"),
            );
            if let Err(e) = mark_reported(&root, &v) {
                self.log(&format!("cannot record that {v} was reported: {e}"));
            }
        }
    }

    /// `stop()`: cancel the update timers.
    pub(super) fn update_stop(&self, st: &mut State) {
        if let Some(d) = st.update.drain.take() {
            d.deadline.cancel();
            if let Some(t) = d.tick {
                t.cancel();
            }
        }
        if let Some(t) = st.update.trial_timer.take() {
            t.cancel();
        }
    }
}

/// The default `stage_update`: `update::stage` from the orchestrator's HTTP origin.
pub(super) fn default_stage(root: PathBuf, orchestrator_url: String) -> super::StageUpdateFn {
    let probe = crate::update::stage::run_version_probe();
    Arc::new(move |build: DaemonBuild| {
        let (root, url, probe) = (root.clone(), orchestrator_url.clone(), probe.clone());
        Box::pin(async move {
            let Some(base) = crate::attachments::http_base(&url) else {
                return Err(UpdateError::new(
                    UpdateFailedStage::Download,
                    format!("{url} has no http(s) origin"),
                ));
            };
            crate::update::stage(&root, &base, &build, &probe).await
        })
    })
}
