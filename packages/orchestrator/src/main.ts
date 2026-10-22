import type { Server } from 'node:http';
import { conductorPort } from '@conductor/shared';
import pg from 'pg';
import {
  InMemoryBoardBus,
  InMemoryOutputBus,
  type BoardBus,
  type EngineService,
  type OutboxTransport,
  type OutputBus,
} from './contracts.js';

// Orchestrator composition root (M1-T12 skeleton; 10-contracts §Composition root). Each group C
// task implements ONE factory in its own directory, against these signatures:
//   createEngineService  → src/engine/index.ts   (M1-T04)
//   createGateway        → src/gateway/index.ts  (M1-T11)
//   createApi            → src/api/index.ts      (M1-T08)
// createDb and the buses are defined here. M1-T07 adds the process entry (`main()`: read env,
// import the three real factories, call composeOrchestrator, handle SIGINT/SIGTERM).

export type Db = pg.Pool;

export interface Stoppable {
  stop(): Promise<void>;
}

/** M1-T04. `startWorkers` runs the outbox dispatcher and the timeout sweep. */
export interface EngineHandle {
  engine: EngineService;
  startWorkers(deps: { transport: OutboxTransport }): Stoppable;
}
export type CreateEngineService = (deps: {
  db: Db;
  boardBus: BoardBus;
  now?: () => Date;
}) => EngineHandle;

/** M1-T11. `attach` serves API_PATHS.daemonWs via the HTTP server's `upgrade` event. */
export interface GatewayHandle {
  transport: OutboxTransport;
  attach(server: Server): void;
  close(): Promise<void>;
}
export type CreateGateway = (deps: {
  db: Db;
  engine: EngineService;
  boardBus: BoardBus;
  outputBus: OutputBus;
}) => GatewayHandle;

/** M1-T08. REST + SSE (Fastify). `server` exists before `listen` so the gateway can attach. */
export interface ApiHandle {
  server: Server;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
}
export type CreateApi = (deps: {
  db: Db;
  engine: EngineService;
  boardBus: BoardBus;
  outputBus: OutputBus;
}) => ApiHandle;

export type CreateDb = (opts: { databaseUrl: string }) => Db;
export const createDb: CreateDb = ({ databaseUrl }) =>
  new pg.Pool({ connectionString: databaseUrl });

export interface OrchestratorFactories {
  createDb?: CreateDb;
  createEngineService: CreateEngineService;
  createGateway: CreateGateway;
  createApi: CreateApi;
}

export interface OrchestratorConfig {
  databaseUrl: string;
  /** Default: `conductorPort(process.env)` (CONDUCTOR_PORT, else 7400). */
  port?: number;
  /** M1: localhost only (09). */
  host?: string;
}

export interface Orchestrator {
  db: Db;
  boardBus: BoardBus;
  outputBus: OutputBus;
  engine: EngineService;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wire the pieces: db → buses → engine → gateway(engine) → api → gateway.attach(api.server).
 * `start` starts the engine workers with the gateway's transport and listens; `stop` reverses.
 */
export function composeOrchestrator(
  f: OrchestratorFactories,
  config: OrchestratorConfig,
): Orchestrator {
  const db = (f.createDb ?? createDb)({ databaseUrl: config.databaseUrl });
  const boardBus = new InMemoryBoardBus();
  const outputBus = new InMemoryOutputBus();
  const engineHandle = f.createEngineService({ db, boardBus });
  const engine = engineHandle.engine;
  const gateway = f.createGateway({ db, engine, boardBus, outputBus });
  const api = f.createApi({ db, engine, boardBus, outputBus });
  gateway.attach(api.server);
  let workers: Stoppable | null = null;
  return {
    db,
    boardBus,
    outputBus,
    engine,
    async start() {
      workers = engineHandle.startWorkers({ transport: gateway.transport });
      await api.listen(config.port ?? conductorPort(process.env), config.host ?? '127.0.0.1');
    },
    async stop() {
      await workers?.stop();
      await gateway.close();
      await api.close();
      await db.end();
    },
  };
}
