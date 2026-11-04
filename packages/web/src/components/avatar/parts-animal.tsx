// Non-human heads in head-local coordinates (centred on 0,0, radius about 25). Each species is
// built from a few chunky shapes: ears, a head, a muzzle and a nose. The shared eyes, brows and
// mouth (parts-face) go on top, so every species can wear every expression.
import type { ReactNode } from 'react';
import { luminance, shade, tint } from './color.js';
import { INK } from './parts-face.js';
import type { Species } from './traits.js';

const PINK = '#ff9fb2';
const BEAK = '#ffa53c';

export interface AnimalHead {
  /** Behind the head (ears, tufts). */
  back: ReactNode;
  /** The head itself and its markings. */
  face: ReactNode;
  /** Over the eyes: snout, nose, whiskers. */
  front: ReactNode;
  eyeX: number;
  eyeY: number;
  eyeScale: number;
  mouthY: number;
  /** Birds: a beak replaces the mouth. */
  beak: boolean;
}

/** Light markings for the muzzle and belly. */
export function muzzleColor(species: Species, fur: string): string {
  if (species === 'fox' || species === 'penguin') return '#fff8ee';
  return luminance(fur) > 0.75 ? shade(fur, 0.1) : tint(fur, 0.55);
}

export function animalHead(species: Exclude<Species, 'human'>, fur: string): AnimalHead {
  const muzzle = muzzleColor(species, fur);
  const dark = shade(fur, 0.25);
  switch (species) {
    case 'bear':
      return {
        back: (
          <g>
            <circle cx="-19" cy="-19" r="9.5" fill={fur} />
            <circle cx="19" cy="-19" r="9.5" fill={fur} />
            <circle cx="-19" cy="-19" r="5" fill={muzzle} />
            <circle cx="19" cy="-19" r="5" fill={muzzle} />
          </g>
        ),
        face: <ellipse rx="26.5" ry="25" fill={fur} />,
        front: (
          <g>
            <ellipse cx="0" cy="12" rx="12.5" ry="9.5" fill={muzzle} />
            <path d="M-4.5 6.5 Q0 4.6 4.5 6.5 Q3.4 10.4 0 11 Q-3.4 10.4 -4.5 6.5 Z" fill={INK} />
          </g>
        ),
        eyeX: 10,
        eyeY: -2,
        eyeScale: 1,
        mouthY: 14,
        beak: false,
      };
    case 'cat':
      return {
        back: (
          <g strokeLinejoin="round">
            <path d="M-25 -6 L-21 -36 L-5 -22 Z" fill={fur} stroke={fur} strokeWidth="4" />
            <path d="M25 -6 L21 -36 L5 -22 Z" fill={fur} stroke={fur} strokeWidth="4" />
            <path d="M-20 -14 L-19 -29 L-11 -21 Z" fill={PINK} />
            <path d="M20 -14 L19 -29 L11 -21 Z" fill={PINK} />
          </g>
        ),
        face: <ellipse rx="27.5" ry="24" fill={fur} />,
        front: (
          <g>
            <ellipse cx="-4.4" cy="11.5" rx="5.4" ry="4.2" fill={muzzle} />
            <ellipse cx="4.4" cy="11.5" rx="5.4" ry="4.2" fill={muzzle} />
            <path
              d="M-3 7 L3 7 L0 10 Z"
              fill={PINK}
              stroke={PINK}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="M-11 10 L-24 7 M-11 13 L-24 14 M11 10 L24 7 M11 13 L24 14"
              stroke={shade(fur, 0.45)}
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </g>
        ),
        eyeX: 10.5,
        eyeY: -2,
        eyeScale: 1,
        mouthY: 12.5,
        beak: false,
      };
    case 'fox':
      return {
        back: (
          <g strokeLinejoin="round">
            <path d="M-26 -4 L-23 -40 L-5 -22 Z" fill={fur} stroke={fur} strokeWidth="4" />
            <path d="M26 -4 L23 -40 L5 -22 Z" fill={fur} stroke={fur} strokeWidth="4" />
            <path d="M-21 -14 L-21 -32 L-11 -22 Z" fill={dark} />
            <path d="M21 -14 L21 -32 L11 -22 Z" fill={dark} />
          </g>
        ),
        face: (
          <g>
            <path
              d="M-29 -2 C-29 -30 29 -30 29 -2 C29 10 12 25 0 26 C-12 25 -29 10 -29 -2 Z"
              fill={fur}
            />
            <path
              d="M-29 0 C-20 3 -8 6 0 13 C8 6 20 3 29 0 C27 12 12 25 0 26 C-12 25 -27 12 -29 0 Z"
              fill={muzzle}
            />
          </g>
        ),
        front: <ellipse cx="0" cy="13.5" rx="3.6" ry="2.7" fill={INK} />,
        eyeX: 10.5,
        eyeY: -4,
        eyeScale: 0.95,
        mouthY: 17,
        beak: false,
      };
    case 'rabbit':
      return {
        back: (
          <g>
            <g transform="rotate(-10 -10 -24)">
              <ellipse cx="-10" cy="-38" rx="7.5" ry="19" fill={fur} />
              <ellipse cx="-10" cy="-36" rx="3.6" ry="13" fill={PINK} />
            </g>
            <g transform="rotate(12 10 -24)">
              <ellipse cx="10" cy="-38" rx="7.5" ry="19" fill={fur} />
              <ellipse cx="10" cy="-36" rx="3.6" ry="13" fill={PINK} />
            </g>
          </g>
        ),
        face: <ellipse rx="25" ry="24" fill={fur} />,
        front: (
          <g>
            <ellipse cx="0" cy="11.5" rx="9.5" ry="6.5" fill={muzzle} />
            <ellipse cx="0" cy="7.5" rx="3" ry="2.2" fill={PINK} />
          </g>
        ),
        eyeX: 9.5,
        eyeY: -2,
        eyeScale: 1,
        mouthY: 12.5,
        beak: false,
      };
    case 'dog':
      return {
        back: null,
        face: (
          <g>
            <ellipse rx="25" ry="25" fill={fur} />
            <ellipse cx="-11" cy="-4" rx="8" ry="9" fill={shade(fur, 0.12)} />
          </g>
        ),
        front: (
          <g>
            <path d="M-19 -20 C-36 -22 -38 8 -29 16 C-24 10 -22 -4 -15 -12 Z" fill={dark} />
            <path d="M19 -20 C36 -22 38 8 29 16 C24 10 22 -4 15 -12 Z" fill={dark} />
            <ellipse cx="0" cy="11.5" rx="12" ry="9" fill={muzzle} />
            <ellipse cx="0" cy="6.5" rx="5.2" ry="3.8" fill={INK} />
            <ellipse cx="-1.4" cy="5.4" rx="1.6" ry="1" fill="#ffffff" fillOpacity="0.6" />
          </g>
        ),
        eyeX: 10.5,
        eyeY: -4,
        eyeScale: 1,
        mouthY: 14,
        beak: false,
      };
    case 'frog':
      return {
        back: (
          <g fill={fur}>
            <circle cx="-13" cy="-14" r="10.5" />
            <circle cx="13" cy="-14" r="10.5" />
          </g>
        ),
        face: (
          <g>
            <ellipse cx="0" cy="3" rx="30" ry="22" fill={fur} />
            <ellipse cx="0" cy="15" rx="19" ry="8" fill={muzzle} />
          </g>
        ),
        front: (
          <g fill={shade(fur, 0.4)}>
            <circle cx="-3" cy="4" r="1.2" />
            <circle cx="3" cy="4" r="1.2" />
          </g>
        ),
        eyeX: 13,
        eyeY: -14,
        eyeScale: 1.05,
        mouthY: 10,
        beak: false,
      };
    case 'penguin':
      return {
        back: null,
        face: (
          <g>
            <ellipse rx="26.5" ry="25.5" fill={fur} />
            <path
              d="M0 -11 C-6 -21 -23 -19 -23 -4 C-23 12 -10 22 0 24 C10 22 23 12 23 -4 C23 -19 6 -21 0 -11 Z"
              fill={muzzle}
            />
          </g>
        ),
        front: null,
        eyeX: 9,
        eyeY: -1,
        eyeScale: 1,
        mouthY: 8,
        beak: true,
      };
    case 'owl':
      return {
        back: (
          <g fill={dark} strokeLinejoin="round" stroke={dark} strokeWidth="3">
            <path d="M-24 -14 L-27 -34 L-12 -24 Z" />
            <path d="M24 -14 L27 -34 L12 -24 Z" />
          </g>
        ),
        face: (
          <g>
            <ellipse rx="27" ry="25" fill={fur} />
            <circle cx="-10.5" cy="-1" r="10.5" fill={muzzle} />
            <circle cx="10.5" cy="-1" r="10.5" fill={muzzle} />
            <path d="M-6 20 L-3 17 L0 20 L3 17 L6 20" fill="none" stroke={dark} strokeWidth="1.6" />
          </g>
        ),
        front: null,
        eyeX: 10.5,
        eyeY: -1,
        eyeScale: 1,
        mouthY: 7,
        beak: true,
      };
    case 'monster':
      return {
        back: (
          <g fill="#fff3d6" stroke="#fff3d6" strokeWidth="2" strokeLinejoin="round">
            <path d="M-18 -20 C-24 -30 -22 -38 -16 -42 C-15 -34 -10 -28 -8 -24 Z" />
            <path d="M18 -20 C24 -30 22 -38 16 -42 C15 -34 10 -28 8 -24 Z" />
          </g>
        ),
        face: (
          <g>
            <path
              d="M-27 4 C-29 -23 -14 -30 0 -30 C14 -30 29 -23 27 4 C27 21 14 27 0 27 C-14 27 -27 21 -27 4 Z"
              fill={fur}
            />
            <g fill={shade(fur, 0.15)}>
              <circle cx="-17" cy="-15" r="3.2" />
              <circle cx="19" cy="-11" r="2.4" />
              <circle cx="-20" cy="11" r="2" />
            </g>
          </g>
        ),
        front: null,
        eyeX: 10,
        eyeY: -5,
        eyeScale: 1.1,
        mouthY: 12,
        beak: false,
      };
  }
}

export { BEAK };
