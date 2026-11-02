//! Port of `packages/daemon/src/store.ts` (MR-T05). The daemon's durable local state (03
//! §Delivery guarantees, 10-contracts §Daemon seq dedupe): the last assigned seq, the buffered
//! durable messages not yet confirmed by `registered.last_seq`, the command_id dedupe set (with the
//! ack each command got), and per-session facts (worktree, branch, port range, pre-assigned Claude
//! session id). One JSON file, `<root>/state/daemon.json`, written atomically (tmp + rename) and
//! synchronously, so a fact is on disk before the daemon acts on it (e.g. the Claude session id
//! before spawning).
//!
//! The file is the TS file: camelCase keys, the same shapes. A file either daemon wrote is read by
//! the other (tests/compat_ts_files.rs and `packages/daemon/src/rust-compat.test.ts`). Key order
//! inside `sessions` and `repos` is sorted here, insertion order in TS; neither reader cares.

use conductor_protocol::{DaemonToOrchestrator, PermissionRequestPayload, SessionEventPayload};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};

/// A durable daemon message without its `seq`: what TS's `DurableMessage` is (`session_event`,
/// and ADR-0023's `permission_request`, buffered and replayed the same way). Built from the
/// protocol's payload types; [`DurableMessage::with_seq`] makes the wire frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DurableMessage {
    #[serde(rename = "session_event")]
    SessionEvent {
        msg_id: uuid::Uuid,
        session_id: uuid::Uuid,
        fencing_token: i64,
        payload: SessionEventPayload,
    },
    #[serde(rename = "permission_request")]
    PermissionRequest {
        msg_id: uuid::Uuid,
        session_id: uuid::Uuid,
        fencing_token: i64,
        payload: PermissionRequestPayload,
    },
}

impl DurableMessage {
    /// The frame to send, with its seq.
    pub fn with_seq(&self, seq: i64) -> DaemonToOrchestrator {
        match self.clone() {
            DurableMessage::SessionEvent {
                msg_id,
                session_id,
                fencing_token,
                payload,
            } => DaemonToOrchestrator::SessionEvent {
                fencing_token,
                msg_id,
                payload,
                seq,
                session_id,
            },
            DurableMessage::PermissionRequest {
                msg_id,
                session_id,
                fencing_token,
                payload,
            } => DaemonToOrchestrator::PermissionRequest {
                fencing_token,
                msg_id,
                payload,
                seq,
                session_id,
            },
        }
    }
}

/// A durable message waiting for confirmation. `seq` is None until the daemon is registered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BufferedEvent {
    pub seq: Option<i64>,
    pub msg: DurableMessage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AckRecord {
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortRange {
    pub base: u32,
    pub count: u32,
}

/// The live Claude process (its start_session command_id and fencing token), cleared on exit.
/// BUG-1b: it is killed at daemon start only if the pid's start time equals `started_at` and its
/// argv is the Claude binary with `--session-id`/`--resume <claude_session_id>` (`orphan`). An
/// entry without `started_at` (BUG-1's build) is never killed, only cleared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub command_id: String,
    pub fencing_token: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    /// ms epoch, the process's start time from `ps lstart` (1 s precision), read at spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub ticket_id: String,
    pub repo: String,
    pub worktree_path: String,
    pub branch: String,
    pub port_range: Option<PortRange>,
    /// Pre-assigned (new) or resumed Claude session id of the latest worker start_session. A
    /// requirements reviewer's (`start_session.review`, ADR-0009) is never stored here.
    pub claude_session_id: Option<String>,
    /// ms epoch; used to pick which idle session's port range to reclaim first.
    pub last_used_at: i64,
    /// TS `agent?: {…} | null`: absent (None), `null` (Some(None)) or set; all three round-trip.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "absent_or_null"
    )]
    pub agent: Option<Option<AgentRecord>>,
}

/// `Option<Option<T>>` ⇄ absent / `null` / value.
mod absent_or_null {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(), // skipped by skip_serializing_if
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

/// The file, in TS key order. Unknown top-level keys are kept (TS spread them back in).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    last_seq: Option<i64>,
    #[serde(default)]
    events: Vec<BufferedEvent>,
    #[serde(default)]
    acks: Vec<(String, AckRecord)>,
    #[serde(default)]
    sessions: BTreeMap<String, PersistedSession>,
    /// repo → shared clone path.
    #[serde(default)]
    repos: BTreeMap<String, String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn one() -> u32 {
    1
}

impl Default for StateFile {
    fn default() -> Self {
        StateFile {
            version: 1,
            last_seq: None,
            events: Vec::new(),
            acks: Vec::new(),
            sessions: BTreeMap::new(),
            repos: BTreeMap::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// Most recent command_ids kept for dedupe.
pub const MAX_ACKS: usize = 2000;
// TD-025: the event buffer is trimmed only by `registered.last_seq` (there is no per-event ack in
// the protocol); while connected it grows until the next reconnect, so it is capped here and the
// oldest events are dropped past the cap (they may still be unconfirmed; 03 §Delivery guarantees).
// The whole state file is also rewritten synchronously on every emit and ack.
pub const MAX_BUFFERED_EVENTS: usize = 5000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("{path} is not a valid daemon state file: {err}")]
    Parse {
        path: String,
        err: serde_json::Error,
    },
}

#[derive(Debug)]
pub struct DaemonStore {
    file: PathBuf,
    data: StateFile,
    /// command_id → ack, oldest first (a re-recorded id moves to the end, as TS's Map delete+set).
    acks: VecDeque<(String, AckRecord)>,
}

impl DaemonStore {
    pub fn new(file: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let file = file.into();
        let mut data = Self::read(&file)?;
        let acks = std::mem::take(&mut data.acks).into_iter().collect();
        Ok(DaemonStore { file, data, acks })
    }

    pub fn for_root(root_dir: &Path) -> Result<Self, StoreError> {
        Self::new(root_dir.join("state").join("daemon.json"))
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    fn read(file: &Path) -> Result<StateFile, StoreError> {
        let raw = match std::fs::read_to_string(file) {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(StateFile::default()),
            Err(e) => return Err(e.into()),
        };
        let mut data: StateFile = serde_json::from_str(&raw).map_err(|err| StoreError::Parse {
            path: file.display().to_string(),
            err,
        })?;
        data.version = 1;
        Ok(data)
    }

    /// The file's JSON (compact, as TS's `JSON.stringify(data)`).
    pub fn to_json(&self) -> String {
        let mut data = self.data.clone();
        data.acks = self.acks.iter().cloned().collect();
        serde_json::to_string(&data).expect("the state serialises")
    }

    /// Write the file: `<file>.<pid>.tmp`, then rename over it.
    pub fn save(&self) -> io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = PathBuf::from(format!(
            "{}.{}.tmp",
            self.file.to_string_lossy(),
            std::process::id()
        ));
        std::fs::write(&tmp, self.to_json())?;
        std::fs::rename(&tmp, &self.file)
    }

    // ---------------------------------------------------------------- seq + event buffer

    pub fn last_seq(&self) -> Option<i64> {
        self.data.last_seq
    }

    pub fn events(&self) -> &[BufferedEvent] {
        &self.data.events
    }

    /// After `registered`: drop events the orchestrator has processed (seq <= last_seq), then the
    /// next seq is max(local + 1, registered.last_seq + 1) (None counts as -1). Unsequenced events
    /// get their seq now. Returns the events to replay, in order.
    pub fn on_registered(
        &mut self,
        registered_last_seq: Option<i64>,
    ) -> io::Result<Vec<BufferedEvent>> {
        let confirmed = registered_last_seq.unwrap_or(-1);
        self.data
            .events
            .retain(|e| e.seq.is_none_or(|s| s > confirmed));
        let local = self.data.last_seq.unwrap_or(-1);
        let mut next = (local + 1).max(confirmed + 1);
        for e in &mut self.data.events {
            if e.seq.is_none() {
                e.seq = Some(next);
                next += 1;
            }
        }
        // last_seq is now >= the orchestrator's, so the next assigned seq is always above it.
        self.data.last_seq = (next > 0).then_some(next - 1);
        self.save()?;
        Ok(self.data.events.clone())
    }

    /// Buffer an event; assign a seq now if `sequenced` (registered), else at the next register.
    pub fn push_event(
        &mut self,
        msg: DurableMessage,
        sequenced: bool,
    ) -> io::Result<BufferedEvent> {
        let seq = sequenced.then(|| {
            let s = self.data.last_seq.unwrap_or(-1) + 1;
            self.data.last_seq = Some(s);
            s
        });
        let ev = BufferedEvent { seq, msg };
        self.data.events.push(ev.clone());
        let len = self.data.events.len();
        if len > MAX_BUFFERED_EVENTS {
            self.data.events.drain(..len - MAX_BUFFERED_EVENTS);
        }
        self.save()?;
        Ok(ev)
    }

    // ---------------------------------------------------------------- command_id dedupe

    pub fn ack_for(&self, command_id: &str) -> Option<&AckRecord> {
        self.acks
            .iter()
            .rev()
            .find(|(id, _)| id == command_id)
            .map(|(_, a)| a)
    }

    pub fn record_ack(&mut self, command_id: &str, ack: AckRecord) -> io::Result<()> {
        self.acks.retain(|(id, _)| id != command_id);
        self.acks.push_back((command_id.to_string(), ack));
        while self.acks.len() > MAX_ACKS {
            self.acks.pop_front();
        }
        self.save()
    }

    // ---------------------------------------------------------------- sessions + repos

    pub fn session(&self, session_id: &str) -> Option<&PersistedSession> {
        self.data.sessions.get(session_id)
    }

    pub fn sessions(&self) -> &BTreeMap<String, PersistedSession> {
        &self.data.sessions
    }

    pub fn put_session(&mut self, session_id: &str, s: PersistedSession) -> io::Result<()> {
        self.data.sessions.insert(session_id.to_string(), s);
        self.save()
    }

    pub fn repos(&self) -> &BTreeMap<String, String> {
        &self.data.repos
    }

    pub fn put_repo(&mut self, repo: &str, path: &str) -> io::Result<()> {
        self.data.repos.insert(repo.to_string(), path.to_string());
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f";

    /// The TS test's `ev()`: a heartbeat session_event, parsed through the protocol types.
    fn ev() -> DurableMessage {
        serde_json::from_value(serde_json::json!({
            "type": "session_event",
            "msg_id": "00000000-0000-4000-8000-000000000001",
            "session_id": SID,
            "fencing_token": 1,
            "payload": { "kind": "heartbeat", "data": {} },
        }))
        .unwrap()
    }

    fn seqs(events: &[BufferedEvent]) -> Vec<Option<i64>> {
        events.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn persists_seq_buffered_events_acks_and_sessions_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = DaemonStore::for_root(dir.path()).unwrap();
        assert_eq!(s.last_seq(), None);
        s.on_registered(None).unwrap();
        assert_eq!(s.push_event(ev(), true).unwrap().seq, Some(0));
        assert_eq!(s.push_event(ev(), false).unwrap().seq, None);
        let ack = AckRecord {
            accepted: false,
            reason: Some("max_sessions".into()),
        };
        s.record_ack("c1", ack.clone()).unwrap();
        let session = PersistedSession {
            ticket_id: "t".into(),
            repo: "github.com/org/app".into(),
            worktree_path: "/w".into(),
            branch: "b".into(),
            port_range: Some(PortRange {
                base: 41000,
                count: 10,
            }),
            claude_session_id: None,
            last_used_at: 1,
            agent: Some(None),
        };
        s.put_session(SID, session.clone()).unwrap();
        s.put_repo("github.com/org/app", "/r").unwrap();
        let t = DaemonStore::for_root(dir.path()).unwrap();
        assert_eq!(t.last_seq(), Some(0));
        assert_eq!(seqs(t.events()), vec![Some(0), None]);
        assert_eq!(t.ack_for("c1"), Some(&ack));
        assert_eq!(t.session(SID), Some(&session));
        assert_eq!(
            t.repos().get("github.com/org/app").map(String::as_str),
            Some("/r")
        );
    }

    #[test]
    fn on_registered_drops_confirmed_events_and_sequences_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = DaemonStore::for_root(dir.path()).unwrap();
        s.on_registered(None).unwrap();
        s.push_event(ev(), true).unwrap(); // 0
        s.push_event(ev(), true).unwrap(); // 1
        s.push_event(ev(), true).unwrap(); // 2
        s.push_event(ev(), false).unwrap();
        assert_eq!(
            seqs(&s.on_registered(Some(0)).unwrap()),
            vec![Some(1), Some(2), Some(3)]
        );
        // orchestrator ahead of local
        s.push_event(ev(), false).unwrap();
        assert_eq!(seqs(&s.on_registered(Some(50)).unwrap()), vec![Some(51)]);
        assert_eq!(s.last_seq(), Some(51));
        // no events, orchestrator ahead: the next assigned seq is above it
        s.on_registered(Some(80)).unwrap();
        assert_eq!(s.push_event(ev(), true).unwrap().seq, Some(81));
    }

    #[test]
    fn acks_are_capped_oldest_first_and_a_re_record_moves_to_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = DaemonStore::new(dir.path().join("s.json")).unwrap();
        let ok = AckRecord {
            accepted: true,
            reason: None,
        };
        for i in 0..MAX_ACKS {
            s.acks.push_back((format!("c{i}"), ok.clone()));
        }
        s.record_ack("c0", ok.clone()).unwrap(); // moves c0 to the end
        s.record_ack("new", ok.clone()).unwrap(); // evicts c1, the oldest now
        assert!(s.ack_for("c0").is_some());
        assert!(s.ack_for("c1").is_none());
        assert_eq!(s.acks.len(), MAX_ACKS);
    }

    #[test]
    fn the_event_buffer_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = DaemonStore::new(dir.path().join("s.json")).unwrap();
        for _ in 0..MAX_BUFFERED_EVENTS {
            s.data.events.push(BufferedEvent {
                seq: None,
                msg: ev(),
            });
        }
        s.push_event(ev(), true).unwrap();
        assert_eq!(s.events().len(), MAX_BUFFERED_EVENTS);
        assert_eq!(s.events().last().unwrap().seq, Some(0));
    }

    #[test]
    fn agent_absent_null_and_set_round_trip_and_unknown_keys_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("daemon.json");
        let json = serde_json::json!({
            "version": 1,
            "lastSeq": 3,
            "events": [],
            "acks": [["c", {"accepted": true}]],
            "sessions": {
                "a": {"ticketId":"t","repo":"r","worktreePath":"/w","branch":"b","portRange":null,"claudeSessionId":null,"lastUsedAt":5},
                "b": {"ticketId":"t","repo":"r","worktreePath":"/w","branch":"b","portRange":null,"claudeSessionId":null,"lastUsedAt":5,"agent":null},
                "c": {"ticketId":"t","repo":"r","worktreePath":"/w","branch":"b","portRange":{"base":1,"count":2},"claudeSessionId":"x","lastUsedAt":5,"agent":{"commandId":"k","fencingToken":2,"pid":9,"startedAt":7}}
            },
            "repos": {},
            "future": {"x": 1}
        });
        std::fs::write(&file, json.to_string()).unwrap();
        let s = DaemonStore::new(&file).unwrap();
        assert_eq!(s.session("a").unwrap().agent, None);
        assert_eq!(s.session("b").unwrap().agent, Some(None));
        assert_eq!(
            s.session("c").unwrap().agent.clone().flatten().unwrap().pid,
            Some(9)
        );
        let back: serde_json::Value = serde_json::from_str(&s.to_json()).unwrap();
        assert_eq!(back, json);
    }

    #[test]
    fn with_seq_makes_the_wire_frame() {
        let frame = ev().with_seq(4);
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["type"], "session_event");
        assert_eq!(v["seq"], 4);
        assert_eq!(v["session_id"], SID);
    }
}
