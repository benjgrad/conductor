// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentAvatar } from './Avatar.js';
import { EXPRESSIONS, HAIR_STYLES, OUTFITS, SPECIES } from './traits.js';

const draw = (props: Parameters<typeof AgentAvatar>[0]) => {
  const { container, unmount } = render(<AgentAvatar {...props} />);
  const svg = container.querySelector('svg')!;
  const html = svg.outerHTML;
  unmount();
  return { svg, html };
};

describe('AgentAvatar', () => {
  it.each(SPECIES)('draws a %s', (species) => {
    const { svg, html } = draw({ seed: 'Morgan', size: 24, overrides: { species } });
    expect(svg.getAttribute('data-species')).toBe(species);
    expect(svg.getAttribute('data-expression')).toBeTruthy();
    const hair = svg.getAttribute('data-hair');
    if (species === 'human') expect(HAIR_STYLES).toContain(hair);
    else expect(hair).toBe('none');
    expect(svg.querySelectorAll('ellipse, circle, path, rect').length).toBeGreaterThanOrEqual(8);
    expect(html).not.toContain('NaN');
  });

  it('draws every hair style, expression and outfit without broken geometry', () => {
    const cases = [
      ...HAIR_STYLES.map((hair) => ({ species: 'human' as const, hair })),
      ...EXPRESSIONS.map((expression) => ({ expression })),
      ...OUTFITS.map((outfit) => ({ outfit })),
      { height: 'short' as const, build: 'round' as const, tilt: 7 },
      { height: 'tall' as const, build: 'slim' as const, tilt: -7 },
    ];
    for (const overrides of cases) {
      const { html } = draw({ seed: 'Siti', overrides });
      expect(html).not.toContain('NaN');
      expect(html).not.toContain('undefined');
    }
  });

  it('keeps the drawing small enough for a board full of cards', () => {
    for (const seed of ['Morgan', 'Siti', 'Ada', 'Kofi', 'Priya']) {
      const { svg } = draw({ seed });
      expect(svg.querySelectorAll('*').length).toBeLessThan(90);
    }
  });

  it('labels the image when given a title', () => {
    const { svg } = draw({ seed: 'Morgan', title: "Morgan's avatar" });
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe("Morgan's avatar");
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });
});
