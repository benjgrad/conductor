import { describe, expect, it } from 'vitest';
import { health, HealthSchema, PACKAGE_NAME } from './index.js';

describe('@conductor/shared scaffold', () => {
  it('builds a schema-valid health record', () => {
    const h = health(PACKAGE_NAME);
    expect(HealthSchema.safeParse(h).success).toBe(true);
    expect(h).toEqual({ package: '@conductor/shared', ok: true });
  });
});
