import { describe, expect, it } from 'vitest';
import { stillNeeded } from './missing.js';

describe('stillNeeded', () => {
  it('lists the missing labels in order', () => {
    expect(
      stillNeeded([
        [true, 'your name'],
        [false, 'an email'],
        [true, 'a password'],
      ]),
    ).toBe('Still needed: your name, a password');
  });

  it('is null when nothing is missing', () => {
    expect(stillNeeded([[false, 'a password']])).toBeNull();
    expect(stillNeeded([])).toBeNull();
  });
});
