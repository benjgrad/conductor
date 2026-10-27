import { rmSync } from 'node:fs';

/**
 * Remove a test's temp tree while a daemon's background `git` may still be writing into it.
 * TD-111: `Daemon.startSession` fires `sendInventory` without awaiting it, and its `git status`
 * rewrites the shared clone's `.git/index` after `stop()` returns. `rmSync`'s own `maxRetries`
 * only retries the final `rmdir`, never re-deleting a file written after its first pass, so we
 * call `rmSync` again from the top until the tree is gone (about 4 s at most).
 */
export async function removeTree(path: string, attempts = 40, delayMs = 100): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
