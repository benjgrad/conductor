import type { CreateCommandRunner } from './runner.js';
import { ProcessCommandRunner } from './process-runner.js';

export { ProcessCommandRunner, type ProcessCommandRunnerOptions } from './process-runner.js';

// M1-T06: the real runner (sh -c in its own process group, timeout, build semaphore, output tail).
// The export name and signature are the contract T05 wires against (10-contracts §Seams).
export const createCommandRunner: CreateCommandRunner = ({ maxConcurrent }) =>
  new ProcessCommandRunner({ maxConcurrent });
