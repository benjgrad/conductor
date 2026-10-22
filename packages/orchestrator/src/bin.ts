#!/usr/bin/env node
import { main } from './main.js';

// `conductor-orchestrator`: the orchestrator process (M1-T07). Env: DATABASE_URL (required),
// CONDUCTOR_PORT (default 7400), CONDUCTOR_WEB_DIR (default packages/web/dist).
main().catch((err: unknown) => {
  process.stderr.write(
    `[conductor-orchestrator] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
