import type { ApplyFn } from '@conductor/shared';
import type { OutboxTransport } from '../contracts.js';
import type { CreateEngineService, EngineHandle, Stoppable } from '../main.js';
import { sweepPermissionTimeouts } from '../permissions/store.js';
import { dispatchPushOnce, type PushDispatchStats } from '../push/dispatcher.js';
import { webPushSender, type PushSender } from '../push/sender.js';
import { dispatchOnce, type DispatchStats } from './dispatcher.js';
import { EngineServiceImpl } from './service.js';
import { sweepOnce, type SweepStats } from './sweep.js';

// createEngineService (M1-T04b; 10-contracts §Composition root). The EngineService itself, and
// `startWorkers`, which runs the outbox dispatcher and the timeout sweep until stopped.

export { backoffSeconds, START_SESSION_ACK_ATTEMPTS, type DispatchStats } from './dispatcher.js';
export { SCRUBBED_PAYLOAD_SQL } from './outbox.js';
export { EngineServiceImpl } from './service.js';
export type { SweepStats } from './sweep.js';

export type EngineServiceDeps = Parameters<CreateEngineService>[0] & {
  /** The pure FSM step; default: the shared `apply` (M1-T04a). Tests inject a scripted one. */
  apply?: ApplyFn;
  /** Dispatcher poll interval (default 500 ms); also woken right after an outbox write. */
  dispatchIntervalMs?: number;
  /** Timeout sweep interval (default 1000 ms). */
  sweepIntervalMs?: number;
  /** UX-15: the push sender (default: web-push with `push`). Tests inject a fake one. */
  pushSender?: PushSender;
  /** UX-15: push dispatcher poll interval (default 1000 ms); also woken after a push enqueue. */
  pushIntervalMs?: number;
};

export interface EngineServiceHandle extends EngineHandle {
  engine: EngineServiceImpl;
  /** One dispatcher pass (tests, and what the worker loop runs). */
  dispatchOnce(transport: OutboxTransport): Promise<DispatchStats>;
  /** One timeout-sweep pass. */
  sweepOnce(): Promise<SweepStats>;
  /** One permission-request timeout pass (ADR-0023): how many requests expired. */
  sweepPermissionsOnce(): Promise<number>;
  /** UX-15: one push dispatcher pass; null when push is disabled (nothing is ever sent). */
  dispatchPushOnce(): Promise<PushDispatchStats | null>;
}

/** A self-rescheduling loop that never overlaps itself; `wake()` runs it again soon. */
function loop(intervalMs: number, tick: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  let stopped = false;
  let again = false;
  const run = (): void => {
    timer = null;
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = tick()
      .catch((err: unknown) => {
        console.error('[engine] worker tick failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        running = null;
        if (stopped) return;
        const delay = again ? 0 : intervalMs;
        again = false;
        timer = setTimeout(run, delay);
      });
  };
  timer = setTimeout(run, 0);
  return {
    wake(): void {
      if (stopped) return;
      if (running) {
        again = true;
      } else if (timer) {
        clearTimeout(timer);
        timer = setTimeout(run, 0);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}

export function createEngineService(deps: EngineServiceDeps): EngineServiceHandle {
  const now = deps.now ?? (() => new Date());
  let wake: (() => void) | undefined;
  let wakePush: (() => void) | undefined;
  // UX-15: without VAPID nothing is enqueued and no push loop runs.
  const push = deps.push ?? null;
  const pushSender = push ? (deps.pushSender ?? webPushSender(push)) : null;
  const engine = new EngineServiceImpl({
    db: deps.db,
    boardBus: deps.boardBus,
    now,
    ...(deps.apply ? { apply: deps.apply } : {}),
    onOutboxWritten: () => wake?.(),
    pushEnabled: pushSender !== null,
    onPushWritten: () => wakePush?.(),
  });
  const workerDeps = { db: deps.db, engine, boardBus: deps.boardBus, now };
  const pushOnce = () =>
    pushSender ? dispatchPushOnce({ db: deps.db, sender: pushSender, now }) : Promise.resolve(null);
  return {
    engine,
    dispatchOnce: (transport) => dispatchOnce(workerDeps, transport),
    sweepOnce: () => sweepOnce(workerDeps),
    sweepPermissionsOnce: () => sweepPermissionTimeouts(workerDeps),
    dispatchPushOnce: pushOnce,
    startWorkers({ transport }): Stoppable {
      const dispatcher = loop(deps.dispatchIntervalMs ?? 500, () =>
        dispatchOnce(workerDeps, transport),
      );
      const sweeper = loop(deps.sweepIntervalMs ?? 1000, async () => {
        await sweepOnce(workerDeps);
        await sweepPermissionTimeouts(workerDeps);
      });
      // UX-15: its own loop, so a slow push service never delays machine commands (NFR-1).
      const pusher = pushSender ? loop(deps.pushIntervalMs ?? 1000, pushOnce) : null;
      wake = () => dispatcher.wake();
      wakePush = pusher ? () => pusher.wake() : undefined;
      return {
        async stop() {
          wake = undefined;
          wakePush = undefined;
          await Promise.all([dispatcher.stop(), sweeper.stop(), pusher?.stop()]);
        },
      };
    },
  };
}
