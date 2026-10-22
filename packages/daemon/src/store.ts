import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DaemonToOrchestrator } from '@conductor/shared';

// The daemon's durable local state (03 §Delivery guarantees, 10-contracts §Daemon seq dedupe):
// the last assigned seq, the buffered session_events not yet confirmed by `registered.last_seq`,
// the command_id dedupe set (with the ack each command got), and per-session facts (worktree,
// branch, port range, pre-assigned Claude session id). One JSON file under <root>/state/,
// written atomically (tmp + rename) and synchronously, so a fact is on disk before the daemon
// acts on it (e.g. the Claude session id before spawning).

export type SessionEventMessage = Extract<DaemonToOrchestrator, { type: 'session_event' }>;

/** A session_event waiting for confirmation. `seq` is null until the daemon is registered. */
export interface BufferedEvent {
  seq: number | null;
  msg: Omit<SessionEventMessage, 'seq'>;
}

export interface AckRecord {
  accepted: boolean;
  reason?: string;
}

export interface PortRange {
  base: number;
  count: number;
}

export interface PersistedSession {
  ticketId: string;
  repo: string;
  worktreePath: string;
  branch: string;
  portRange: PortRange | null;
  /** Pre-assigned (new) or resumed Claude session id of the latest start_session. */
  claudeSessionId: string | null;
  /** ms epoch; used to pick which idle session's port range to reclaim first. */
  lastUsedAt: number;
  /**
   * The live Claude process (its start_session command_id and fencing token), cleared on exit.
   * Set at daemon start means the process died with the previous daemon: an `exit` is reported.
   */
  agent?: { commandId: string; fencingToken: number } | null;
}

interface StateFile {
  version: 1;
  lastSeq: number | null;
  events: BufferedEvent[];
  acks: [string, AckRecord][];
  sessions: Record<string, PersistedSession>;
  /** repo → shared clone path. */
  repos: Record<string, string>;
}

/** Most recent command_ids kept for dedupe. */
export const MAX_ACKS = 2000;
// TD-025: the event buffer is trimmed only by `registered.last_seq` (there is no per-event ack in the
// protocol); while connected it grows until the next reconnect, so it is capped here and the
// oldest events are dropped past the cap (they may still be unconfirmed; 03 §Delivery guarantees).
// The whole state file is also rewritten synchronously on every emit and ack.
export const MAX_BUFFERED_EVENTS = 5000;

const empty = (): StateFile => ({
  version: 1,
  lastSeq: null,
  events: [],
  acks: [],
  sessions: {},
  repos: {},
});

export class DaemonStore {
  private data: StateFile;
  private readonly acks = new Map<string, AckRecord>();

  constructor(readonly file: string) {
    this.data = DaemonStore.read(file);
    for (const [id, a] of this.data.acks) this.acks.set(id, a);
  }

  static forRoot(rootDir: string): DaemonStore {
    return new DaemonStore(join(rootDir, 'state', 'daemon.json'));
  }

  private static read(file: string): StateFile {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw e;
    }
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    return { ...empty(), ...parsed, version: 1 };
  }

  save(): void {
    this.data.acks = [...this.acks.entries()];
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  // ---------------------------------------------------------------- seq + event buffer

  get lastSeq(): number | null {
    return this.data.lastSeq;
  }

  get events(): readonly BufferedEvent[] {
    return this.data.events;
  }

  /**
   * After `registered`: drop events the orchestrator has processed (seq <= lastSeq), then the
   * next seq is max(local + 1, registered.last_seq + 1) (null counts as -1). Unsequenced events
   * get their seq now. Returns the events to replay, in order.
   */
  onRegistered(registeredLastSeq: number | null): BufferedEvent[] {
    const confirmed = registeredLastSeq ?? -1;
    this.data.events = this.data.events.filter((e) => e.seq === null || e.seq > confirmed);
    const local = this.data.lastSeq ?? -1;
    let next = Math.max(local + 1, confirmed + 1);
    for (const e of this.data.events) {
      if (e.seq === null) e.seq = next++;
    }
    // lastSeq is now >= the orchestrator's, so the next assigned seq is always above it.
    this.data.lastSeq = next - 1 < 0 ? null : next - 1;
    this.save();
    return [...this.data.events];
  }

  /** Buffer an event; assign a seq now if `sequenced` (registered), else at the next register. */
  pushEvent(msg: Omit<SessionEventMessage, 'seq'>, sequenced: boolean): BufferedEvent {
    let seq: number | null = null;
    if (sequenced) {
      seq = (this.data.lastSeq ?? -1) + 1;
      this.data.lastSeq = seq;
    }
    const ev: BufferedEvent = { seq, msg };
    this.data.events.push(ev);
    if (this.data.events.length > MAX_BUFFERED_EVENTS) {
      this.data.events.splice(0, this.data.events.length - MAX_BUFFERED_EVENTS);
    }
    this.save();
    return ev;
  }

  // ---------------------------------------------------------------- command_id dedupe

  ackFor(commandId: string): AckRecord | undefined {
    return this.acks.get(commandId);
  }

  recordAck(commandId: string, ack: AckRecord): void {
    this.acks.delete(commandId);
    this.acks.set(commandId, ack);
    while (this.acks.size > MAX_ACKS) {
      const oldest = this.acks.keys().next().value;
      if (oldest === undefined) break;
      this.acks.delete(oldest);
    }
    this.save();
  }

  // ---------------------------------------------------------------- sessions + repos

  session(sessionId: string): PersistedSession | undefined {
    return this.data.sessions[sessionId];
  }

  get sessions(): Readonly<Record<string, PersistedSession>> {
    return this.data.sessions;
  }

  putSession(sessionId: string, s: PersistedSession): void {
    this.data.sessions[sessionId] = s;
    this.save();
  }

  get repos(): Readonly<Record<string, string>> {
    return this.data.repos;
  }

  putRepo(repo: string, path: string): void {
    this.data.repos[repo] = path;
    this.save();
  }
}
