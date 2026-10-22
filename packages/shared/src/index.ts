import { z } from 'zod';

// Placeholder from M1-T01 (scaffold). M1-T12 replaces this with the real contracts.
export const PACKAGE_NAME = '@conductor/shared';

export const HealthSchema = z.object({
  package: z.string(),
  ok: z.literal(true),
});

export type Health = z.infer<typeof HealthSchema>;

export function health(pkg: string): Health {
  return HealthSchema.parse({ package: pkg, ok: true });
}
