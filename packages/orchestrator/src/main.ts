import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conductorPort } from '@conductor/shared';
import pg from 'pg';
import { createApi as createRealApi } from './api/index.js';
import {
  parsePublicUrl,
  parseServerConfig,
  PUBLIC_URL_ENV,
  type AuthConfig,
  type ServerConfig,
} from './auth/config.js';
import {
  defaultDownloadsDir,
  findDaemonBuild,
  orchestratorVersion,
  serveDistribution,
  servedVersion,
} from './distribution.js';
import { seedConductorWorkflow } from './engine/seed.js';
import { createDb as createPoolDb } from './db/index.js';
import { createEngineService as createRealEngineService } from './engine/index.js';
import { createGateway as createRealGateway } from './gateway/index.js';
import type { MachineSockets } from './gateway/revoke.js';
import { hasWebApp, serveWebApp } from './web-static.js';
import {
  InMemoryBoardBus,
  InMemoryOutputBus,
  type BoardBus,
  type EngineService,
  type OutboxTransport,
  type OutputBus,
  type TranscriptSource,
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
  /** ADR-0008: transcript requests to daemons (the real gateway always has it). */
  transcripts?: TranscriptSource;
  attach(server: Server): void;
  close(): Promise<void>;
  /** M2-T17: close a revoked machine's sockets (the real gateway always has it). */
  disconnectMachine?: MachineSockets['disconnectMachine'];
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
  /** ADR-0008: absent → GET /transcript answers 503 machine_offline. */
  transcripts?: TranscriptSource;
  /** M2-T08: absent → `local` mode (ADR-0017 §Modes). */
  auth?: AuthConfig;
  /** M2-T08: CONDUCTOR_TRUSTED_PROXY (Fastify `trustProxy`); absent → none trusted. */
  trustedProxy?: string | null;
  /** M2-T17: what a machine revoke closes (the gateway); absent → nothing to close. */
  sockets?: MachineSockets;
  /** M2-T17: the origin in the install command; absent → the public URL, or the request's Host. */
  installUrl?: string;
  /** M2-T17: the served daemon version, for `MachineRow.outdated`; absent → none. */
  servedVersion?: string | null;
  /**
   * M2-T29c: the daemons' live sockets (the gateway's transport), for a permission decision sent
   * directly (U-099: no outbox row); absent → decisions are stored and never sent.
   */
  machineTransport?: OutboxTransport;
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
  /** CONDUCTOR_BIND_HOST (default 127.0.0.1; local mode is loopback only, parseServerConfig). */
  host?: string;
  /** M2-T08: sign-in mode; absent → local. */
  auth?: AuthConfig;
  trustedProxy?: string | null;
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
  const api = f.createApi({
    db,
    engine,
    boardBus,
    outputBus,
    ...(gateway.transcripts ? { transcripts: gateway.transcripts } : {}),
    machineTransport: gateway.transport,
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.trustedProxy ? { trustedProxy: config.trustedProxy } : {}),
    ...(gateway.disconnectMachine
      ? {
          sockets: {
            disconnectMachine: (id: string, code: number, reason: string) =>
              gateway.disconnectMachine!(id, code, reason),
          },
        }
      : {}),
  });
  gateway.attach(api.server);
  let workers: Stoppable | null = null;
  return {
    db,
    boardBus,
    outputBus,
    engine,
    async start() {
      // ADR-0010: the one workflow exists before anything can reference it.
      await seedConductorWorkflow(db);
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
  /**
   * Default `process.env`: DATABASE_URL (required), CONDUCTOR_PORT, CONDUCTOR_WEB_DIR, and the
   * M2-T08 server config (CONDUCTOR_AUTH, CONDUCTOR_PUBLIC_URL, CONDUCTOR_BIND_HOST,
   * CONDUCTOR_TRUSTED_PROXY; `parseServerConfig`), and the M2-T14 distribution settings
   * (CONDUCTOR_DOWNLOADS_DIR, CONDUCTOR_BUILD_SHA / CONDUCTOR_GIT_SHA).
   */
  env?: NodeJS.ProcessEnv;
  /** Stop on SIGINT/SIGTERM, then exit (default true; tests pass false and call `stop()`). */
  signals?: boolean;
  /** Default REAL_FACTORIES (tests may wrap them). */
  factories?: OrchestratorFactories;
  log?: (msg: string) => void;
}

/**
 * The origin `/install.sh` downloads from and enrolls against: the public URL in password mode;
 * in local mode CONDUCTOR_PUBLIC_URL when set, else the loopback address it listens on.
 */
function installPublicUrl(env: NodeJS.ProcessEnv, server: ServerConfig, port: number): string {
  if (server.auth.mode === 'password') return server.auth.publicUrl.origin;
  const raw = env[PUBLIC_URL_ENV]?.trim();
  if (raw) return parsePublicUrl(raw).publicUrl.origin;
  const host =
    server.bindHost === '0.0.0.0' || server.bindHost === '::' ? '127.0.0.1' : server.bindHost;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

/**
 * Start the orchestrator: compose the real pieces on DATABASE_URL, serve the built web app (when
 * `CONDUCTOR_WEB_DIR`, default `packages/web/dist`, has an index.html), start the outbox
 * dispatcher and the timeout sweep, and listen on CONDUCTOR_BIND_HOST:CONDUCTOR_PORT (default
 * 127.0.0.1:7400). The config is checked first (a bad one throws naming the variable, before the
 * database is touched). The schema is not migrated here: run `pnpm db:migrate` first.
 */
export async function main(opts: MainOptions = {}): Promise<Orchestrator> {
  const env = opts.env ?? process.env;
  const server = parseServerConfig(env);
  const log =
    opts.log ?? ((m: string) => void process.stderr.write(`[conductor-orchestrator] ${m}\n`));
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const port = conductorPort(env);
  const webDir = env.CONDUCTOR_WEB_DIR || DEFAULT_WEB_DIR;
  const serveWeb = hasWebApp(webDir);
  const factories = opts.factories ?? REAL_FACTORIES;
  // M2-T14: /install.sh, /downloads/*, /healthz (ADR-0017 §Daemon distribution).
  const version = orchestratorVersion(env);
  const downloadsDir = defaultDownloadsDir(env);
  const build = findDaemonBuild(downloadsDir, log);
  const publicUrl = installPublicUrl(env, server, port);
  const orchestrator = composeOrchestrator(
    {
      ...factories,
      createApi: (deps) => {
        const api = factories.createApi({
          ...deps,
          installUrl: publicUrl,
          servedVersion: servedVersion(build),
        });
        if (serveWeb) serveWebApp(api.server, webDir);
        serveDistribution(api.server, { db: deps.db, publicUrl, build, version });
        return api;
      },
    },
    {
      databaseUrl,
      port,
      host: server.bindHost,
      auth: server.auth,
      trustedProxy: server.trustedProxy,
    },
  );
  await orchestrator.start();
  log(`listening on http://${server.bindHost}:${port} (auth: ${server.auth.mode})`);
  log(serveWeb ? `web app from ${webDir}` : `no web app at ${webDir} (run pnpm build)`);
  log(
    build
      ? `daemon ${build.version} served from ${downloadsDir} (version ${version})`
      : `no daemon tarball in ${downloadsDir}: /install.sh answers 503 ` +
          '(run packages/orchestrator/scripts/build-daemon-tarball.sh)',
  );

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
