// MR-T01 FR-3 process tree: parent → child → grandchild, where the grandchild detaches and the
// child then exits, so the grandchild is reparented (the TD-189 case `taskkill /T` misses).
// Usage: node tree.mjs <parent|child|grandchild> <pidDir>
// Each role writes <pidDir>/<role>.pid; the parent writes <pidDir>/child.exited when the child is
// gone. Everyone but the child lives until killed.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [role, dir] = process.argv.slice(2);
if (!role || !dir) {
  process.stderr.write('usage: node tree.mjs <parent|child|grandchild> <pidDir>\n');
  process.exit(2);
}
const self = fileURLToPath(import.meta.url);
writeFileSync(join(dir, `${role}.pid`), String(process.pid));
const forever = () => setInterval(() => {}, 60_000);

if (role === 'parent') {
  const child = spawn(process.execPath, [self, 'child', dir], { stdio: 'ignore', windowsHide: true });
  child.on('exit', () => writeFileSync(join(dir, 'child.exited'), '1'));
  forever();
} else if (role === 'child') {
  // POSIX: setsid (a new process group and session); win32: DETACHED_PROCESS. Neither leaves a
  // Job Object: Node never asks for CREATE_BREAKAWAY_FROM_JOB.
  const gc = spawn(process.execPath, [self, 'grandchild', dir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  gc.unref();
  // The grandchild exists once spawn() returns; exit so it is reparented while alive.
  setTimeout(() => process.exit(0), 300);
} else if (role === 'grandchild') {
  forever();
} else {
  process.stderr.write(`unknown role ${role}\n`);
  process.exit(2);
}
