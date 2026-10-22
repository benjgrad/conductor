import { describe, expect, it } from 'vitest';
import { daemonHealth } from './index.js';

describe('@conductor/daemon scaffold', () => {
  it('resolves @conductor/shared across the workspace', () => {
    expect(daemonHealth()).toEqual({ package: '@conductor/daemon', ok: true });
  });
});
