import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import guide from '../help/add-a-machine.md?raw';
import { PREREQUISITES, SIGHUP_COMMAND, type Os } from './content.js';

// UX-8b: every command the setup guide and the help page show works as shown.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const MARKDOWN = {
  help: guide,
  docs: readFileSync(resolve(ROOT, 'docs/setup/add-a-machine.md'), 'utf8'),
};
const CONTENT_SOURCE = readFileSync(resolve(HERE, 'content.ts'), 'utf8');
const DAEMON_PATTERN = '/.conductor/daemon/current/dist/main.js';

const nodeInstall = (os: Os) =>
  PREREQUISITES.find((p) => p.id === 'node')!.install[os].map((c) => c.command);

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

describe('Node.js install (FR-2, FR-3)', () => {
  it('macOS uses the linked Homebrew node, not the keg-only node@22', () => {
    expect(nodeInstall('macos')[0]).toBe('brew install node');
    expect(CONTENT_SOURCE).not.toMatch(/brew install node@/);
    for (const text of Object.values(MARKDOWN)) {
      expect(text).toContain('`brew install node`');
      expect(text).not.toContain('node@22');
    }
  });

  it.each<Os>(['macos', 'linux'])('%s loads nvm before nvm install 22', (os) => {
    const commands = nodeInstall(os);
    const curl = commands.findIndex((c) => c.includes('nvm-sh/nvm'));
    const load = commands.indexOf('. ~/.nvm/nvm.sh');
    expect(curl).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(curl);
    expect(commands.indexOf('nvm install 22')).toBeGreaterThan(load);
  });

  it.each(Object.entries(MARKDOWN))('the %s markdown says to open a new terminal', (_, text) => {
    const bullets = text.split('\n').filter((l) => l.includes('`nvm install 22`'));
    expect(bullets).toHaveLength(2); // macOS and Linux
    for (const line of bullets) {
      const install = line.indexOf('`nvm install 22`');
      expect(line.indexOf('open a new terminal')).toBeGreaterThan(line.indexOf('nvm-sh/nvm'));
      expect(line.indexOf('`. ~/.nvm/nvm.sh`')).toBeGreaterThan(-1);
      expect(line.indexOf('`. ~/.nvm/nvm.sh`')).toBeLessThan(install);
    }
  });
});
