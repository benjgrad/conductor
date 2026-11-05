// UXR-56 / UXR-58: the focus ring is a CSS rule, which jsdom can't render; this reads the
// stylesheets as text, so a later edit can't quietly drop the ring or bring back `outline: none`.
// (Vite's `?raw` returns '' here: vitest's CSS handling empties stylesheets.)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const styles = css('./styles.css');
const onboarding = css('./onboarding/onboarding.css');
const workflow = css('./workflow/workflow.css');

describe('focus styles', () => {
  it('styles.css draws one global :focus-visible ring', () => {
    const rule = /^:focus-visible \{([^}]*)\}/m.exec(styles);
    expect(rule?.[1]).toContain('outline: 2px solid var(--accent)');
    expect(rule?.[1]).toContain('outline-offset: 2px');
  });

  it('the workflow and onboarding styles no longer turn the outline off', () => {
    expect(onboarding).not.toContain('outline: none');
    expect(workflow).not.toContain('outline: none');
  });

  it('the diagram draws focus apart from selection', () => {
    expect(workflow).toContain('.wf-lane:focus-visible .wf-focus-ring');
    expect(workflow).toContain('.wf-edge:focus-visible .wf-hit');
    expect(workflow).not.toMatch(/\.wf-lane:focus-visible \.wf-lane-box/);
  });
});
