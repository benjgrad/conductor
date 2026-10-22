// Zero-cost gate for the spike: syntax-check every script, then run the
// driver contract against the fake (no API calls).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { HERE } from './lib.mjs';

for (const f of readdirSync(HERE).filter((f) => f.endsWith('.mjs'))) {
  execFileSync(process.execPath, ['--check', f], { cwd: HERE, stdio: 'inherit' });
  console.log('syntax ok', f);
}
const out = execFileSync(process.execPath, ['f-driver-contract.mjs', 'fake'], { cwd: HERE, timeout: 60_000 }).toString();
if (!/LIVE OK/.test(out) || !/RESUME OK: \{"sameId":true/.test(out)) {
  console.error(out); throw new Error('fake driver contract failed');
}
console.log('fake driver contract ok');
