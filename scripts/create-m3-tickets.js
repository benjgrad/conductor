#!/usr/bin/env node
// Create M3 tickets on the conductor board, one per `### M3-Tnn` block of the milestone file.
//
//   node scripts/create-m3-tickets.js --dry-run T01 T02 ...
//   CONDUCTOR_EMAIL=... node scripts/create-m3-tickets.js T01          # prompts for the password
//
// Env: CONDUCTOR_URL (default https://conductor.gradyserver.com), CONDUCTOR_EMAIL,
// CONDUCTOR_PASSWORD (optional; prompted if absent), CONDUCTOR_WORKFLOW (default conductor_dev).
// Re-running is safe: a ticket whose title is already on the board is skipped.
// TD-172: no depends_on until M2b, so only create a wave once every dependency is merged
// (M3-mcp.md §Ticket waves).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MILESTONE = resolve(REPO_ROOT, 'docs/plan/milestones/M3-mcp.md');
const BASE = (process.env.CONDUCTOR_URL ?? 'https://conductor.gradyserver.com').replace(/\/$/, '');
const WORKFLOW = process.env.CONDUCTOR_WORKFLOW ?? 'conductor_dev';
const REPO = 'github.com/benjgrad/conductor';
const NOT_TICKETS = new Set(['T17', 'T18', 'T19']); // T17 is the lead's deploy; T18/T19 are "later"
const PRIORITY = { T02: 1 }; // the migration needs Ben's review early

const RULES = `
---

## Rules for every M3 ticket
- Do not edit \`docs/tracking/*\`. Report new unknowns, tech debt, unfinished items and needed contract changes in the PR description instead.
- Code against the M3-T01 contracts (\`shared/src/mcp/**\`, \`shared/src/api/oauth.ts\`, \`api/rest.ts\`). A needed contract change is reported in the PR, never made locally.
- A shortcut needs a \`// TD: <what>\` comment at the site and a line in the PR report (the lead assigns the TD number).
- A migration is never merged without Ben's approval: a task with a migration stops at "PR open, awaiting Ben".
- Work on branch \`m3-tNN-<slug>\`. Merge \`origin/main\` before finishing (never rebase); the "Merges cleanly with main" check must pass.
- Gates: \`pnpm typecheck && pnpm lint && pnpm test && pnpm build\` (DB tests need \`pnpm db:up\`), plus \`pnpm test:e2e\` where the block says so. Run targeted tests while iterating; conductor's checks are the full run.
- Design source of truth: \`docs/design/\` (start at 10-contracts §Tool layer and MCP) and \`docs/adr/0014-tool-layer-and-oauth-mcp-server.md\`. The full M3 plan is \`docs/plan/milestones/M3-mcp.md\`.
`;

function parseBlocks(md) {
  const lines = md.split('\n');
  const blocks = new Map();
  let cur = null;
  for (const line of lines) {
    const m = /^### M3-(T\d\d) · (.+)$/.exec(line);
    if (m) {
      cur = { id: m[1], title: `M3-${m[1]} · ${m[2].trim()}`, lines: [] };
      blocks.set(m[1], cur);
      continue;
    }
    if (cur && (/^### /.test(line) || /^---\s*$/.test(line) || /^# /.test(line))) cur = null;
    if (cur) cur.lines.push(line);
  }
  return blocks;
}

function buildRequest(block) {
  const body = block.lines.join('\n').trim() + '\n' + RULES;
  for (const h of ['## Goal', '## Verification']) {
    if (!body.includes(h)) throw new Error(`${block.id}: block has no "${h}" section`);
  }
  return {
    title: block.title,
    body,
    repo: REPO,
    workflow_id: WORKFLOW,
    priority: PRIORITY[block.id] ?? 0,
    required_tags: [],
    repo_allow_machines: null,
    external_ref: null,
    kind: 'personal',
  };
}

async function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a))));
}

class Client {
  cookie = null;
  async req(method, path, body) {
    const headers = { Origin: BASE, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set)
      if (/conductor_session=/.test(c) && !/=;/.test(c)) this.cookie = c.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok)
      throw new Error(
        `${method} ${path} → ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`,
      );
    return json;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const ids = args
    .filter((a) => !a.startsWith('--'))
    .map((a) => a.toUpperCase().replace(/^M3-/, ''));
  const blocks = parseBlocks(readFileSync(MILESTONE, 'utf8'));
  const wanted = ids.length ? ids : [...blocks.keys()].filter((id) => !NOT_TICKETS.has(id));

  const reqs = wanted.map((id) => {
    if (NOT_TICKETS.has(id)) throw new Error(`${id} is not a ticket (lead task or "later")`);
    const b = blocks.get(id);
    if (!b) throw new Error(`no "### M3-${id} · …" block in ${MILESTONE}`);
    return buildRequest(b);
  });
  const titles = new Set(reqs.map((r) => r.title));
  if (titles.size !== reqs.length) throw new Error('duplicate titles');

  if (dry) {
    for (const r of reqs) {
      const firstLines = r.body.split('\n').slice(0, 3).join(' | ');
      console.log(
        `${r.title}  [${Buffer.byteLength(r.body)} B, priority ${r.priority}, ${r.workflow_id}]\n    ${firstLines}`,
      );
    }
    console.log(`\n${reqs.length} ticket(s), dry run: nothing posted.`);
    return;
  }

  const email = process.env.CONDUCTOR_EMAIL ?? (await prompt('email: '));
  const password = process.env.CONDUCTOR_PASSWORD ?? (await prompt('password: '));
  const c = new Client();
  await c.req('POST', '/auth/login', { email, password });
  if (!c.cookie) throw new Error('login returned no session cookie');

  const workflows = await c.req('GET', '/api/workflows');
  const wf = workflows.filter((w) => w.id === WORKFLOW).sort((a, b) => b.version - a.version)[0];
  if (!wf)
    throw new Error(
      `workflow ${WORKFLOW} is not on ${BASE}; have: ${[...new Set(workflows.map((w) => w.id))].join(', ')}`,
    );
  console.log(`workflow ${wf.id} v${wf.version} (start ${wf.start})`);

  const board = await c.req('GET', '/api/board');
  const existing = new Set(board.columns.flatMap((col) => col.cards.map((card) => card.title)));

  for (const r of reqs) {
    if (existing.has(r.title)) {
      console.log(`skip   ${r.title} (already on the board)`);
      continue;
    }
    const t = await c.req('POST', '/api/tickets', r);
    const warn = t.warnings?.length ? `  WARNINGS: ${t.warnings.join(', ')}` : '';
    console.log(`create ${r.title} → ${t.id} (${t.status})${warn}`);
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
