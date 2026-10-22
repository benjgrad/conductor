// (f) The proposed ClaudeDriver contract (driver.mjs), run unchanged against
// the real CLI and against fake-claude.mjs. Scenario: ask_user -> park idle ->
// sendInput(answer) -> complete_state -> end(). Then the resume fallback:
// start({resumeSessionId}) with the answer as the first message.
// Usage: node f-driver-contract.mjs [real|fake ...]   (default: both)
import { join } from 'node:path';
import { createClaudeDriver } from './driver.mjs';
import { startOutcomeServer } from './outcome-server.mjs';
import { scratchRepo, logger, HERE, MODEL } from './lib.mjs';

const outcome = await startOutcomeServer();
const PROMPT = 'Workflow state "implement". Call ask_user to ask which greeting word to use (do not guess). When answered, call complete_state with result {"greeting": <word>}. Nothing else.';
const tools = { builtin: ['Read', 'Edit', 'Write', 'Bash'], allow: ['Read', 'Edit(./**)', 'Write(./**)', 'Bash(git status:*)'], deny: ['Bash(git push:*)'] };

function collect(session, log) {
  const events = [];
  const waiters = [];
  session.on((ev) => {
    if (ev.kind === 'output' && ev.stream === 'stderr') return;
    events.push(ev);
    log('EVENT', JSON.stringify(ev).slice(0, 220));
    for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
  });
  const until = (pred) => new Promise((resolve) => {
    const hit = events.find(pred); if (hit) resolve(hit); else waiters.push({ pred, resolve });
  });
  return { events, until };
}

async function run(which) {
  const log = logger(`f-driver-contract-${which}`);
  const claudeBin = which === 'fake' ? join(HERE, 'fake-claude.mjs') : 'claude';
  const driver = createClaudeDriver({ claudeBin, outcome });
  const cwd = scratchRepo(`f-${which}`);
  const common = { cwd, tools, env: {}, model: MODEL, maxTurns: 6, maxBudgetUsd: 0.3 };

  // live path
  const s = driver.start({ ...common, prompt: PROMPT });
  const c = collect(s, log);
  const id = (await c.until((e) => e.kind === 'claude_session_id')).id;
  await c.until((e) => e.kind === 'ask_user');
  await c.until((e) => e.kind === 'turn_end');
  log('parked: question asked, turn ended, process alive & idle');
  await new Promise((r) => setTimeout(r, 3000));
  s.sendInput('Answer to your question: "hola".');
  const done = await c.until((e) => e.kind === 'complete_state');
  await c.until((e) => e.kind === 'turn_end' && c.events.indexOf(e) > c.events.indexOf(done));
  s.end();
  const exit = await c.until((e) => e.kind === 'exit');
  log('LIVE OK:', JSON.stringify({ id, result: done.result, exit }));

  // resume path: process gone, the answer becomes the first message
  const r = driver.start({ ...common, resumeSessionId: id, prompt: 'Resumed. Which greeting word did you record? Call nothing; reply with just the word.' });
  const rc = collect(r, log);
  const rid = (await rc.until((e) => e.kind === 'claude_session_id')).id;
  const spend = await rc.until((e) => e.kind === 'spend');
  r.end();
  await rc.until((e) => e.kind === 'exit');
  log('RESUME OK:', JSON.stringify({ sameId: rid === id, totalUsd: spend.totalUsd }));
  await log.close();
}

const which = process.argv.slice(2).length ? process.argv.slice(2) : ['fake', 'real'];
for (const w of which) await run(w);
await outcome.close();
