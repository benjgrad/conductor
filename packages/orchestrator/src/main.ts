import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conductorPort } from '@conductor/shared';
import pg from 'pg';
import { createApi as createRealApi } from './api/index.js';
import { createDb as createPoolDb } from './db/index.js';
import { createEngineService as createRealEngineService } from './engine/index.js';
import { createGateway as createRealGateway } from './gateway/index.js';
import { hasWebApp, serveWebApp } from './web-static.js';
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
// createDb and the buses are defined here. M1-T07 adds the process entry `main()` at the end
// (env, the real factories, composeOrchestrator, the web app, SIGINT/SIGTERM); `src/bin.ts` is
// the `conductor-orchestrator` executable that runs it.

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

// ================================================================== process entry (M1-T07)

/** `packages/web/dist` (vite build), from both `src/` (vitest) and `dist/` (built). */
export const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

/** The real factories (T04b, T11, T08) and `src/db`'s pool, which logs idle errors (U-038). */
export const REAL_FACTORIES: Required<OrchestratorFactories> = {
  createDb: createPoolDb,
  createEngineService: createRealEngineService,
  createGateway: createRealGateway,
  createApi: createRealApi,
};

export interface MainOptions {
  /** Default `process.env`: DATABASE_URL (required), CONDUCTOR_PORT, CONDUCTOR_WEB_DIR. */
  env?: NodeJS.ProcessEnv;
  /** Stop on SIGINT/SIGTERM, then exit (default true; tests pass false and call `stop()`). */
  signals?: boolean;
  /** Default REAL_FACTORIES (tests may wrap them). */
  factories?: OrchestratorFactories;
  log?: (msg: string) => void;
}

/**
 * Start the orchestrator: compose the real pieces on DATABASE_URL, serve the built web app (when
 * `CONDUCTOR_WEB_DIR`, default `packages/web/dist`, has an index.html), start the outbox
 * dispatcher and the timeout sweep, and listen on 127.0.0.1:CONDUCTOR_PORT (default 7400). The
 * schema is not migrated here: run `pnpm db:migrate` first.
 */
export async function main(opts: MainOptions = {}): Promise<Orchestrator> {
  const env = opts.env ?? process.env;
  const log =
    opts.log ?? ((m: string) => void process.stderr.write(`[conductor-orchestrator] ${m}\n`));
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const port = conductorPort(env);
  const webDir = env.CONDUCTOR_WEB_DIR || DEFAULT_WEB_DIR;
  const serveWeb = hasWebApp(webDir);
  const factories = opts.factories ?? REAL_FACTORIES;
  const orchestrator = composeOrchestrator(
    {
      ...factories,
      createApi: (deps) => {
        const api = factories.createApi(deps);
        if (serveWeb) serveWebApp(api.server, webDir);
        return api;
      },
    },
    { databaseUrl, port },
  );
  await orchestrator.start();
  log(`listening on http://127.0.0.1:${port}`);
  log(serveWeb ? `web app from ${webDir}` : `no web app at ${webDir} (run pnpm build)`);

  if (opts.signals ?? true) {
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      log(`${signal}: stopping`);
      orchestrator.stop().then(
        () => process.exit(0),
        (err: unknown) => {
          log(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
  return orchestrator;
}
