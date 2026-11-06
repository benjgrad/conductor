// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BasePreview, BasePreviewContext, previewBaseOf, type PreviewBase } from './BasePreview.js';

// ADR-0039 (B3, FR-4): `$base` rendered with the workflow's current default.

afterEach(cleanup);

const show = (text: string, base: PreviewBase | null) =>
  render(
    <BasePreviewContext.Provider value={base}>
      <BasePreview text={text} />
    </BasePreviewContext.Provider>,
  );

describe('BasePreview (ADR-0039, B3)', () => {
  it('previews with the work default, else the personal one, else the first base', () => {
    const bases = { a: { ref: 'main' }, sprint: { cmd: 'x' } };
    expect(previewBaseOf({ bases, base_default: { work: 'sprint', personal: 'a' } })).toEqual({
      name: 'sprint',
      kind: 'work',
    });
    expect(previewBaseOf({ bases, base_default: { personal: 'a' } })).toEqual({
      name: 'a',
      kind: 'personal',
    });
    expect(previewBaseOf({ bases })).toEqual({ name: 'a', kind: null });
    expect(previewBaseOf({})).toBeNull();
  });

  it('renders `$base` and `$base_sha`, and leaves `${base}` alone', () => {
    const { container } = show('git merge origin/$base # $base_sha, not ${base}', {
      name: 'sprint',
      kind: 'work',
    });
    expect(container.textContent).toBe(
      'With the work default (sprint): git merge origin/sprint # <sprint commit>, not ${base}',
    );
  });

  it('nothing without a $base, or without bases', () => {
    show('npm test', { name: 'sprint', kind: 'work' });
    show('git merge origin/$base', null);
    expect(screen.queryByText(/With the/)).toBeNull();
  });
});
