// (g3) Can an agent whose Read is path-scoped (Read(./**), dontAsk) read its background task's
// output file, which the CLI writes outside the worktree (/tmp/claude-<uid>/…/tasks/<id>.output)?
import { spawnClaude, baseArgs, scratchRepo, summarize, logger } from './lib.mjs';

const log = logger('g3-background-read');
const cwd = scratchRepo('g3');
const cc = spawnClaude(
  'g3-background-read',
  [
    ...baseArgs({ maxTurns: 6 }),
    '--permission-mode', 'dontAsk',
    '--tools', 'Bash,Read,TaskStop',
    '--allowedTools', 'Read(./**),Bash(echo:*),Bash(sleep:*)',
  ],
  { cwd },
);
cc.onMessage((m) => log('<-', summarize(m)));
cc.send(
  'Run `sleep 3; echo read-me` with run_in_background true. When it is done, read its output file with the Read tool and tell me what it printed and whether the Read was allowed.',
);
let r = await cc.next((m) => m.type === 'result');
log('turn 1:', JSON.stringify(r.result), 'denials', JSON.stringify(r.permission_denials));
r = await cc.next((m) => m.type === 'result', 30_000).catch(() => null);
log('turn 2:', JSON.stringify(r?.result), 'denials', JSON.stringify(r?.permission_denials));
cc.endInput();
log('exit:', JSON.stringify(await cc.exited));
await log.close();
