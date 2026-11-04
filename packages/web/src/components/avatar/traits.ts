// Avatar traits: a pure function of a seed (the agent's name, or a legacy ticket id), so a
// teammate has the same face everywhere (UX-13b FR-2). Every axis is drawn from one seeded PRNG
// in a fixed order, and an axis is drawn even when the species doesn't use it, so adding a value
// to one list never reshuffles the others. The style aims at Duolingo's cast (big heads, flat
// shapes, bold expressions), never at any one of its characters.
import { colorDistance } from './color.js';

/** FNV-1a, 32-bit. Stable across platforms (only Math.imul and unsigned shifts). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny seeded PRNG, so each trait draws its own number from one hash. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(list: readonly T[], r: () => number): T =>
  list[Math.floor(r() * list.length)]!;

/** One draw from `[value, weight]` pairs. */
export function weighted<T>(pairs: readonly (readonly [T, number])[], r: () => number): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) {
    x -= w;
    if (x < 0) return v;
  }
  return pairs[pairs.length - 1]![0];
}

/**
 * One draw from `list`, stepping forward to the first colour at least `min` away from every
 * colour in `avoid` (so a shirt never melts into the background). One rng draw either way.
 */
function pickApart(
  list: readonly string[],
  r: () => number,
  avoid: readonly string[],
  min: number,
): string {
  const start = Math.floor(r() * list.length);
  for (let i = 0; i < list.length; i++) {
    const c = list[(start + i) % list.length]!;
    if (avoid.every((a) => colorDistance(a, c) >= min)) return c;
  }
  return list[start]!;
}

// ---- the axes ------------------------------------------------------------------------------

export const SPECIES = [
  'human',
  'bear',
  'cat',
  'fox',
  'rabbit',
  'dog',
  'frog',
  'penguin',
  'owl',
  'monster',
] as const;
export type Species = (typeof SPECIES)[number];

const SPECIES_WEIGHTS: readonly (readonly [Species, number])[] = [
  ['human', 64],
  ['bear', 5],
  ['cat', 5],
  ['fox', 5],
  ['rabbit', 5],
  ['dog', 5],
  ['frog', 4],
  ['penguin', 4],
  ['owl', 4],
  ['monster', 5],
];

export const GENDERS = ['masc', 'fem', 'neutral'] as const;
export type Gender = (typeof GENDERS)[number];

export const BUILDS = ['slim', 'average', 'broad', 'round'] as const;
export type Build = (typeof BUILDS)[number];

/** In a head-and-shoulders portrait, height is how big the head is and where it sits. */
export const HEIGHTS = ['short', 'mid', 'tall'] as const;
export type Height = (typeof HEIGHTS)[number];

export const FACE_SHAPES = ['round', 'oval', 'square', 'heart', 'long'] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

export const HAIR_STYLES = [
  'bald',
  'buzz',
  'crop',
  'sidepart',
  'swoop',
  'quiff',
  'spiky',
  'mohawk',
  'curly',
  'afro',
  'afropuff',
  'longstraight',
  'longwavy',
  'bob',
  'bun',
  'topknot',
  'ponytail',
  'pigtails',
  'braids',
  'beanie',
  'cap',
  'headscarf',
] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];
/** Headwear replaces the hair drawing (its colour comes from the outfit accent). */
export const HEADWEAR: readonly HairStyle[] = ['beanie', 'cap', 'headscarf'];

// prettier-ignore
const HAIR_WEIGHTS: Record<Gender, readonly number[]> = {
  //       bald buzz crop side swoop quiff spiky mohk curly afro puff lstr lwav bob bun tknot pony pig braid bean cap scarf
  masc:    [6,   10,  12,  10,  6,    8,    6,    4,   8,    6,   2,   3,   2,   1,  2,  4,    2,   0.5, 2,   4,   5,  0.5],
  fem:     [0.5, 2,   2,   3,   4,    1,    1,    1,   7,    6,   6,   10,  10,  9,  7,  4,    9,   5,   6,   3,   2,  4],
  neutral: [3,   5,   5,   4,   5,    4,    4,    3,   5,    5,   4,   4,   4,   5,  4,  4,    4,   2,   3,   4,   4,  2],
};

export const EYE_SHAPES = ['dot', 'big', 'almond', 'sleepy', 'wide', 'button'] as const;
export type EyeShape = (typeof EYE_SHAPES)[number];

export const BROWS = ['none', 'thin', 'thick', 'bushy'] as const;
export type Brows = (typeof BROWS)[number];

export const NOSE_SHAPES = [
  'none',
  'button',
  'round',
  'triangle',
  'long',
  'hooked',
  'wide',
] as const;
export type NoseShape = (typeof NOSE_SHAPES)[number];

export const EXPRESSIONS = [
  'happy',
  'grin',
  'laugh',
  'smirk',
  'surprised',
  'wink',
  'determined',
  'cheeky',
  'calm',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];
const EXPRESSION_WEIGHTS: readonly (readonly [Expression, number])[] = [
  ['happy', 17],
  ['grin', 14],
  ['laugh', 10],
  ['smirk', 10],
  ['surprised', 7],
  ['wink', 8],
  ['determined', 10],
  ['cheeky', 8],
  ['calm', 10],
];

export const OUTFITS = [
  'tee',
  'vneck',
  'collared',
  'tie',
  'hoodie',
  'stripes',
  'turtleneck',
  'overalls',
  'jacket',
  'blouse',
  'scarf',
] as const;
export type Outfit = (typeof OUTFITS)[number];
// prettier-ignore
const OUTFIT_WEIGHTS: Record<Gender, readonly number[]> = {
  //       tee vneck coll tie hood strp turt over jack blou scarf
  masc:    [10, 6,    8,   6,  9,   7,   5,   4,   7,   0.5, 4],
  fem:     [8,  6,    5,   1,  8,   7,   6,   6,   6,   8,   6],
  neutral: [8,  6,    6,   3,  9,   7,   6,   5,   6,   4,   5],
};

export const FACIAL_HAIR = ['none', 'stubble', 'mustache', 'beard', 'goatee'] as const;
export type FacialHair = (typeof FACIAL_HAIR)[number];

export const GLASSES = ['none', 'round', 'square'] as const;
export type Glasses = (typeof GLASSES)[number];

export const HEAD_ACCESSORIES = ['none', 'bow', 'band', 'flower'] as const;
export type HeadAccessory = (typeof HEAD_ACCESSORIES)[number];

// ---- palettes ------------------------------------------------------------------------------

/** Duolingo-ish saturated, friendly backgrounds. */
export const BACKGROUNDS = [
  '#58cc02',
  '#1cb0f6',
  '#ff9600',
  '#ce82ff',
  '#ff4b4b',
  '#ffc800',
  '#2bd9b0',
  '#7c8cff',
  '#ff86d0',
] as const;

/** Realistic human skin, light to deep. */
export const SKIN = [
  '#ffe0c2',
  '#f9cfa5',
  '#efbb8b',
  '#dca172',
  '#c68658',
  '#a86b40',
  '#8a5230',
  '#6b3c22',
  '#4e2c1a',
] as const;

export const HAIR_COLORS = [
  '#2a1a14', // black
  '#4a2f22', // dark brown
  '#7b4a2c', // brown
  '#b5652f', // auburn
  '#e0b766', // blonde
  '#d0531f', // ginger
  '#a8a8b3', // grey
  '#f1ece4', // white
  '#6a5acd', // fun: violet
  '#e2588f', // fun: pink
  '#2f7fd8', // fun: blue
  '#1aa37a', // fun: teal
] as const;

export const OUTFIT_COLORS = [
  '#1f3b73',
  '#2f8f46',
  '#d9442e',
  '#f2b134',
  '#6b3fa0',
  '#127c84',
  '#ef6c8b',
  '#3d3d3d',
  '#f4f1ea',
  '#4a7bd0',
  '#8c5a3c',
  '#ff8a3d',
] as const;

/** Fur, feathers or skin per non-human species. No green owls: we borrow a style, not a mascot. */
export const FUR: Record<Exclude<Species, 'human'>, readonly string[]> = {
  bear: ['#8b5a2b', '#a0522d', '#5c3d2e', '#d9b38c', '#f2efe6'],
  cat: ['#f2a65a', '#9a9aa6', '#3a3438', '#e8d7c3', '#c97b4a'],
  fox: ['#f07a2a', '#e35d1f', '#c9c3bd'],
  rabbit: ['#f4efe9', '#c9a27e', '#9c8f86', '#e8c9a8'],
  dog: ['#c68a4c', '#e8cfa3', '#6b4a33', '#3b3b3b', '#f1e7d6'],
  frog: ['#6cc644', '#3fb36b', '#9ad14b', '#47a5a0'],
  penguin: ['#2f3a52', '#26262e', '#3d4f6e'],
  owl: ['#8b6a4f', '#a08a7a', '#7d5a8c', '#b5835a'],
  monster: ['#7fd6c2', '#b49cff', '#ff9ec7', '#ffb04a', '#6fb7ff'],
};

// ---- the traits ----------------------------------------------------------------------------

export interface AvatarTraits {
  species: Species;
  background: string;
  /** Human skin, or the animal's fur/feathers. */
  skin: string;
  gender: Gender;
  build: Build;
  height: Height;
  /** Head tilt in degrees (0 for most). */
  tilt: number;
  face: FaceShape;
  /** `none` for every non-human species. */
  hair: HairStyle | 'none';
  hairColor: string;
  eyes: EyeShape;
  /** 0..1, how far apart the eyes sit. */
  eyeSpread: number;
  lashes: boolean;
  brows: Brows;
  nose: NoseShape;
  expression: Expression;
  outfit: Outfit;
  outfitColor: string;
  /** Second outfit colour: stripes, tie, inner shirt, and the hat or headscarf. */
  outfitAccent: string;
  facialHair: FacialHair;
  glasses: Glasses;
  earrings: boolean;
  headAccessory: HeadAccessory;
  freckles: boolean;
  blush: boolean;
  beautyMark: boolean;
}

const GENDER_WEIGHTS: readonly (readonly [Gender, number])[] = [
  ['masc', 40],
  ['fem', 40],
  ['neutral', 20],
];

const chance = (r: () => number, p: number) => r() < p;

/**
 * Avatar traits from a seed: the agent's name, or the ticket id for a legacy ticket.
 * `overrides` (tests and the contact sheet only) replace drawn values after every draw, so they
 * never shift the other axes.
 */
export function avatarTraits(seed: string, overrides: Partial<AvatarTraits> = {}): AvatarTraits {
  const r = rng(hashString(`avatar:${seed}`));
  // The fixed draw order: never reorder, only append.
  // Always draw, so a species override (the contact sheet) keeps every other axis in place;
  // it is applied here rather than at the end because skin, hair and nose depend on it.
  const drawnSpecies = weighted(SPECIES_WEIGHTS, r);
  const species = overrides.species ?? drawnSpecies;
  const background = pick(BACKGROUNDS, r);
  const gender = weighted(GENDER_WEIGHTS, r);
  const build = pick(BUILDS, r);
  const height = weighted<Height>(
    [
      ['short', 3],
      ['mid', 4],
      ['tall', 3],
    ],
    r,
  );
  const tiltDraw = r();
  const tilt = tiltDraw < 0.35 ? Math.round((tiltDraw / 0.35 - 0.5) * 14) : 0;
  const face = pick(FACE_SHAPES, r);
  const humanSkin = pickApart(SKIN, r, [background], 90);
  const furSkin = pickApart(species === 'human' ? FUR.bear : FUR[species], r, [background], 110);
  const hairIndex = weighted(
    HAIR_STYLES.map((h, i) => [h, HAIR_WEIGHTS[gender][i]!] as const),
    r,
  );
  const hairColor = pickApart(HAIR_COLORS, r, [background], 80);
  const eyes = weighted(
    [
      ['dot', 6],
      ['big', 5],
      ['almond', 3],
      ['sleepy', 1.5],
      ['wide', 2],
      ['button', 3],
    ] as const,
    r,
  );
  const eyeSpread = Math.round(r() * 100) / 100;
  const lashes = chance(r, gender === 'fem' ? 0.7 : gender === 'neutral' ? 0.25 : 0.05);
  const brows = weighted(
    [
      ['none', 1],
      ['thin', 4],
      ['thick', 5],
      ['bushy', 2],
    ] as const,
    r,
  );
  const nose = pick(NOSE_SHAPES, r);
  const expression = weighted(EXPRESSION_WEIGHTS, r);
  const outfit = weighted(
    OUTFITS.map((o, i) => [o, OUTFIT_WEIGHTS[gender][i]!] as const),
    r,
  );
  const outfitColor = pickApart(OUTFIT_COLORS, r, [background], 120);
  const outfitAccent = pickApart(OUTFIT_COLORS, r, [outfitColor], 110);
  const facialHairDraw = r();
  const facialHairKind = pick(FACIAL_HAIR.slice(1), r);
  const glassesDraw = r();
  const glassesKind = pick(GLASSES.slice(1), r);
  const earrings = chance(r, gender === 'fem' ? 0.45 : gender === 'neutral' ? 0.25 : 0.12);
  const headAccDraw = r();
  const headAccKind = pick(HEAD_ACCESSORIES.slice(1), r);
  const freckles = chance(r, 0.2);
  const blush = chance(r, 0.8);
  const beautyMark = chance(r, 0.08);

  const human = species === 'human';
  const hair: HairStyle | 'none' = human ? hairIndex : 'none';
  const headwear = HEADWEAR.includes(hair as HairStyle);
  const facialHairRate = gender === 'masc' ? 0.35 : gender === 'neutral' ? 0.05 : 0;
  const facialHair: FacialHair =
    human && hair !== 'headscarf' && facialHairDraw < facialHairRate ? facialHairKind : 'none';
  const headAccRate = gender === 'fem' ? 0.15 : 0.04;
  const traits: AvatarTraits = {
    species,
    background,
    skin: human ? humanSkin : furSkin,
    gender,
    build,
    height,
    tilt,
    face,
    hair,
    hairColor,
    eyes,
    eyeSpread,
    lashes,
    brows,
    nose: human ? nose : 'none',
    expression,
    outfit,
    outfitColor,
    outfitAccent,
    facialHair,
    glasses: glassesDraw < 0.16 ? glassesKind : 'none',
    earrings: human && hair !== 'headscarf' && earrings,
    headAccessory: human && !headwear && headAccDraw < headAccRate ? headAccKind : 'none',
    freckles: human && freckles,
    blush,
    beautyMark: human && beautyMark,
  };
  return { ...traits, ...overrides };
}
