// @vitest-environment jsdom
import { CONDUCTOR_V2_DEF } from '@conductor/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { repoOverridesText, shortRepo } from './RepoOverridesHint.js';
import { TransitionEditor, type TransitionEditorProps } from './TransitionEditor.js';

// UXR-75: the transition editor names the repos whose own checks replace the transition's.

afterEach(cleanup);

const noop = () => undefined;
const props = (over: Partial<TransitionEditorProps>): TransitionEditorProps => ({
  definition: CONDUCTOR_V2_DEF,
  from: 'implementing',
  name: 'ready_for_testing',
  issues: [],
  onChange: noop,
  onSelect: noop,
  onRemoved: noop,
  onSelectColumn: noop,
  onSelectArrow: noop,
  onBack: noop,
  onClose: noop,
  ...over,
});
const note = () =>
  screen.queryAllByRole('note').find((n) => /use(s)? (its|their) own checks/.test(n.textContent));

describe('TransitionEditor: repo overrides under Checks (UXR-75)', () => {
  it('names an override and links to its Repo checks page', () => {
    render(<TransitionEditor {...props({ repoOverrides: ['github.com/acme/shop'] })} />);
    const n = note()!;
    expect(n.textContent).toBe('1 repo uses its own checks instead: acme/shop ›');
    const link = within(n).getByRole('link', { name: 'acme/shop ›' });
    expect(link.getAttribute('href')).toBe('#/repo-checks/github.com%2Facme%2Fshop');
  });

  it('more than three: three named (sorted), the rest a link to the list', () => {
    const repos = ['github.com/o/d', 'github.com/o/a', 'github.com/o/c', 'github.com/o/b'];
    render(<TransitionEditor {...props({ repoOverrides: repos })} />);
    const n = note()!;
    expect(n.textContent).toBe(
      '4 repos use their own checks instead: o/a ›, o/b ›, o/c ›, +1 more',
    );
    expect(within(n).getByRole('link', { name: '+1 more' }).getAttribute('href')).toBe(
      '#/repo-checks',
    );
  });

  it('hidden with no overrides', () => {
    render(<TransitionEditor {...props({ repoOverrides: [] })} />);
    expect(note()).toBeUndefined();
    cleanup();
    render(<TransitionEditor {...props({})} />);
    expect(note()).toBeUndefined();
  });

  it('hidden on a transition without checks: an override replaces only a list of checks', () => {
    render(
      <TransitionEditor
        {...props({ from: 'planning', name: 'plan_ready', repoOverrides: ['github.com/a/b'] })}
      />,
    );
    expect(note()).toBeUndefined();
  });
});

describe('shortRepo / repoOverridesText', () => {
  it('drops a leading host only', () => {
    expect(shortRepo('github.com/acme/shop')).toBe('acme/shop');
    expect(shortRepo('acme/shop')).toBe('acme/shop');
    expect(shortRepo('shop')).toBe('shop');
  });
  it('counts', () => {
    expect(repoOverridesText(1)).toBe('1 repo uses its own checks instead:');
    expect(repoOverridesText(2)).toBe('2 repos use their own checks instead:');
  });
});
