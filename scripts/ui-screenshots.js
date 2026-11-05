#!/usr/bin/env node
// UI review screenshots (docs/qa/ux-review/). Starts the web app on the still mock API
// (VITE_API=mock, VITE_MOCK_STATIC=1), drives it with Chrome through playwright-core, and writes
// docs/qa/ux-review/<out>/<screen>-<w>x<h>-<theme>.png plus metrics.json (page overflow and the
// visible tap targets under 44 px, per shot). Not run in CI.
//
//   node scripts/ui-screenshots.js [--out before|after] [--url http://localhost:5173] [--only board,detail]
//
// `--only` re-takes those screens at every size and keeps the rest of metrics.json.
//
// Chrome: CHROME_PATH, else playwright's `chrome` channel (an installed Google Chrome).
/// <reference lib="dom" />
/* global document, window, MouseEvent -- page.evaluate callbacks run in the browser */
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

/** The needs-input card the panel shots open (api/mock-data.ts). */
const CARD = 'Add audit log table';
/** A running card with a ticket body, so the Brief shows (api/mock-data.ts). */
const BRIEF_CARD = 'Add pagination to /orders';
/** The plan-approval card (06 §Plan approval; api/mock-data.ts planApprovalSeed). */
const PLAN_CARD = 'Add rate limiting to /login';
/** The ticket-panel shots (11-web-ui §Phone layout, Detail panel). */
const TICKET_SHOTS = ['ticket-messages', 'ticket-plan', 'ticket-plan-sheet', 'ticket-brief-sheet'];

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').Locator} Locator
 * @typedef {{ w: number, h: number, deviceScaleFactor: number, isMobile?: boolean,
 *   hasTouch?: boolean, themes: Partial<Record<'light' | 'dark', 'all' | string[]>> }} Viewport
 * @typedef {{ id: string, path: string, act?: (page: Page) => Promise<void>,
 *   scene?: keyof typeof SCENES, desktopOnly?: boolean,
 *   fullPage?: boolean }} Screen
 * @typedef {ReturnType<typeof measure> | { error: string }} Metric
 */

/**
 * Mock scenes (api/select.ts): Vite env for states the default mock doesn't show. A screen with a
 * `scene` is shot on its own Vite server started with that env.
 */
const SCENES = {
  /** Accounts mode, signed in as the admin. */
  admin: { VITE_MOCK_AUTH: 'password' },
  /** Accounts mode, signed out (sign up, reset). */
  'signed-out': { VITE_MOCK_AUTH: 'signed-out' },
  /** No machines: the first-run guide. */
  'first-run': { VITE_MOCK_MACHINES: 'none' },
  /** A pending tool permission request on the running BRIEF_CARD. */
  permission: { VITE_MOCK_PERMISSION: '1' },
};

/** The full-platform review (docs/qa/ux-review/full-2026-11): every screen and state. */
/** The workflow designer, in depth (full-2026-11 §Workflow designer): desktop only. */
const WORKFLOW_DESIGNER = [
  'wf-arrow-group',
  'wf-rules-full',
  'wf-rules-new',
  'wf-name-error',
  'wf-column-human',
  'wf-column-done',
  'wf-diagram-end',
  'wf-version-old',
  'wf-unsaved-guard',
  'wf-proposal-open',
  'wf-keyboard-focus',
  'rc-override-full',
  'rc-new-override',
  'rc-invalid',
  'rc-clear-confirm',
];

const FULL_REVIEW = [
  'detail-review',
  'detail-checks',
  'detail-failed',
  'detail-done',
  'detail-lost',
  'detail-permission',
  'board-permission',
  'ticket-queued',
  'workflow-column',
  'workflow-transition',
  'machine-drawer',
  'add-machine',
  'repo-checks',
  'repo-checks-list',
  'first-run',
  'admin',
  'account-menu-admin',
  'change-password',
  'signup',
  'reset',
];

const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
/** @type {Viewport[]} */
const VIEWPORTS = [
  {
    w: 375,
    h: 812,
    ...PHONE,
    themes: {
      light: 'all',
      dark: ['board', 'detail', 'new-ticket', 'ticket-plan', 'detail-review', 'machines'],
    },
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
    themes: { light: ['board', 'detail', 'new-ticket', 'workflows', 'machines', 'detail-review'] },
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
        'machines',
        'workflows',
        'ticket-messages',
        'ticket-plan',
        'board-collapsed',
        'setup',
        'signin',
        ...FULL_REVIEW,
        ...WORKFLOW_DESIGNER,
      ],
      dark: ['board', 'detail', 'detail-review', 'workflows', 'machines', 'new-ticket'],
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
  // SVG elements (the workflow diagram) have no click(): dispatch the event instead.
  await locator.evaluate((el) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
  );
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
  // On a desktop, a collapsed column (UX-9: Done starts collapsed) doesn't render its cards.
  if ((await card.count()) === 0) {
    for (const toggle of await page.locator('.column.collapsed .column-toggle').all()) {
      await tap(toggle);
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

/** Open a column's editor in the workflow diagram (by its state id). @param {Page} page @param {string} lane */
async function openLane(page, lane) {
  await tap(page.locator(`g.selectable[data-lane="${lane}"]`));
  await page.locator('aside.wf-editor[aria-label="Column"]').waitFor();
}

/**
 * Open a transition from its column's editor (the list shows `name → Column`).
 * @param {Page} page @param {string} lane @param {string} name
 */
async function openTransition(page, lane, name) {
  await openLane(page, lane);
  await tap(page.locator('.wf-transition', { hasText: new RegExp(`^${name} `) }).first());
  await page.locator('aside.wf-editor[aria-label="Transition"]').waitFor();
}

/** Let the editor panel grow to its full height, for a `fullPage` shot of every field. @param {Page} page */
async function unclampEditor(page) {
  await page.addStyleTag({
    content:
      '.wf-editor { max-height: none !important; overflow: visible !important; } ' +
      'html, body, #root, #root > *, .wf-view, .wf-main { height: auto !important; ' +
      'max-height: none !important; overflow: visible !important; }',
  });
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
  { id: 'machines', path: '/#/machines' },
  // The full review (FULL_REVIEW): every other state the mock can show.
  {
    id: 'board-collapsed',
    path: '/#/',
    desktopOnly: true,
    act: async (page) => {
      await tap(page.locator('.column-done .column-toggle'));
      await tap(
        page
          .locator('.column-waiting_external .column-toggle, .column-review .column-toggle')
          .first(),
      );
    },
  },
  // UX-4: a finished agent's report with its PR and proposed follow-ups.
  {
    id: 'detail-review',
    path: '/#/',
    act: (page) => openCard(page, 'Board cards: review requests vs questions'),
  },
  { id: 'detail-checks', path: '/#/', act: (page) => openCard(page, 'Conductor checks demo') },
  { id: 'detail-failed', path: '/#/', act: (page) => openCard(page, 'Fix flaky checkout test') },
  { id: 'detail-done', path: '/#/', act: (page) => openCard(page, 'Rename user.fullname') },
  { id: 'detail-lost', path: '/#/', act: (page) => openCard(page, 'Upgrade webpack') },
  { id: 'board-permission', path: '/#/', scene: 'permission' },
  {
    id: 'detail-permission',
    path: '/#/',
    scene: 'permission',
    act: (page) => openCard(page, BRIEF_CARD),
  },
  // A queued ticket (no session yet): the ticket panel, with M2-T11's routing note.
  {
    id: 'ticket-queued',
    path: '/#/',
    act: (page) => openCard(page, 'Hotfix: crash on empty cart'),
  },
  {
    id: 'workflow-column',
    path: '/#/workflows',
    act: async (page) => {
      await tap(page.locator('g.selectable[data-lane]').nth(1));
    },
  },
  {
    id: 'workflow-transition',
    path: '/#/workflows',
    act: async (page) => {
      await tap(page.locator('.wf-edges .selectable').first());
    },
  },
  {
    id: 'machine-drawer',
    path: '/#/machines',
    act: async (page) => {
      await tap(page.locator('[aria-label^="Details of"]').first());
    },
  },
  {
    id: 'add-machine',
    path: '/#/machines',
    act: async (page) => {
      await tap(page.locator('section.machines button', { hasText: 'Add a machine' }).first());
      await page.locator('[role="dialog"][aria-label="Add a machine"]').waitFor();
    },
  },
  { id: 'repo-checks-list', path: '/#/repo-checks' },
  { id: 'first-run', path: '/#/', scene: 'first-run' },
  { id: 'admin', path: '/#/admin', scene: 'admin' },
  {
    id: 'account-menu-admin',
    path: '/#/',
    scene: 'admin',
    act: async (page) => {
      await tap(page.locator('.account-button'));
    },
  },
  {
    id: 'change-password',
    path: '/#/',
    scene: 'admin',
    act: async (page) => {
      await tap(page.locator('.account-button'));
      await tap(page.getByRole('menuitem', { name: 'Change password' }));
      await page.locator('[role="dialog"][aria-label="Change password"]').waitFor();
    },
  },
  { id: 'signup', path: '/signup?invite=mock-invite-open', scene: 'signed-out' },
  { id: 'reset', path: '/reset?token=mock-reset', scene: 'signed-out' },
  // The workflow designer in depth (WORKFLOW_DESIGNER).
  {
    // An arrow that stands for several transitions (×n): the tabs above the form.
    id: 'wf-arrow-group',
    path: '/#/workflows',
    act: (page) => openTransition(page, 'implementing', 'pr_ready_for_review'),
  },
  {
    // A transition with requirements, every field of the rules builder.
    id: 'wf-rules-full',
    path: '/#/workflows',
    fullPage: true,
    act: async (page) => {
      await openTransition(page, 'implementing', 'ready_for_testing');
      await unclampEditor(page);
    },
  },
  {
    // Building rules from nothing: one blank check, review item and condition on plan_ready
    // (the first requirement brings "When not met"; the blank check is a problem, so Save is off).
    id: 'wf-rules-new',
    path: '/#/workflows',
    fullPage: true,
    act: async (page) => {
      await openTransition(page, 'planning', 'plan_ready');
      for (const name of ['Add check', 'Add review item', 'Add condition']) {
        await clickNamed(page, 'button', name);
      }
      await unclampEditor(page);
    },
  },
  {
    id: 'wf-name-error',
    path: '/#/workflows',
    act: async (page) => {
      await openTransition(page, 'planning', 'plan_ready');
      await page.getByLabel('Name', { exact: true }).fill('Plan ready!');
    },
  },
  { id: 'wf-column-human', path: '/#/workflows', act: (page) => openLane(page, 'needs_input') },
  {
    id: 'wf-column-done',
    path: '/#/workflows',
    act: async (page) => {
      await page.evaluate(() => {
        const box = document.querySelector('.wf-scroll');
        if (box) box.scrollLeft = box.scrollWidth;
      });
      await openLane(page, 'done');
    },
  },
  {
    // The right-hand end of the diagram (Waiting external, Done), scrolled inside its box.
    id: 'wf-diagram-end',
    path: '/#/workflows',
    act: async (page) => {
      await page.evaluate(() => {
        const box = document.querySelector('.wf-scroll');
        if (box) box.scrollLeft = box.scrollWidth;
      });
    },
  },
  {
    id: 'wf-version-old',
    path: '/#/workflows',
    act: async (page) => {
      const select = page.getByLabel('Version');
      const values = await select
        .locator('option')
        .evaluateAll((os) => os.map((o) => /** @type {HTMLOptionElement} */ (o).value));
      await select.selectOption(values[values.length - 1] ?? '1');
      await page.waitForTimeout(300);
    },
  },
  {
    // A draft, then Board: the unsaved-changes guard.
    id: 'wf-unsaved-guard',
    path: '/#/workflows',
    act: async (page) => {
      await openLane(page, 'planning');
      await page.getByLabel('Title', { exact: true }).fill('Plan it');
      await tap(page.locator('.topbar a', { hasText: 'Board' }).first());
      await page.locator('[role="alertdialog"][aria-label="Unsaved changes"]').waitFor();
    },
  },
  {
    id: 'wf-proposal-open',
    path: '/#/workflows',
    act: async (page) => {
      await tap(page.locator('.cp-summary').first());
      await page.waitForTimeout(300);
      await page.locator('.cp-panel').scrollIntoViewIfNeeded();
    },
  },
  // Repo checks overrides (ADR-0030), in depth.
  { id: 'rc-override-full', path: '/#/repo-checks/github.com%2Facme%2Fshop', fullPage: true },
  // A repo without an override: the editor starts from the workflow's checks.
  { id: 'rc-new-override', path: '/#/repo-checks/github.com%2Facme%2Fapi', fullPage: true },
  {
    id: 'rc-invalid',
    path: '/#/repo-checks/github.com%2Facme%2Fshop',
    fullPage: true,
    act: async (page) => {
      await page.getByLabel('Check 1 name').fill('');
      await page.getByLabel('Check 2 command').fill('');
    },
  },
  {
    id: 'rc-clear-confirm',
    path: '/#/repo-checks/github.com%2Facme%2Fshop',
    fullPage: true,
    act: (page) => clickNamed(page, 'button', 'Clear override'),
  },
  {
    // Keyboard: Tab onto the diagram (the second column), to see the focus ring.
    id: 'wf-keyboard-focus',
    path: '/#/workflows',
    act: async (page) => {
      await page.locator('g.selectable[data-lane="planning"]').focus();
    },
  },
  // ADR-0030: the mock's seeded override, open.
  { id: 'repo-checks', path: '/#/repo-checks/github.com%2Facme%2Fshop' },
  { id: 'workflows', path: '/#/workflows' },
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

/** @param {Record<string, string>} [extraEnv] */
async function startVite(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(
    'pnpm',
    ['--filter', '@conductor/web', 'exec', 'vite', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      env: { ...process.env, VITE_API: 'mock', VITE_MOCK_STATIC: '1', ...extraEnv },
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
  /** One Vite server per scene ('' = the default mock), started when a shot first needs it. */
  /** @type {Map<string, { url: string, stop: () => void }>} */
  const servers = new Map();
  /** @param {string} scene */
  const serverFor = async (scene) => {
    let server = servers.get(scene);
    if (!server) {
      server =
        given && !scene
          ? { url: given, stop: () => {} }
          : await startVite(scene ? SCENES[/** @type {keyof typeof SCENES} */ (scene)] : {});
      servers.set(scene, server);
    }
    return server;
  };
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
  );
  await mkdir(outDir, { recursive: true });
  /** @type {Record<string, Metric>} */
  const metrics = {};
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
          if ((screen.desktopOnly || WORKFLOW_DESIGNER.includes(screen.id)) && vp.isMobile)
            continue;
          const name = `${screen.id}-${vp.w}x${vp.h}-${theme}`;
          try {
            // A hash-only change wouldn't reload, so every shot starts from a blank page.
            await page.goto('about:blank');
            const server = await serverFor(screen.scene ?? '');
            await page.goto(`${server.url}${screen.path}`, { waitUntil: 'networkidle' });
            // A shot's state (collapsed columns, the open tab) is kept in localStorage: start clean.
            if (await page.evaluate(() => window.localStorage.length > 0)) {
              await page.evaluate(() => window.localStorage.clear());
              await page.reload({ waitUntil: 'networkidle' });
            }
            // The first load of a cold Vite server can go idle before React has rendered.
            await page.locator('#root > *').first().waitFor();
            await page.waitForTimeout(400);
            await screen.act?.(page);
            await page.waitForTimeout(300);
            await page.screenshot({
              path: join(outDir, `${name}.png`),
              fullPage: screen.fullPage ?? false,
            });
            metrics[name] = await page.evaluate(measure, vp.w);
            console.log(`ok   ${name}`);
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
    for (const server of servers.values()) server.stop();
  }
  await writeFile(join(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
