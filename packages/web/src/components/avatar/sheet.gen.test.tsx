// The avatar contact sheet, for reviewing the art (not a test: skipped unless AVATAR_SHEET is
// set). Writes tmp/avatars/sheet.html at the repo root; scripts/avatar-sheet.js renders it and
// screenshots it to a PNG.
//
//   AVATAR_SHEET=1 pnpm vitest run --project web src/components/avatar/sheet.gen.test.tsx
import { AGENT_NAMES } from '@conductor/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'vitest';
import { AgentAvatar } from './Avatar.js';
import { SPECIES } from './traits.js';

const run = process.env.AVATAR_SHEET ? it : it.skip;

run('writes the avatar contact sheet', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const out = join(root, 'tmp/avatars/sheet.html');
  const names = AGENT_NAMES.slice(0, 48);
  const cell = (seed: string, label: string, species?: (typeof SPECIES)[number]) => {
    const o = species ? { species } : undefined;
    return `<figure>${renderToStaticMarkup(<AgentAvatar seed={seed} size={96} {...(o ? { overrides: o } : {})} />)}${renderToStaticMarkup(<AgentAvatar seed={seed} size={24} {...(o ? { overrides: o } : {})} />)}<figcaption>${label}</figcaption></figure>`;
  };
  const cells = [
    ...names.map((n) => cell(n, n)),
    ...SPECIES.filter((s) => s !== 'human').map((s, i) => cell(`sheet-${s}-${i}`, s, s)),
  ];
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:12px;font:11px system-ui;background:#fff;display:grid;grid-template-columns:repeat(10,104px);gap:8px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px}
figcaption{color:#555}
</style>${cells.join('')}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
});
