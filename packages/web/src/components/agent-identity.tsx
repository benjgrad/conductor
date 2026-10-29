// The agent working a ticket gets a human first name and a flat 2D avatar, both derived from the
// ticket id (Ben, 2026-10-23: per ticket, not per session, so the agent keeps its name and face
// across retries and resumes). They are pure functions of the id, so a ticket's agent looks the
// same everywhere (board card, panel header, Details) and on every machine. Nothing is stored. The
// avatar is drawn procedurally as inline SVG: no image service, no library.
import { AGENT_NAMES } from '@conductor/shared';
import { useId } from 'react';

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
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(list: readonly T[], r: () => number): T => list[Math.floor(r() * list.length)]!;

/** The hiring pool (UX-13a: moved to @conductor/shared; re-exported for the old imports). */
export { AGENT_NAMES };

const SKIN = ['#ffdcb5', '#f5c99b', '#e8b07f', '#c98e5a', '#a4693f', '#7a4a2a', '#5a3620'] as const;
const HAIR = [
  '#2a1a14', // black
  '#4a2f22', // dark brown
  '#7b4a2c', // brown
  '#b5652f', // auburn
  '#e0b766', // blonde
  '#d0531f', // ginger
  '#a8a8b3', // grey
  '#6a5acd', // fun: violet
  '#e2588f', // fun: pink
] as const;
/** Duolingo-ish saturated, friendly backgrounds. */
const BACKGROUNDS = [
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
const SHIRTS = [
  '#1f3b73',
  '#2f8f46',
  '#d9442e',
  '#f2b134',
  '#6b3fa0',
  '#127c84',
  '#ef6c8b',
  '#3d3d3d',
  '#f4f1ea',
] as const;

export const HAIR_STYLES = [
  'bald',
  'crop',
  'long',
  'bun',
  'curly',
  'swoop',
  'ponytail',
  'spiky',
] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

export interface AvatarTraits {
  background: string;
  skin: string;
  hair: HairStyle;
  hairColor: string;
  shirt: string;
  glasses: boolean;
  freckles: boolean;
  /** 0 = closed smile, 1 = open grin. */
  mouth: 0 | 1;
}

export interface AgentIdentity {
  name: string;
  traits: AvatarTraits;
}

export function agentName(ticketId: string): string {
  return AGENT_NAMES[hashString(`name:${ticketId}`) % AGENT_NAMES.length]!;
}

export function avatarTraits(ticketId: string): AvatarTraits {
  const r = rng(hashString(`avatar:${ticketId}`));
  const background = pick(BACKGROUNDS, r);
  const skin = pick(SKIN, r);
  const hair = pick(HAIR_STYLES, r);
  const hairColor = pick(HAIR, r);
  // SHIRTS and BACKGROUNDS share no colour, so the shoulders always stand out.
  const shirt = pick(SHIRTS, r);
  const glasses = r() < 0.28;
  const freckles = r() < 0.22;
  const mouth = r() < 0.4 ? 1 : 0;
  return { background, skin, hair, hairColor, shirt, glasses, freckles, mouth };
}

export function agentIdentity(ticketId: string): AgentIdentity {
  return { name: agentName(ticketId), traits: avatarTraits(ticketId) };
}

/** Darken a #rrggbb colour by `f` (0..1), for shading (neck, ears, collar). */
function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - f));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Hair drawn behind the head (long hair, ponytail, bun). */
function HairBack({ style, color }: { style: HairStyle; color: string }) {
  switch (style) {
    case 'long':
      return <path d="M15 30 C15 14 49 14 49 30 L51 52 C44 56 20 56 13 52 Z" fill={color} />;
    case 'ponytail':
      return <path d="M44 24 C56 26 56 44 48 50 C50 40 48 32 42 28 Z" fill={color} />;
    case 'bun':
      return <circle cx="32" cy="11" r="7" fill={color} />;
    default:
      return null;
  }
}

/** Hair drawn over the top of the head. */
function HairFront({ style, color }: { style: HairStyle; color: string }) {
  switch (style) {
    case 'bald':
      return null;
    case 'crop':
      return (
        <path d="M17 27 C17 13 47 13 47 27 C44 21 39 19 32 19 C25 19 20 21 17 27 Z" fill={color} />
      );
    case 'long':
    case 'bun':
    case 'ponytail':
      return (
        <path d="M17 29 C16 13 48 13 47 29 C44 22 38 19 33 20 C30 23 24 25 17 29 Z" fill={color} />
      );
    case 'curly':
      return (
        <g fill={color}>
          <circle cx="20" cy="22" r="6" />
          <circle cx="26" cy="16" r="6.5" />
          <circle cx="33" cy="14" r="6.5" />
          <circle cx="40" cy="17" r="6.5" />
          <circle cx="45" cy="23" r="5.5" />
          <circle cx="18" cy="28" r="4" />
          <circle cx="46" cy="29" r="4" />
        </g>
      );
    case 'swoop':
      return (
        <path d="M17 28 C15 12 47 11 47 26 C45 24 43 23 41 23 C34 26 24 22 17 28 Z" fill={color} />
      );
    case 'spiky':
      return (
        <path
          d="M17 27 L18 17 L22 20 L24 12 L28 17 L32 10 L36 17 L40 12 L42 20 L46 17 L47 27 C42 21 22 21 17 27 Z"
          fill={color}
        />
      );
  }
}

export interface AgentAvatarProps {
  ticketId: string;
  /** Rendered size in px. Default 32. Designed to read at 20 and 64. */
  size?: number;
  /** An accessible name; omitted → decorative (aria-hidden). */
  title?: string;
  className?: string;
}

/** A flat, friendly person on a coloured circle, deterministic per ticket id. */
export function AgentAvatar({ ticketId, size = 32, title, className }: AgentAvatarProps) {
  const t = avatarTraits(ticketId);
  const clip = useId();
  const ink = '#2b2335';
  const eyeY = 30;
  return (
    <svg
      className={`avatar${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-hair={t.hair}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill={t.background} />
        <HairBack style={t.hair} color={t.hairColor} />
        {/* shoulders + collar */}
        <path d="M8 66 C8 52 18 46 32 46 C46 46 56 52 56 66 Z" fill={t.shirt} />
        <path d="M25 47 L32 55 L39 47 Z" fill={shade(t.shirt, 0.25)} />
        {/* neck */}
        <rect x="27" y="38" width="10" height="11" rx="4" fill={shade(t.skin, 0.12)} />
        {/* ears */}
        <circle cx="17" cy="31" r="3.5" fill={shade(t.skin, 0.06)} />
        <circle cx="47" cy="31" r="3.5" fill={shade(t.skin, 0.06)} />
        {/* face */}
        <ellipse cx="32" cy="29" rx="15" ry="15.5" fill={t.skin} />
        <HairFront style={t.hair} color={t.hairColor} />
        {/* cheeks */}
        <circle cx="23" cy="35" r="3" fill="#ff7a8a" opacity="0.35" />
        <circle cx="41" cy="35" r="3" fill="#ff7a8a" opacity="0.35" />
        {t.freckles && (
          <g fill={shade(t.skin, 0.35)}>
            <circle cx="22" cy="33.5" r="0.9" />
            <circle cx="24.5" cy="35" r="0.9" />
            <circle cx="21.5" cy="36" r="0.9" />
            <circle cx="42" cy="33.5" r="0.9" />
            <circle cx="39.5" cy="35" r="0.9" />
            <circle cx="42.5" cy="36" r="0.9" />
          </g>
        )}
        {/* eyes: dark ovals with a highlight, Duolingo-style */}
        <ellipse cx="26" cy={eyeY} rx="2.4" ry="3" fill={ink} />
        <ellipse cx="38" cy={eyeY} rx="2.4" ry="3" fill={ink} />
        <circle cx="26.9" cy={eyeY - 1.1} r="0.9" fill="#fff" />
        <circle cx="38.9" cy={eyeY - 1.1} r="0.9" fill="#fff" />
        {t.glasses && (
          <g fill="none" stroke={ink} strokeWidth="1.8">
            <circle cx="26" cy={eyeY} r="5.2" />
            <circle cx="38" cy={eyeY} r="5.2" />
            <path d="M31.2 30 Q32 29 32.8 30" />
          </g>
        )}
        {t.mouth === 1 ? (
          <path
            d="M26.5 36.5 Q32 37.5 37.5 36.5 Q36 42.5 32 42.5 Q28 42.5 26.5 36.5 Z"
            fill={ink}
          />
        ) : (
          <path
            d="M27 37 Q32 41.5 37 37"
            fill="none"
            stroke={ink}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}
      </g>
    </svg>
  );
}
