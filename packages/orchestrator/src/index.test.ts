import { describe, expect, it } from 'vitest';
import { orchestratorHealth } from './index.js';

describe('@conductor/orchestrator scaffold', () => {
  it('resolves @conductor/shared across the workspace', () => {
    expect(orchestratorHealth()).toEqual({ package: '@conductor/orchestrator', ok: true });
  });
});
