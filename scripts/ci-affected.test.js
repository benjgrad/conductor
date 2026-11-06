// @ts-check
import { describe, expect, it } from 'vitest';
import { e2eAffected, rustAffected } from './ci-affected.js';

describe('rustAffected (clippy + nextest in scripts/ci.sh on a PR)', () => {
  it.each([
    [['crates/conductor-daemon/src/x.rs'], true],
    [['Cargo.lock'], true],
    [['rust-toolchain.toml'], true],
    [['packages/shared/src/protocol/x.ts'], true],
    [['e2e/fixtures/transcript.jsonl'], true],
    [['scripts/ci.sh'], true],
    [['packages/web/src/App.tsx'], false],
    [['docs/design/01.md'], false],
    [['packages/orchestrator/src/x.ts'], false],
  ])('%j → %s', (changed, want) => {
    expect(rustAffected(changed)).toBe(want);
  });

  it('runs when the diff is unknown', () => {
    expect(rustAffected(null)).toBe(true);
  });
});

describe('e2eAffected (the e2e suite in scripts/ci.sh on a PR)', () => {
  it.each([
    [['e2e/harness/stack.ts'], true],
    [['packages/orchestrator/src/x.ts'], true],
    [['e2e/fixtures/fake-claude.mjs'], true],
    [['crates/conductor-daemon/src/main.rs'], true],
    [['docs/design/workflows/pr_flow.v1.json'], true],
    [['package.json'], true],
    [['.github/workflows/ci.yml'], true],
    [['docs/tracking/STATUS.md'], false],
    [['packages/web/src/App.tsx'], false],
    [['deploy/gradyserver/deploy.sh'], false],
    [['README.md', '.github/workflows/daemon-windows.yml'], false],
  ])('%j → %s', (changed, want) => {
    expect(e2eAffected(changed)).toBe(want);
  });

  it('runs when the diff is unknown', () => {
    expect(e2eAffected(null)).toBe(true);
  });
});
