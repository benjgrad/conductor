#!/usr/bin/env node
// Avatar contact sheet: renders tmp/avatars/sheet.html (written by the gated
// packages/web/src/components/avatar/sheet.gen.test.tsx) and screenshots it to
// tmp/avatars/sheet.png with Chrome through playwright-core. Dev only, not run in CI.
//
//   AVATAR_SHEET=1 pnpm vitest run --project web src/components/avatar/sheet.gen.test.tsx
//   node scripts/avatar-sheet.js [--out tmp/avatars/sheet.png]
//
// Chrome: CHROME_PATH, else playwright's `chrome` channel (an installed Google Chrome).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--out');
const out = resolve(root, (i >= 0 ? args[i + 1] : undefined) ?? 'tmp/avatars/sheet.png');
const html = join(root, 'tmp/avatars/sheet.html');

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
try {
  const page = await browser.newPage({ viewport: { width: 1160, height: 800 } });
  await page.goto(pathToFileURL(html).href);
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
} finally {
  await browser.close();
}
