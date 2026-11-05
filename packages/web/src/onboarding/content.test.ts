import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import guide from '../help/add-a-machine.md?raw';
import { guessOs, PREREQUISITES, SIGHUP_COMMAND, type Os } from './content.js';

// UX-8b: every command the setup guide and the help page show works as shown.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const MARKDOWN = {
  help: guide,
  docs: readFileSync(resolve(ROOT, 'docs/setup/add-a-machine.md'), 'utf8'),
};
const CONTENT_SOURCE = readFileSync(resolve(HERE, 'content.ts'), 'utf8');
const DAEMON_PATTERN = '/.conductor/daemon/current/dist/main.js';

describe('rescan command (FR-1)', () => {
  it('never uses pgrep -f conductor-daemon', () => {
    expect(CONTENT_SOURCE).not.toContain('pgrep');
    for (const text of Object.values(MARKDOWN)) {
      expect(text).not.toContain('pgrep');
      expect(text).not.toContain('kill -HUP $(');
    }
  });

  it('signals only the daemon process', () => {
    expect(SIGHUP_COMMAND).toBe(`pkill -HUP -f "$HOME${DAEMON_PATTERN}"`);
  });

  it.each(Object.entries(MARKDOWN))('the %s markdown lists restart first', (_, text) => {
    const section = text.slice(text.indexOf('## 4.'), text.indexOf('## 5.'));
    const restart = section.indexOf('press Ctrl-C in its terminal, then start it again');
    expect(restart).toBeGreaterThan(-1);
    expect(section.indexOf(SIGHUP_COMMAND)).toBeGreaterThan(restart);
  });
});

// UXR-49: the prerequisites match what install.sh and install.ps1 check today. The daemon is a
// native binary (ADR-0026), so Node.js is not one of them.
describe('prerequisites match the installers (UXR-49)', () => {
  const INSTALL_SH = readFileSync(
    resolve(ROOT, 'packages/orchestrator/assets/install.sh.tmpl'),
    'utf8',
  );
  const INSTALL_PS1 = readFileSync(
    resolve(ROOT, 'packages/orchestrator/assets/install.ps1.tmpl'),
    'utf8',
  );

  it('the installers need no Node', () => {
    for (const script of [INSTALL_SH, INSTALL_PS1]) {
      expect(script).toMatch(/needs\s+(#\s+)?no\s+(#\s+)?Node/);
      expect(script).not.toMatch(/command -v node|Get-Command node/);
    }
  });

  it('every tool install.sh requires has a prerequisite', () => {
    const ids = new Set(PREREQUISITES.map((p) => p.id));
    const required = [...INSTALL_SH.matchAll(/command -v (\w+) >\/dev\/null 2>&1 \|\| need/g)].map(
      (m) => m[1]!,
    );
    // tar (and curl or wget, shasum) ship with macOS and Linux: the guide doesn't list them.
    expect(required).toEqual(['git', 'claude', 'tar']);
    for (const tool of required.filter((t) => t !== 'tar')) {
      expect(ids.has(tool), tool).toBe(true);
    }
  });

  it('no step installs or checks Node.js', () => {
    expect(PREREQUISITES.map((p) => p.id)).not.toContain('node');
    const commands = PREREQUISITES.flatMap((p) => [
      ...Object.values(p.install).flat(),
      ...p.verify,
    ]).map((c) => c.command);
    for (const c of commands) expect(c).not.toMatch(/\bnode\b|nvm|npm /);
    for (const text of Object.values(MARKDOWN)) {
      expect(text).not.toMatch(/Node\.js 22|node -v|nvm/);
      expect(text).toContain('You need four things');
    }
  });

  it.each<Os>(['macos', 'linux'])('%s installs Claude Code natively, not with npm', (os) => {
    const claude = PREREQUISITES.find((p) => p.id === 'claude')!.install[os];
    expect(claude[0]!.command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });
});

describe('guessOs (MW-T11)', () => {
  it.each([
    ['Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Darwin', 'macos'],
    ['Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Linux armv8l', 'Mozilla/5.0 (Linux; Android 14)', 'macos'],
  ])('%s / %s → %s', (platform, userAgent, os) => {
    vi.stubGlobal('navigator', { platform, userAgent });
    try {
      expect(guessOs()).toBe(os);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
