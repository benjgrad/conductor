/**
 * The real EngineService (M1-T04b `createEngineService`, shared `apply`) with every call recorded,
 * for the gateway integration tests (TD-060: they used to run against a DB-backed stand-in).
 */
import type { EngineEvent } from '@conductor/shared';
import type {
  ApplyEventOptions,
  ApplyEventResult,
  BoardBus,
  EngineService,
} from '../../src/contracts.js';
import { createEngineService } from '../../src/engine/index.js';
import type { Db } from '../../src/main.js';

export class RecordingEngine implements EngineService {
  readonly calls: { sessionId: string; event: EngineEvent; opts: ApplyEventOptions }[] = [];
  private readonly inner: EngineService;

  constructor(db: Db, boardBus: BoardBus) {
    this.inner = createEngineService({ db, boardBus }).engine;
  }

  applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions = {},
  ): Promise<ApplyEventResult> {
    this.calls.push({ sessionId, event, opts });
    return this.inner.applyEvent(sessionId, event, opts);
  }
}
