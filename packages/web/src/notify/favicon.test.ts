import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FAVICON_DOT, FAVICON_PLAIN } from './favicon.js';

it("index.html's favicon is the plain mark that the dot swap restores", () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  expect(html).toContain(`href="${FAVICON_PLAIN}"`);
  expect(FAVICON_DOT).not.toBe(FAVICON_PLAIN);
});
