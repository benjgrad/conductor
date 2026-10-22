import type { CreateCommandRunner } from './runner.js';

// Placeholder (M1-T12). M1-T06 replaces the body with the real runner (sh -c, timeout, build
// semaphore, output tail); the export name and signature are the contract T05 wires against.
export const createCommandRunner: CreateCommandRunner = () => {
  throw new Error('not implemented (M1-T06)');
};
