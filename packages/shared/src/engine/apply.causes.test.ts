import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ADR-0037 P7 acceptance: every `enter()` / `enterStep()` call in apply.ts passes a record, so every
// `state_entered` carries a cause. The type checker already refuses a call without one
// (`EnterOpts.record` is required); this reads the source so the guarantee can't be loosened by
// making it optional again. Reading a file is the boundary under test here, not a real process.

const SOURCE = readFileSync(new URL('./apply.ts', import.meta.url), 'utf8');

/** Each `<name>(st, …)` call's argument text, up to its balanced closing paren. */
function calls(name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(\\s*st\\s*,`, 'g');
  for (let m = re.exec(SOURCE); m !== null; m = re.exec(SOURCE)) {
    let depth = 0;
    let i = m.index + name.length;
    for (; i < SOURCE.length; i++) {
      if (SOURCE[i] === '(') depth++;
      else if (SOURCE[i] === ')' && --depth === 0) break;
    }
    out.push(SOURCE.slice(m.index, i + 1));
  }
  return out;
}

describe('every entry records a cause (ADR-0037 P7)', () => {
  it('every enter(st, …) passes a record', () => {
    const found = calls('enter');
    // Guard against a vacuous pass (the regex matching nothing).
    expect(found.length).toBeGreaterThanOrEqual(15);
    for (const c of found) expect(c, c).toMatch(/\brecord\b/);
  });

  it('every enterStep(st, …) passes a record', () => {
    const found = calls('enterStep');
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const c of found) expect(c, c).toMatch(/\brecord\b/);
  });

  it('enter, toFallbackHuman and stepFail require one', () => {
    expect(SOURCE).toMatch(/^ {2}record: MoveFields;$/m);
    expect(SOURCE).toMatch(/function toFallbackHuman\([^)]*record: MoveFields,/s);
    expect(SOURCE).toMatch(/function stepFail\([^)]*cause: MoveCause,/s);
  });
});
