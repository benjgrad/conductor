import type { ClaudeDriver, DriverEvent, DriverSession, DriverStartOptions } from './driver.js';

// In-memory, scripted ClaudeDriver for unit tests of daemon logic above the driver (ADR-0005
// §Fake Claude). The process-boundary fake for E2E (CONDUCTOR_CLAUDE_BIN) is M1-T10.
//
// Model: each user message (the start prompt, then every sendInput) runs the next scripted turn
// for that claudeSessionId. Turn state and the cumulative cost are keyed by claudeSessionId, so
// a `resume: true` start continues the script and the spend total, as the real CLI does.
// Every turn ends with `spend` (cumulative) then `turn_end`, unless the turn crashed the process.
// Events are emitted asynchronously (microtasks), so attach listeners right after start().

export type FakeTurnAction =
  | { say: string }
  | { askUser: string }
  | { completeState: Record<string, unknown> }
  /** Emit an arbitrary DriverEvent (e.g. tool_use output). */
  | { emit: DriverEvent }
  /** The process dies mid-turn: emits `exit` and nothing after it. */
  | { crash: { code: number | null; signal?: string } }
  /**
   * ADR-0007: the turn pauses until a sendMessage arrives, which is folded into it (as the real
   * CLI does mid-turn); then the rest of the turn plays.
   */
  | { awaitMessage: true };

/** Static actions, or a function of the user message that started the turn (`$answer`). */
export type FakeTurn = FakeTurnAction[] | ((input: string) => FakeTurnAction[]);

export interface FakeClaudeScript {
  turns: FakeTurn[];
  /** Added to the cumulative total each turn. Default 0.01. */
  costPerTurnUsd?: number;
}

interface Track {
  turn: number;
  totalUsd: number;
}

export class FakeClaudeDriver implements ClaudeDriver {
  readonly starts: DriverStartOptions[] = [];
  readonly sessions: FakeDriverSession[] = [];
  private readonly tracks = new Map<string, Track>();
  private readonly script: (opts: DriverStartOptions) => FakeClaudeScript;

  constructor(script: FakeClaudeScript | ((opts: DriverStartOptions) => FakeClaudeScript)) {
    this.script = typeof script === 'function' ? script : () => script;
  }

  start(opts: DriverStartOptions): FakeDriverSession {
    this.starts.push(opts);
    let track = this.tracks.get(opts.claudeSessionId);
    if (!track || !opts.resume) {
      track = { turn: 0, totalUsd: 0 };
      this.tracks.set(opts.claudeSessionId, track);
    }
    const session = new FakeDriverSession(opts, this.script(opts), track);
    this.sessions.push(session);
    return session;
  }

  /** The most recent session (convenience for tests). */
  get last(): FakeDriverSession | undefined {
    return this.sessions.at(-1);
  }
}

export class FakeDriverSession implements DriverSession {
  readonly claudeSessionId: string;
  /** Every event emitted, in order. */
  readonly events: DriverEvent[] = [];
  /** Every sendInput text, in order. */
  readonly inputs: string[] = [];
  /**
   * Every sendMessage text, in order (ADR-0007). A message is folded into the current turn, as
   * the real CLI does mid-turn: it runs no turn of its own; a paused `awaitMessage` resumes.
   */
  readonly messages: string[] = [];
  private resumeTurn: (() => void) | null = null;
  ended = false;
  killed = false;
  exited = false;
  private readonly listeners = new Set<(ev: DriverEvent) => void>();
  private initSent = false;
  private askPending = false;
  private completed = false;

  constructor(
    readonly opts: DriverStartOptions,
    private readonly script: FakeClaudeScript,
    private readonly track: Track,
  ) {
    this.claudeSessionId = opts.claudeSessionId;
    this.runTurn(opts.prompt);
  }

  on(listener: (ev: DriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendInput(text: string): void {
    if (this.exited) throw new Error('fake claude: process has exited');
    this.inputs.push(text);
    this.askPending = false;
    this.runTurn(text);
  }

  sendMessage(text: string): void {
    if (this.exited) throw new Error('fake claude: process has exited');
    this.messages.push(text);
    const resume = this.resumeTurn;
    this.resumeTurn = null;
    if (resume) queueMicrotask(resume);
  }

  end(): void {
    if (this.exited) return;
    this.ended = true;
    queueMicrotask(() => this.exit(0, null));
  }

  kill(): void {
    if (this.exited) return;
    this.killed = true;
    queueMicrotask(() => this.exit(null, 'SIGTERM'));
  }

  private exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.emit({ kind: 'exit', code, signal });
    this.exited = true;
  }

  private emit(ev: DriverEvent): void {
    if (this.exited) return;
    this.events.push(ev);
    for (const l of [...this.listeners]) l(ev);
  }

  private runTurn(input: string): void {
    queueMicrotask(() => {
      if (this.exited) return;
      if (!this.initSent) {
        this.initSent = true;
        this.emit({ kind: 'claude_session_id', id: this.claudeSessionId });
      }
      const turn = this.script.turns[this.track.turn++];
      const actions = turn === undefined ? [] : typeof turn === 'function' ? turn(input) : turn;
      if (turn === undefined) {
        this.emit({ kind: 'output', stream: 'debug', text: 'fake claude: script exhausted' });
      }
      this.play(actions, 0, turn === undefined);
    });
  }

  private play(actions: FakeTurnAction[], from: number, exhausted: boolean): void {
    if (this.exited) return;
    for (let i = from; i < actions.length; i++) {
      const a = actions[i]!;
      if ('crash' in a) {
        this.exit(a.crash.code, a.crash.signal ?? null);
        return;
      }
      if ('awaitMessage' in a) {
        this.resumeTurn = () => this.play(actions, i + 1, exhausted);
        return;
      }
      this.act(a);
    }
    this.track.totalUsd += this.script.costPerTurnUsd ?? 0.01;
    this.emit({
      kind: 'spend',
      totalUsd: this.track.totalUsd,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    this.emit({
      kind: 'turn_end',
      isError: exhausted,
      subtype: exhausted ? 'error_during_execution' : 'success',
      permissionDenials: 0,
    });
  }

  private act(a: Exclude<FakeTurnAction, { crash: unknown } | { awaitMessage: true }>): void {
    if ('say' in a) {
      this.emit({ kind: 'output', stream: 'assistant', text: a.say });
    } else if ('emit' in a) {
      this.emit(a.emit);
    } else if ('askUser' in a) {
      this.askPending = true;
      this.emit({ kind: 'ask_user', question: a.askUser });
    } else if (this.completed || this.askPending) {
      // ADR-0005 outcome-server guard: a second complete_state, or one while a question is
      // pending, gets a corrective tool result and is not emitted.
      this.emit({ kind: 'output', stream: 'debug', text: 'complete_state refused' });
    } else {
      this.completed = true;
      this.emit({ kind: 'complete_state', result: a.completeState });
    }
  }
}
