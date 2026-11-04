import { AGENT_NAMES } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { colorDistance } from './color.js';
import {
  avatarTraits,
  BUILDS,
  EXPRESSIONS,
  EYE_SHAPES,
  HAIR_STYLES,
  HEADWEAR,
  HEIGHTS,
  NOSE_SHAPES,
  OUTFITS,
  SPECIES,
  type AvatarTraits,
} from './traits.js';

const synthetic = Array.from({ length: 500 }, (_, i) => `seed-${i}`);
const seeds = [...AGENT_NAMES, ...synthetic];
const all = seeds.map((s) => avatarTraits(s));
const humans = all.filter((t) => t.species === 'human');
const values = <K extends keyof AvatarTraits>(list: AvatarTraits[], k: K) =>
  new Set(list.map((t) => t[k]));

describe('avatarTraits', () => {
  it('is deterministic per seed', () => {
    for (const n of AGENT_NAMES) expect(avatarTraits(n)).toEqual(avatarTraits(n));
  });

  it('covers every value of every axis', () => {
    expect(values(all, 'species')).toEqual(new Set(SPECIES));
    expect(values(all, 'expression')).toEqual(new Set(EXPRESSIONS));
    expect(values(all, 'eyes')).toEqual(new Set(EYE_SHAPES));
    expect(values(all, 'outfit')).toEqual(new Set(OUTFITS));
    expect(values(all, 'build')).toEqual(new Set(BUILDS));
    expect(values(all, 'height')).toEqual(new Set(HEIGHTS));
    expect(values(humans, 'nose')).toEqual(new Set(NOSE_SHAPES));
    expect(values(humans, 'hair')).toEqual(new Set(HAIR_STYLES));
    expect(values(all, 'gender').size).toBe(3);
  });

  it('is mostly people, with a real share of other species', () => {
    const share = humans.length / all.length;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.75);
  });

  it('varies expressions even among the first few teammates', () => {
    const first = AGENT_NAMES.slice(0, 60).map((n) => avatarTraits(n).expression);
    expect(new Set(first).size).toBeGreaterThanOrEqual(6);
  });

  it('gives nearly every seed its own character', () => {
    const distinct = new Set(synthetic.map((s) => JSON.stringify(avatarTraits(s))));
    expect(distinct.size / synthetic.length).toBeGreaterThanOrEqual(0.95);
  });

  it('draws valid colours, and the outfit stands out from the background', () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const t of all) {
      for (const c of [t.background, t.skin, t.hairColor, t.outfitColor, t.outfitAccent]) {
        expect(c).toMatch(hex);
      }
      expect(colorDistance(t.outfitColor, t.background)).toBeGreaterThanOrEqual(120);
      expect(colorDistance(t.outfitAccent, t.outfitColor)).toBeGreaterThanOrEqual(110);
    }
  });

  it('keeps human-only traits on humans', () => {
    for (const t of all.filter((x) => x.species !== 'human')) {
      expect(t.hair).toBe('none');
      expect(t.facialHair).toBe('none');
      expect(t.nose).toBe('none');
      expect(t.earrings).toBe(false);
      expect(t.headAccessory).toBe('none');
    }
    for (const t of humans) {
      expect(t.hair).not.toBe('none');
      if (HEADWEAR.includes(t.hair as (typeof HAIR_STYLES)[number])) {
        expect(t.headAccessory).toBe('none');
      }
      if (t.hair === 'headscarf') expect(t.earrings).toBe(false);
      if (t.gender === 'fem') expect(t.facialHair).toBe('none');
    }
  });

  it('a species override keeps every other drawn axis in place', () => {
    const base = avatarTraits('Morgan');
    const fox = avatarTraits('Morgan', { species: 'fox' });
    expect(fox.species).toBe('fox');
    expect(fox.expression).toBe(base.expression);
    expect(fox.background).toBe(base.background);
    expect(fox.outfit).toBe(base.outfit);
    expect(fox.hair).toBe('none');
  });
});
