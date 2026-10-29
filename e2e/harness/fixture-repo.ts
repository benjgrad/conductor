// The fixture repo (M1-T10): a local git repo whose `npm run build` / `npm test` pass, unless a
// counter file in the worktree says to fail. `.e2e/<step>-fail` holds N: the step prints
// FAILURE_MARKER, decrements N and exits 1 while N > 0. The fake Claude writes the counter
// (`write_file`) in its first turn, so each ticket's session (own worktree) scripts its own
// failures and the counters survive across retries of that session.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAILURE_MARKER = 'e2e-fixture: failing on purpose';

/** Path (relative to the worktree) of the counter for `step` ('build' | 'test'). */
export const failCounter = (step: 'build' | 'test') => `.e2e/${step}-fail`;

const STEP_SCRIPT = `// e2e fixture: node scripts/step.mjs <build|test>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const step = process.argv[2];
// ADR-0010 entry checks: a committed \`fail-<step>\` fails the step, unless \`.e2e/override-<step>\`
// (gitignored, so never committed) exists: it only helps where the worktree's own files are seen.
if (existsSync(\`fail-\${step}\`) && !existsSync(\`.e2e/override-\${step}\`)) {
  console.error(\`${FAILURE_MARKER} (\${step}, fail-\${step} is committed)\`);
  process.exit(1);
}
const counter = \`.e2e/\${step}-fail\`;
const left = existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) || 0 : 0;
if (left > 0) {
  writeFileSync(counter, String(left - 1));
  console.log(\`\${step}: compiling...\`);
  console.error(\`${FAILURE_MARKER} (\${step}, \${left - 1} more failures scripted)\`);
  process.exit(1);
}
console.log(\`\${step}: ok\`);
`;

// M2-T30: the pnpm fixture's build/test fail unless pnpm runs them (`npm_config_user_agent`) in a
// checkout where `pnpm install --frozen-lockfile` ran, so a pass proves the daemon followed the
// lockfile. With no dependencies pnpm 10 writes only node_modules/.pnpm-workspace-state*.json, and
// later versions also .modules.yaml: either counts.
const PNPM_STEP_SCRIPT = `// e2e pnpm fixture: node scripts/step.mjs <build|test>
import { existsSync, readdirSync } from 'node:fs';

const step = process.argv[2];
const agent = process.env.npm_config_user_agent ?? '';
if (!agent.startsWith('pnpm/')) {
  console.error(\`${FAILURE_MARKER} (\${step} ran under "\${agent}", not pnpm)\`);
  process.exit(1);
}
const installed =
  existsSync('node_modules/.modules.yaml') ||
  (existsSync('node_modules') &&
    readdirSync('node_modules').some((f) => f.startsWith('.pnpm-workspace-state')));
if (!installed) {
  console.error(\`${FAILURE_MARKER} (\${step}: pnpm install did not run)\`);
  process.exit(1);
}
console.log(\`\${step}: ok (pnpm)\`);
`;

/** The lockfile pnpm 9+ writes for a package with no dependencies. */
const EMPTY_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`;

/**
 * M2-T30: a pnpm repo (pnpm-lock.yaml, no dependencies) at `dir` whose `build` / `test` pass only
 * when pnpm installed and runs them. Returns its path.
 */
export function createPnpmFixtureRepo(dir: string): string {
  return createFixtureRepo(dir, { 'pnpm-lock.yaml': EMPTY_PNPM_LOCK }, PNPM_STEP_SCRIPT);
}

/** Create the fixture repo at `dir` (git, branch main, one commit). Returns its path. */
export function createFixtureRepo(
  dir: string,
  extraFiles: Record<string, string> = {},
  stepScript = STEP_SCRIPT,
): string {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'conductor-e2e-fixture',
        version: '0.0.0',
        private: true,
        scripts: { build: 'node scripts/step.mjs build', test: 'node scripts/step.mjs test' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(dir, 'scripts', 'step.mjs'), stepScript);
  for (const [f, content] of Object.entries(extraFiles)) writeFileSync(join(dir, f), content);
  writeFileSync(join(dir, '.gitignore'), '.e2e/\nnode_modules/\n');
  writeFileSync(join(dir, 'README.md'), '# conductor E2E fixture\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'e2e@localhost');
  git('config', 'user.name', 'conductor-e2e');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  return dir;
}
