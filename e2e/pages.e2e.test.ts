// ADR-0038 E2E: a planning agent publishes a mockup and attaches it to its plan. The same stack as
// m1b.e2e.test.ts (Postgres, the real orchestrator and daemon bins, the fake Claude), its own
// database and fixture repo, on conductor v4 saved again with planning's Pages turned on (the
// `pages` tool and `{"pages": {"max": 3}}` in its result, as the v6 draft does).
//
// The fake planner calls `publish_page` (the daemon posts it with its credential), then asks for
// approval with `plan_needs_approval` and the returned URL in `pages`. Plan review (the session
// detail behind it) lists the page as hosted; GET /p/:id serves it with the sandbox CSP; once
// expired it answers 410. Rust daemon only: the frozen TS daemon has no publish_page (TD-216).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher } from './harness/api.js';
import { createFixtureRepo } from './harness/fixture-repo.js';
import { DAEMON_KIND, REPO_ROOT, SETUP_TIMEOUT_MS, Stack } from './harness/stack.js';

const SKIP = process.env.E2E_REAL_CLAUDE === '1' || DAEMON_KIND !== 'rust';

interface Def {
  id: string;
  version: number;
  states: Record<string, Record<string, unknown>>;
}
const CONDUCTOR_V4 = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/design/workflows/conductor.v4.json'), 'utf8'),
) as Def;
/** conductor v4 with planning's Pages on. */
const WITH_PAGES: Def = (() => {
  const def = structuredClone(CONDUCTOR_V4);
  def.states.planning!.tools = ['read', 'pages'];
  def.states.planning!.result = ['plan', 'summary', { pages: { max: 3 } }];
  return def;
})();

const MOCKUP = '<!doctype html><h1>Filter bar mockup</h1><script>document.title="x"</script>';
const SCENARIOS = {
  pages: {
    turns: [
      [
        { say: 'Drawing a mockup.' },
        { tool: 'publish_page', args: { title: 'Filter bar mockup', html: MOCKUP } },
        {
          complete_state: {
            plan: '1. Add the filter bar (see the mockup).',
            summary: 'plan with a mockup',
            pages: [{ url: '$tool_url', title: 'Filter bar mockup' }],
          },
          transition: 'plan_needs_approval',
          reason: 'Does this mockup match what you want?',
        },
      ],
    ],
  },
};

let stack: Stack;
let api: Api;
let board: BoardWatcher;
let repo: string;

beforeAll(async () => {
  if (SKIP) return;
  stack = new Stack();
  mkdirSync(stack.scenarioDir);
  for (const [name, s] of Object.entries(SCENARIOS)) {
    writeFileSync(join(stack.scenarioDir, `${name}.json`), JSON.stringify(s));
  }
  repo = createFixtureRepo(stack.fixtureRepo);
  try {
    await stack.start();
  } catch (err) {
    console.error(stack.logs());
    throw err;
  }
  api = new Api(stack.baseUrl);
  board = new BoardWatcher(stack.baseUrl);
  await api.saveWorkflow(WITH_PAGES);
  await stack.waitForDaemon(async () =>
    (await api.machines()).find((m) => m.id === stack.machineId && m.status === 'online'),
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  board?.close();
  await stack?.stop();
}, 60_000);

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    console.error(`E2E failure: process logs\n${stack.logs()}`);
  });
});

describe.skipIf(SKIP)('ADR-0038 pages (fake Claude, Rust daemon)', () => {
  it('planning publishes a mockup, Plan review lists it, /p/:id serves it, then it expires', async () => {
    const t = await api.createTicket({
      title: 'Filter bar',
      body: 'Add a filter bar.\n\nfake-scenario: pages',
      repo,
      kind: 'personal',
    });
    const asked = await board.card(
      t.id,
      'the plan to approve',
      (c) => c.column === 'needs_input' && c.input_request !== null,
    );
    const detail = await api.session(asked.session_id!);
    expect(detail.pages).toHaveLength(1);
    const page = detail.pages![0]!;
    expect(page).toMatchObject({
      title: 'Filter bar mockup',
      state: 'planning',
      hosted: true,
      expired: false,
    });
    const url = new URL(page.url);
    expect(url.pathname).toMatch(/^\/p\/[0-9a-f-]{36}$/);
    // The days left: the default 7.
    const days = (Date.parse(page.expires_at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);

    // Opening it (local mode: the loopback user is signed in).
    const served = await fetch(`${stack.baseUrl}${url.pathname}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(MOCKUP);
    expect(served.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'");

    // After its TTL (moved into the past rather than waited for): gone.
    await stack.db.pool.query("UPDATE page SET expires_at = now() - interval '1 second'");
    expect((await fetch(`${stack.baseUrl}${url.pathname}`)).status).toBe(410);
    expect((await api.session(asked.session_id!)).pages![0]!.expired).toBe(true);
  });
});
