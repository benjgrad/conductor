import { describe, expect, it } from 'vitest';
import { usd } from './format';

describe('usd', () => {
  it('rounds to cents but never shows non-zero spend as $0.00 (TD-080)', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.0023)).toBe('<$0.01');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(1.234)).toBe('$1.23');
  });
});
