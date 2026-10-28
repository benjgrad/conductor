// @ts-check
// vitest globalSetup (vitest.config.ts): hold a machine-wide test slot for the whole run (M2-T31,
// scripts/test-slot.js). Watch mode holds none: it would keep a slot for as long as it is open.
import { acquireSlot, slotLabel, slotOptionsFromEnv } from './test-slot.js';

/** @param {{ config: { watch: boolean } }} project */
export default async function setup(project) {
  if (project.config.watch) return;
  return acquireSlot(slotOptionsFromEnv(process.env, slotLabel('vitest')));
}
