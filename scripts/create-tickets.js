#!/usr/bin/env node
// Create conductor tickets on the board, one per `### <ID> · <title>` block of a plan file
// (M3-Tnn in the M3 milestone, UX-nn in docs/plan/UX-board-and-notifications.md).
//
//   node scripts/create-tickets.js --dry-run T01 T02 ...                   # M3, the default file
//   node scripts/create-tickets.js --file docs/plan/UX-board-and-notifications.md UX-10 UX-11
//   CONDUCTOR_EMAIL=... node scripts/create-tickets.js T01                  # prompts for the password
//
// With no ids it takes every ticket block in the file. Env: CONDUCTOR_URL (default
// https://conductor.gradyserver.com), CONDUCTOR_EMAIL, CONDUCTOR_PASSWORD (optional; prompted if
// absent), CONDUCTOR_WORKFLOW (default conductor_dev).
// Re-running is safe: a ticket whose title is already on the board is skipped.
// TD-172: no depends_on until M2b, so only create a wave once every dependency is merged (each
// plan file's ticket waves).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = 'docs/plan/milestones/M3-mcp.md';
const BASE = (process.env.CONDUCTOR_URL ?? 'https://conductor.gradyserver.com').replace(/\/$/, '');
const WORKFLOW = process.env.CONDUCTOR_WORKFLOW ?? 'conductor_dev';
const REPO = 'github.com/benjgrad/conductor';
// M3: T17 is the lead's; T18/T19 "later". MR: T00 is the lead's (plan, ADR-0026).
const NOT_TICKETS = new Set(['M3-T17', 'M3-T18', 'M3-T19', 'MR-T00']);
// The M3 migration needs Ben's review early. The UX migrations (UX-13a, UX-15) stay at 0 so they
// queue behind M2/M2r work instead of jumping it (Ben, 2026-10-28).
const PRIORITY = { 'M3-T02': 1 };

const M3_CONTRACTS =
  '- Code against the M3-T01 contracts (`shared/src/mcp/**`, `shared/src/api/oauth.ts`, `api/rest.ts`). A needed contract change is reported in the PR, never made locally.\n';
const M3_DESIGN =
  'Start at 10-contracts §Tool layer and MCP and `docs/adr/0014-tool-layer-and-oauth-mcp-server.md`. The full plan is `docs/plan/milestones/M3-mcp.md`.';

// MR (Rust daemon, ADR-0026): the TS daemon is frozen and is the behaviour reference.
const MR_RULES =
  '- The TypeScript daemon (`packages/daemon`) is frozen and is the behaviour reference: read it, never change it, except where this ticket\'s "Files owned" says so. A behaviour difference you intend needs a design-doc edit in this PR.\n' +
  '- Every TS test case your ticket ports gets its row in `crates/conductor-daemon/PARITY.md` (Rust test path, or `dropped: <reason>` listed in the PR for Ben), and its file globs go in the ported list; `node scripts/test-parity.js` must pass.\n' +
  '- OS-specific code (`cfg(windows)`, `cfg(unix)`, `cfg(target_os …)`) only under `crates/conductor-daemon/src/platform/`. Protocol frames only through `conductor-protocol` types. On-disk files stay byte-compatible with the TS daemon.\n' +
  '- If `cargo` is not on PATH, stop and ask (B-005). Never install a toolchain on the machine yourself.\n' +
  '- Windows is proven by the `daemon-rust` GitHub Actions matrix on your PR; wait for it to be green before finishing.\n';
const MR_GATES =
  "- Gates: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && node scripts/test-slot.js cargo nextest run --workspace`, plus `pnpm typecheck && pnpm lint` (and `pnpm test` / `pnpm test:e2e` where the block touches TS or says so). Run targeted tests (`cargo nextest run -p conductor-daemon <module>`) while iterating; conductor's checks and the PR's Actions are the full run.\n";
const PNPM_GATES =
  "- Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (DB tests need `pnpm db:up`), plus `pnpm test:e2e` where the block says so. Run targeted tests while iterating; conductor's checks are the full run.\n";

const rules = (id, planFile) => {
  const m3 = id.startsWith('M3-');
  const mr = id.startsWith('MR-');
  return `
---

## Rules for every ticket
- Do not edit \`docs/tracking/*\`. Report new unknowns, tech debt, unfinished items and needed contract changes in the PR description instead.
${m3 ? M3_CONTRACTS : ''}${mr ? MR_RULES : ''}- A shortcut needs a \`// TD: <what>\` comment at the site and a line in the PR report (the lead assigns the TD number).
- A migration is never merged without Ben's approval: a task with a migration stops at "PR open, awaiting Ben".
- Work on branch \`${id.toLowerCase()}-<slug>\`. Merge \`origin/main\` before finishing (never rebase); the "Merges cleanly with main" check must pass.
${mr ? MR_GATES : PNPM_GATES}- Design source of truth: \`docs/design/\` and \`docs/adr/\`. ${m3 ? M3_DESIGN : `The full plan is \`${planFile}\`.`}
`;
};

function parseBlocks(md) {
  const lines = md.split('\n');
  const blocks = new Map();
  let cur = null;
  for (const line of lines) {
    const m = /^### ([A-Z][A-Za-z0-9]*-[A-Za-z0-9]+) · (.+)$/.exec(line);
    if (m) {
      cur = { id: m[1], title: `${m[1]} · ${m[2].trim()}`, lines: [] };
      blocks.set(m[1], cur);
      continue;
    }
    if (cur && (/^### /.test(line) || /^---\s*$/.test(line) || /^# /.test(line))) cur = null;
    if (cur) cur.lines.push(line);
  }
  return blocks;
}

function buildRequest(block, planFile) {
  const body = block.lines.join('\n').trim() + '\n' + rules(block.id, planFile);
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
  const fi = args.indexOf('--file');
  const planFile = fi >= 0 ? args[fi + 1] : DEFAULT_FILE;
  if (!planFile) throw new Error('--file needs a path');
  const ids = args
    .filter((a, i) => !a.startsWith('--') && !(fi >= 0 && i === fi + 1))
    // A bare Tnn means M3-Tnn (the default file).
    .map((a) => (/^T\d\d$/i.test(a) ? `M3-${a.toUpperCase()}` : a));
  const path = resolve(REPO_ROOT, planFile);
  const blocks = parseBlocks(readFileSync(path, 'utf8'));
  const wanted = ids.length ? ids : [...blocks.keys()].filter((id) => !NOT_TICKETS.has(id));

  const reqs = wanted.map((id) => {
    if (NOT_TICKETS.has(id)) throw new Error(`${id} is not a ticket (lead task or "later")`);
    const b = blocks.get(id);
    if (!b) throw new Error(`no "### ${id} · …" block in ${path}`);
    return buildRequest(b, planFile);
  });
  const titles = new Set(reqs.map((r) => r.title));
  if (titles.size !== reqs.length) throw new Error('duplicate titles');

  if (dry) {
    for (const r of reqs) {
      const firstLines = args.includes('--full')
        ? '\n' + r.body
        : r.body.split('\n').slice(0, 3).join(' | ');
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
