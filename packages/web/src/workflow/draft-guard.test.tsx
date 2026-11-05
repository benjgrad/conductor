// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '../nav.js';
import { DiscardDraftConfirm, type DraftGuard } from './draft-guard.js';

afterEach(cleanup);

const SHOP: Route = { view: 'repo-checks', repo: 'github.com/acme/shop' };

function guard(over: Partial<DraftGuard>): DraftGuard {
  return {
    guard: () => 'allow',
    onBlocked: vi.fn(),
    setDirty: vi.fn(),
    dirty: null,
    pending: null,
    cancel: vi.fn(),
    ...over,
  };
}

describe('DiscardDraftConfirm', () => {
  it('asks while the blocked navigation would drop a draft', () => {
    const navigate = vi.fn();
    render(
      <DiscardDraftConfirm
        draft={guard({ pending: SHOP, dirty: { kind: 'repo-checks', repo: 'github.com/o/x' } })}
        navigate={navigate}
      />,
    );
    expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('goes on when the draft turned clean after the click was blocked (a save racing it)', () => {
    const navigate = vi.fn();
    const draft = guard({ pending: SHOP, dirty: null });
    render(<DiscardDraftConfirm draft={draft} navigate={navigate} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(draft.cancel).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(SHOP, { force: true });
  });
});
