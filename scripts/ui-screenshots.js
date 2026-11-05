#!/usr/bin/env node
// UI review screenshots (docs/qa/ux-review/). Starts the web app on the still mock API
// (VITE_API=mock, VITE_MOCK_STATIC=1), drives it with Chrome through playwright-core, and writes
// docs/qa/ux-review/<out>/<screen>-<w>x<h>-<theme>.png plus metrics.json (page overflow and the
// visible tap targets under 44 px, per shot). Not run in CI.
//
// A board, detail or new-ticket shot above the phone breakpoint whose page is taller than the
// window prints a WARN line (UXR-26: the desktop board's document must not scroll).
//
//   node scripts/ui-screenshots.js [--out before|after] [--url http://localhost:5173] [--only board,detail]
//
// `--only` re-takes those screens at every size and keeps the rest of metrics.json.
// The `*-permission` screens (UXR-32) need the `VITE_MOCK_PERMISSION=1` mock scene, which changes
// the whole board: they are taken only when `--only` lists nothing else (the script then sets it)
// or when VITE_MOCK_PERMISSION=1 is already in the environment.
//
// Chrome: CHROME_PATH, else playwright's `chrome` channel (an installed Google Chrome).
/// <reference lib="dom" />
/* global document, window -- page.evaluate callbacks run in the browser */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
/** @type {(name: string, fallback: string) => string} */
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return (i >= 0 ? args[i + 1] : undefined) ?? fallback;
};
const out = arg('out', 'before');
const only = arg('only', '').split(',').filter(Boolean);
const outDir = join(root, 'docs/qa/ux-review', out);
const isPermissionShot = (/** @type {string} */ id) => id.endsWith('-permission');
/** UXR-32: the mock board holds a tool permission (api/select.ts VITE_MOCK_PERMISSION). */
const permissionScene =
  process.env.VITE_MOCK_PERMISSION === '1' || (only.length > 0 && only.every(isPermissionShot));

/** The needs-input card the panel shots open (api/mock-data.ts). */
const CARD = 'Add audit log table';
/** A running card with a ticket body, so the Brief shows (api/mock-data.ts). */
const BRIEF_CARD = 'Add pagination to /orders';
/** The card VITE_MOCK_PERMISSION=1 holds on a permission (api/select.ts). */
const PERMISSION_CARD = BRIEF_CARD;
/** The plan-approval card (06 §Plan approval; api/mock-data.ts planApprovalSeed). */
const PLAN_CARD = 'Add rate limiting to /login';
/** The ticket-panel shots (11-web-ui §Phone layout, Detail panel). */
const TICKET_SHOTS = ['ticket-messages', 'ticket-plan', 'ticket-plan-sheet', 'ticket-brief-sheet'];
/** UXR-26: shots whose page must fit the window above the phone breakpoint (11-web-ui §Breakpoint). */
const PAGE_FIT_SHOTS = ['board', 'detail', 'new-ticket'];
/** The phone breakpoint (MOBILE_QUERY in packages/web/src/components/useMediaQuery.ts). */
const PHONE_MAX_WIDTH = 699.98;

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').Locator} Locator
 * @typedef {{ w: number, h: number, deviceScaleFactor: number, isMobile?: boolean,
 *   hasTouch?: boolean, themes: Partial<Record<'light' | 'dark', 'all' | string[]>> }} Viewport
 * @typedef {{ id: string, path: string, act?: (page: Page) => Promise<void>, fullPage?: boolean }} Screen
 * @typedef {ReturnType<typeof measure> | { error: string }} Metric
 */

const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
/** @type {Viewport[]} */
const VIEWPORTS = [
  {
    w: 375,
    h: 812,
    ...PHONE,
    themes: { light: 'all', dark: ['board', 'detail', 'new-ticket', 'ticket-plan'] },
  },
  {
    w: 360,
    h: 740,
    ...PHONE,
    themes: {
      light: [
        'board',
        'detail',
        'detail-scrolled',
        'new-ticket',
        'new-ticket-bottom',
        ...TICKET_SHOTS,
      ],
    },
  },
  {
    w: 768,
    h: 1024,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    themes: { light: ['board', 'detail', 'new-ticket', 'new-ticket-bottom'] },
  },
  {
    w: 1440,
    h: 900,
    deviceScaleFactor: 1,
    themes: {
      light: [
        'board',
        'detail',
        'new-ticket',
        'new-ticket-bottom',
        'machines',
        'machines-team',
        'workflows',
        'wf-diagram-end',
        'wf-rules-full',
        'wf-rules-new',
        'wf-arrow-group',
        'rc-override-full',
        'rc-invalid',
        'wf-arrow-transition',
        'wf-proposal-open',
        'wf-version-old',
        'workflow-column',
        'ticket-messages',
        'ticket-plan',
        'board-permission',
        'detail-permission',
        'detail-done',
        'detail-done-steps',
      ],
      dark: ['board', 'detail'],
    },
  },
];

/**
 * A DOM click: the shots record states, and a control a phone user can't reach (off-screen in an
 * overflowing row) still opens its state. Reachability is judged from the shots and metrics.json.
 */
/** @param {Locator} locator */
async function tap(locator) {
  await locator.waitFor({ state: 'attached' });
  await locator.evaluate((el) => /** @type {HTMLElement} */ (el).click());
}

/** @param {Page} page @param {'button' | 'tab'} role @param {string} name */
async function clickNamed(page, role, name) {
  await tap(page.getByRole(role, { name, exact: true }).first());
}

/** @param {Page} page @param {string} [title] */
async function openCard(page, title = CARD) {
  // On a phone the board shows one column: pick the card's column first if it isn't shown.
  const card = page.locator('.card-open', { hasText: title }).first();
  if ((await card.count()) === 0) {
    for (const tab of await page.locator('.column-switcher [role="tab"]').all()) {
      await tap(tab);
      await page.waitForTimeout(150);
      if ((await card.count()) > 0) break;
    }
  }
  await tap(card);
  await page.locator('aside.detail').waitFor();
  await page.waitForTimeout(300);
}

/**
 * A ticket-strip button (TicketStrip.tsx) when the panel has one (the phone, after this ticket);
 * false when it doesn't (desktop, or the "before" build).
 * @param {Page} page @param {string} cls
 */
async function tapStrip(page, cls) {
  const button = page.locator(`.ticket-strip .${cls}`);
  if ((await button.count()) === 0) return false;
  await tap(button.first());
  await page.waitForTimeout(300);
  return true;
}

/**
 * The Workflow page with one arrow's transition panel open (the arrow's aria-label starts
 * "Arrow <from> → <to>:", WorkflowsView.test.tsx).
 * @param {Page} page @param {string} from @param {string} to
 */
async function openArrow(page, from, to) {
  await page.locator('.wf-lanes').first().waitFor();
  // An SVG <g role="button">: no HTMLElement.click(), so dispatch the click.
  const arrow = page.getByRole('button', { name: new RegExp(`^Arrow ${from} → ${to}:`) }).first();
  await arrow.waitFor({ state: 'attached' });
  await arrow.dispatchEvent('click');
  await page.locator('aside.wf-editor').waitFor();
}

/** Each screen starts from a fresh load of `path`, then `act`s. @type {Screen[]} */
const SCREENS = [
  { id: 'board', path: '/#/' },
  {
    id: 'board-scrolled',
    path: '/#/',
    act: async (page) => {
      await page.evaluate(() => {
        const board = document.querySelector('.board');
        if (board) board.scrollLeft = board.scrollWidth;
        window.scrollTo(document.documentElement.scrollWidth, 0);
      });
    },
  },
  { id: 'detail', path: '/#/', act: openCard },
  {
    id: 'detail-scrolled',
    path: '/#/',
    act: async (page) => {
      await openCard(page);
      await page.locator('aside.detail').scrollIntoViewIfNeeded();
    },
  },
  {
    id: 'detail-details',
    path: '/#/',
    act: async (page) => {
      await openCard(page);
      await clickNamed(page, 'tab', 'Details');
      await page.locator('aside.detail').scrollIntoViewIfNeeded();
    },
  },
  // UXR-38: a done ticket's history from the transcript (the ticket as markdown, "Finished …").
  { id: 'detail-done', path: '/#/', act: (page) => openCard(page, 'Rename user.fullname') },
  {
    // UXR-88: its Steps, the first recorded result open.
    id: 'detail-done-steps',
    path: '/#/',
    act: async (page) => {
      await openCard(page, 'Rename user.fullname');
      await clickNamed(page, 'tab', 'Details');
      await tap(page.locator('.star-steps button', { hasText: 'Result' }).first());
      await page.locator('.star-steps').scrollIntoViewIfNeeded();
    },
  },
  {
    id: 'composer-focused',
    path: '/#/',
    act: async (page) => {
      await openCard(page);
      const box = page.locator('.composer textarea');
      await box.scrollIntoViewIfNeeded();
      await box.focus();
      await box.fill('Use a separate audit schema, please');
    },
  },
  {
    id: 'new-ticket',
    path: '/#/',
    act: async (page) => {
      await clickNamed(page, 'button', 'New ticket');
      await page.locator('form.create-ticket').waitFor();
      await page.waitForTimeout(800); // the rich editor chunk
    },
  },
  {
    id: 'new-ticket-bottom',
    path: '/#/',
    act: async (page) => {
      await clickNamed(page, 'button', 'New ticket');
      await page.locator('form.create-ticket').waitFor();
      await page.waitForTimeout(800);
      await page
        .getByRole('button', { name: 'Create ticket', exact: true })
        .scrollIntoViewIfNeeded();
    },
  },
  {
    id: 'account-menu',
    path: '/#/',
    act: async (page) => {
      await tap(page.locator('.account-button'));
    },
  },
  // The ticket panel's Messages tab: the brief above the chat (BRIEF_CARD has a ticket body).
  { id: 'ticket-messages', path: '/#/', act: (page) => openCard(page, BRIEF_CARD) },
  { id: 'ticket-plan', path: '/#/', act: (page) => openCard(page, PLAN_CARD) },
  {
    id: 'ticket-plan-sheet',
    path: '/#/',
    act: async (page) => {
      await openCard(page, PLAN_CARD);
      // Before the strip, the plan is only in the chat: scroll it into view.
      if (!(await tapStrip(page, 'ticket-strip-plan'))) {
        await page.locator('.plan-approval .plan-body').scrollIntoViewIfNeeded();
      }
    },
  },
  {
    id: 'ticket-brief-sheet',
    path: '/#/',
    act: async (page) => {
      await openCard(page, BRIEF_CARD);
      // Before the strip, the brief is open inline already.
      await tapStrip(page, 'ticket-strip-brief');
    },
  },
  // UXR-32: a pending permission counts on Needs input; the panel says "waiting for permission".
  { id: 'board-permission', path: '/#/' },
  { id: 'detail-permission', path: '/#/', act: (page) => openCard(page, PERMISSION_CARD) },
  { id: 'machines', path: '/#/machines' },
  // UXR-89 (UX-13b FR-3): the agent team below the machines, at full height.
  {
    id: 'machines-team',
    path: '/#/machines',
    act: async (page) => {
      await page.getByRole('list', { name: 'Agent team' }).waitFor();
    },
    fullPage: true,
  },
  // ADR-0030: the mock's seeded override, open.
  { id: 'repo-checks', path: '/#/repo-checks/github.com%2Facme%2Fshop' },
  // UXR-61: the override's setup and check table, at full height.
  { id: 'rc-override-full', path: '/#/repo-checks/github.com%2Facme%2Fshop', fullPage: true },
  // UXR-61 FR-5: problems in the check table, each under its field and named by its label.
  {
    id: 'rc-invalid',
    path: '/#/repo-checks/github.com%2Facme%2Fshop',
    fullPage: true,
    act: async (page) => {
      const name = page.getByLabel('Check 1 name', { exact: true });
      await name.waitFor();
      await name.fill('');
      await page.getByLabel('Check 1 timeout', { exact: true }).fill('soon');
    },
  },
  { id: 'workflows', path: '/#/workflows' },
  // UXR-45: the diagram's scroll box scrolled to its right end (fit to width: nothing hidden).
  {
    id: 'wf-diagram-end',
    path: '/#/workflows',
    act: async (page) => {
      await page.locator('.wf-lanes').first().waitFor();
      await page.evaluate(() => {
        const box = document.querySelector('.wf-diagram .wf-scroll');
        if (box) box.scrollLeft = box.scrollWidth;
      });
    },
  },
  // UXR-60/63: a transition with every kind of rule, at its full height (the panel uncapped).
  {
    id: 'wf-rules-full',
    path: '/#/workflows',
    fullPage: true,
    act: async (page) => {
      await openArrow(page, 'Implementing', 'Waiting external');
      await page.evaluate(() => {
        const panel = /** @type {HTMLElement | null} */ (document.querySelector('aside.wf-editor'));
        if (panel) panel.style.maxHeight = 'none';
      });
    },
  },
  // A transition with no requirements: closed sections, "Nothing is required".
  {
    id: 'wf-rules-new',
    path: '/#/workflows',
    act: (page) => openArrow(page, 'Planning', 'Implementing'),
  },
  // UXR-64: an arrow with several transitions opens on their list (before: on the first one).
  {
    id: 'wf-arrow-group',
    path: '/#/workflows',
    act: (page) => openArrow(page, 'Implementing', 'Needs input'),
  },
  // UXR-66: one of them picked from the list: the breadcrumb Column › arrow › transition.
  {
    id: 'wf-arrow-transition',
    path: '/#/workflows',
    act: async (page) => {
      await openArrow(page, 'Implementing', 'Needs input');
      const row = page.locator('.wf-transition-row', { hasText: 'Personal only' });
      if ((await row.count()) > 0) await tap(row.first());
    },
  },
  // UXR-73: an open advisor proposal: its diff in the editor's words, its changes highlighted on
  // the diagram (the mock's open workflow proposal, api/mock-data.ts).
  {
    id: 'wf-proposal-open',
    path: '/#/workflows',
    fullPage: true,
    act: async (page) => {
      await page.locator('.wf-lanes').first().waitFor();
      await tap(page.locator('.cp-summary', { hasText: 'Typecheck before testing' }).first());
      await page.locator('.cp-detail .wf-diff').waitFor();
      // The highlighted column into the diagram's view; the page itself stays at the top.
      await page.locator('[data-lane="waiting_external"]').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  // UXR-70: an old version, compared with the latest (the diff above the diagram).
  {
    id: 'wf-version-old',
    path: '/#/workflows',
    fullPage: true,
    act: async (page) => {
      await page.locator('.wf-lanes').first().waitFor();
      await page.getByRole('combobox', { name: 'Version' }).selectOption('2');
      const note = page.locator('.wf-old-version');
      await note.waitFor();
      await tap(note.getByRole('button', { name: 'Compare with latest' }));
      await page.locator('.wf-diff-section .wf-diff').first().waitFor();
    },
  },
  // UXR-65: a column's panel, its transitions listed by title.
  {
    id: 'workflow-column',
    path: '/#/workflows',
    act: async (page) => {
      await page.locator('.wf-lanes').first().waitFor();
      const lane = page.getByRole('button', { name: /^Column Implementing:/ }).first();
      await lane.waitFor({ state: 'attached' });
      await lane.dispatchEvent('click');
      await page.locator('aside.wf-editor').waitFor();
    },
  },
  { id: 'setup', path: '/#/setup' },
  { id: 'help', path: '/help/add-a-machine' },
  { id: 'help-connect-claude', path: '/help/connect-claude' },
  { id: 'signin', path: '/signin' },
];

/** Page overflow and visible interactive elements smaller than 44×44 (WCAG 2.5.5 / UX-12 FR-4). */
/** @param {number} deviceWidth */
function measure(deviceWidth) {
  // With isMobile, Chrome widens the layout viewport to fit an overflowing page, so compare the
  // page against the device width, not innerWidth.
  const vw = deviceWidth;
  const vh = window.innerHeight;
  const small = [];
  for (const el of document.querySelectorAll(
    'button, a[href], input, select, textarea, [role="tab"]',
  )) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    if (el.closest('[hidden]')) continue;
    if (r.width < 44 || r.height < 44) {
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
      small.push(
        `${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`,
      );
    }
  }
  // The chat's visible height (the session panel's Messages log), when a panel is open.
  const chat = document.querySelector('aside.detail .output-chat .output');
  return {
    chatHeight: chat ? Math.round(chat.getBoundingClientRect().height) : null,
    pageScrollWidth: document.documentElement.scrollWidth,
    deviceWidth: vw,
    horizontalOverflow: document.documentElement.scrollWidth > vw,
    pageHeight: document.documentElement.scrollHeight,
    smallTapTargets: small.length,
    smallTapTargetSample: small.slice(0, 8),
  };
}

/**
 * UXR-26: a desktop board, detail or new-ticket shot taller than the window means the page scrolls.
 * @param {string} screenId @param {Viewport} vp @param {Metric} metric
 * @returns {string | null}
 */
function fitWarning(screenId, vp, metric) {
  if (vp.w <= PHONE_MAX_WIDTH || !PAGE_FIT_SHOTS.includes(screenId)) return null;
  if (!('pageHeight' in metric) || metric.pageHeight <= vp.h) return null;
  return `pageHeight ${metric.pageHeight} > viewport ${vp.h} (the page scrolls; UXR-26)`;
}

/** @returns {Promise<number>} */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startVite() {
  const port = await freePort();
  const child = spawn(
    'pnpm',
    ['--filter', '@conductor/web', 'exec', 'vite', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      env: {
        ...process.env,
        VITE_API: 'mock',
        VITE_MOCK_STATIC: '1',
        ...(permissionScene ? { VITE_MOCK_PERMISSION: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const url = `http://localhost:${port}`;
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('vite did not start in 60 s')), 60_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes(String(port))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`vite exited (${code})`)));
    })
  );
  return { url, stop: () => child.kill('SIGTERM') };
}

async function main() {
  const given = arg('url', '');
  const server = given ? { url: given, stop: () => {} } : await startVite();
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
  );
  await mkdir(outDir, { recursive: true });
  /** @type {Record<string, Metric>} */
  const metrics = {};
  /** @type {string[]} */
  const warnings = [];
  // `--only` re-takes some shots: keep the other shots' metrics.
  if (only.length > 0) {
    try {
      Object.assign(metrics, JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8')));
    } catch {
      // No earlier run.
    }
  }
  try {
    for (const vp of VIEWPORTS) {
      for (const [theme, list] of Object.entries(vp.themes)) {
        const context = await browser.newContext({
          viewport: { width: vp.w, height: vp.h },
          deviceScaleFactor: vp.deviceScaleFactor,
          isMobile: vp.isMobile ?? false,
          hasTouch: vp.hasTouch ?? false,
          colorScheme: /** @type {'light' | 'dark'} */ (theme),
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        for (const screen of SCREENS) {
          if (list !== 'all' && !list.includes(screen.id)) continue;
          if (only.length > 0 && !only.includes(screen.id)) continue;
          if (isPermissionShot(screen.id) !== permissionScene) continue;
          const name = `${screen.id}-${vp.w}x${vp.h}-${theme}`;
          try {
            // A hash-only change wouldn't reload, so every shot starts from a blank page.
            await page.goto('about:blank');
            await page.goto(`${server.url}${screen.path}`, { waitUntil: 'networkidle' });
            // The first load of a cold Vite server can go idle before React has rendered.
            await page.locator('#root > *').first().waitFor();
            await page.waitForTimeout(400);
            await screen.act?.(page);
            await page.waitForTimeout(300);
            await page.screenshot({
              path: join(outDir, `${name}.png`),
              fullPage: screen.fullPage ?? false,
            });
            const metric = await page.evaluate(measure, vp.w);
            metrics[name] = metric;
            console.log(`ok   ${name}`);
            const warn = fitWarning(screen.id, vp, metric);
            if (warn) {
              warnings.push(`WARN ${name}: ${warn}`);
              console.log(warnings[warnings.length - 1]);
            }
          } catch (err) {
            const error = String(err).split('\n')[0] ?? '';
            metrics[name] = { error };
            console.log(`FAIL ${name}: ${error}`);
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
  await writeFile(join(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} WARN:`);
    for (const w of warnings) console.log(w);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
