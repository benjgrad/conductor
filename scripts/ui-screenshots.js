#!/usr/bin/env node
// UI review screenshots (docs/qa/ux-review/). Starts the web app on the still mock API
// (VITE_API=mock, VITE_MOCK_STATIC=1), drives it with Chrome through playwright-core, and writes
// docs/qa/ux-review/<out>/<screen>-<w>x<h>-<theme>.png plus metrics.json (page overflow and the
// visible tap targets under 44 px, per shot). Not run in CI.
//
//   node scripts/ui-screenshots.js [--out before|after] [--url http://localhost:5173] [--only board,detail]
//
// Chrome: CHROME_PATH, else playwright's `chrome` channel (an installed Google Chrome).
/// <reference lib="dom" />
/* global document, window -- page.evaluate callbacks run in the browser */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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

/**
 * @typedef {import('playwright-core').Page} Page
 * @typedef {import('playwright-core').Locator} Locator
 * @typedef {{ w: number, h: number, deviceScaleFactor: number, isMobile?: boolean,
 *   hasTouch?: boolean, themes: Partial<Record<'light' | 'dark', 'all' | string[]>> }} Viewport
 * @typedef {{ id: string, path: string, act?: (page: Page) => Promise<void> }} Screen
 * @typedef {ReturnType<typeof measure> | { error: string }} Metric
 */

const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
/** @type {Viewport[]} */
const VIEWPORTS = [
  {
    w: 375,
    h: 812,
    ...PHONE,
    themes: { light: 'all', dark: ['board', 'detail', 'new-ticket'] },
  },
  {
    w: 360,
    h: 740,
    ...PHONE,
    themes: { light: ['board', 'detail', 'detail-scrolled', 'new-ticket', 'new-ticket-bottom'] },
  },
  {
    w: 768,
    h: 1024,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    themes: { light: ['board', 'detail', 'new-ticket'] },
  },
  {
    w: 1440,
    h: 900,
    deviceScaleFactor: 1,
    themes: {
      light: ['board', 'detail', 'new-ticket', 'machines', 'workflows'],
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

/** @param {Page} page */
async function openCard(page) {
  await tap(page.locator('.card-open', { hasText: CARD }).first());
  await page.locator('aside.detail').waitFor();
  await page.waitForTimeout(300);
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
  { id: 'machines', path: '/#/machines' },
  { id: 'workflows', path: '/#/workflows' },
  { id: 'setup', path: '/#/setup' },
  { id: 'help', path: '/help/add-a-machine' },
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
  return {
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

async function startVite() {
  const port = await freePort();
  const child = spawn(
    'pnpm',
    ['--filter', '@conductor/web', 'exec', 'vite', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      env: { ...process.env, VITE_API: 'mock', VITE_MOCK_STATIC: '1' },
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
          const name = `${screen.id}-${vp.w}x${vp.h}-${theme}`;
          try {
            // A hash-only change wouldn't reload, so every shot starts from a blank page.
            await page.goto('about:blank');
            await page.goto(`${server.url}${screen.path}`, { waitUntil: 'networkidle' });
            await page.waitForTimeout(400);
            await screen.act?.(page);
            await page.waitForTimeout(300);
            await page.screenshot({ path: join(outDir, `${name}.png`) });
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
    server.stop();
  }
  await writeFile(join(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
