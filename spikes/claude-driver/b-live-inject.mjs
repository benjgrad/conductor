// (b) Live answer injection, plus the --resume fallback.
//  1. Turn 1 ends with the agent asking a question; the process goes idle.
//  2. After an idle gap, the "daemon" writes the answer as a new user message
//     on the SAME stdin. The agent continues in the same session.
//  3. Also: a message written while a turn is still running is queued and
//     handled after it (no interleaving).
//  4. Fallback: kill the process, then `--resume <session_id>` with the answer
//     as the first message. Context survives; check whether the id changes.
import { spawnClaude, baseArgs, scratchRepo, summarize, logger } from './lib.mjs';

const log = logger('b-live-inject');
const cwd = scratchRepo('b');
const IDLE_MS = Number(process.env.IDLE_MS ?? 20_000);

// ---- live path ----
const cc = spawnClaude('b-live-inject', [...baseArgs({ maxTurns: 3 }), '--tools', ''], { cwd });
cc.onMessage((m) => log('live <-', summarize(m)));

cc.send('Remember the secret word "marmalade". Then ask me what colour I want the button to be, and stop. Keep it to one short sentence.');
const init = await cc.next((m) => m.type === 'system' && m.subtype === 'init');
const sid = init.session_id;
const r1 = await cc.next((m) => m.type === 'result');
log(`turn 1 done; process idle for ${IDLE_MS} ms (pid ${cc.child.pid}, alive=${cc.child.exitCode === null})`);
await new Promise((r) => setTimeout(r, IDLE_MS));
log('still alive after idle gap?', cc.child.exitCode === null);

log('-> injecting answer into live stdin');
cc.send('Green. Reply with: "button=<colour> secret=<the secret word>".', sid);
const r2 = await cc.next((m) => m.type === 'result');
log('turn 2 session_id same as turn 1?', r2.session_id === sid, '| result:', JSON.stringify(r2.result));
log('cumulative total_cost_usd after turn 2 =', r2.total_cost_usd, '(turn 1 was', r1.total_cost_usd + ')');

// Mid-turn write: send two messages back to back; the second arrives while
// the first turn is still running.
log('-> sending two messages back to back (second lands mid-turn)');
cc.send('Count from 1 to 5, one number per line.', sid);
setTimeout(() => cc.send('Now say: "second message handled".', sid), 300);
const r3 = await cc.next((m) => m.type === 'result');
log('first result after back-to-back:', JSON.stringify(r3.result), 'num_turns', r3.num_turns);
const r4 = await cc.next((m) => m.type === 'result', 60_000).catch(() => null);
log('second result after back-to-back:', JSON.stringify(r4?.result ?? '(none: merged into first turn)'));

// Process gone (crash / compute release).
log('-> killing live process (simulates laptop sleep / compute release)');
cc.child.kill('SIGTERM');
log('exit:', JSON.stringify(await cc.exited));

// ---- fallback: resume with the answer as the first message ----
const rs = spawnClaude('b-resume', [...baseArgs({ maxTurns: 2 }), '--tools', '', '--resume', sid], { cwd });
rs.onMessage((m) => log('resume <-', summarize(m)));
rs.send('Answer arrived after a restart: the button should be blue. Reply with: "button=<colour> secret=<the secret word>".', sid);
const rinit = await rs.next((m) => m.type === 'system' && m.subtype === 'init');
log('resumed init session_id', rinit.session_id, '| same as original?', rinit.session_id === sid);
const rr = await rs.next((m) => m.type === 'result');
log('resumed result:', JSON.stringify(rr.result), '| result.session_id', rr.session_id, '| cost (this process only)', rr.total_cost_usd);
rs.endInput();
log('resume exit:', JSON.stringify(await rs.exited));
await log.close();
