// Human parts in head-local coordinates (head centred on 0,0, radius about 25; y grows down).
import { shade, tint } from './color.js';
import type { FaceShape, FacialHair, HairStyle, HeadAccessory, NoseShape } from './traits.js';

/** The face silhouette, and how far down the chin sits (for beards and the mouth). */
export function faceGeometry(shape: FaceShape): { chin: number; halfWidth: number } {
  switch (shape) {
    case 'round':
      return { chin: 25.5, halfWidth: 25 };
    case 'oval':
      return { chin: 27, halfWidth: 23.5 };
    case 'square':
      return { chin: 26, halfWidth: 25 };
    case 'heart':
      return { chin: 27, halfWidth: 26 };
    case 'long':
      return { chin: 28.5, halfWidth: 22 };
  }
}

export function Face({ shape, color }: { shape: FaceShape; color: string }) {
  switch (shape) {
    case 'round':
      return <ellipse rx="25" ry="25.5" fill={color} />;
    case 'oval':
      return <ellipse rx="23.5" ry="27" fill={color} />;
    case 'square':
      return <rect x="-25" y="-25" width="50" height="51" rx="16" fill={color} />;
    case 'heart':
      return (
        <path
          d="M-26 -5 C-26 -32 26 -32 26 -5 C26 12 12 27 0 27 C-12 27 -26 12 -26 -5 Z"
          fill={color}
        />
      );
    case 'long':
      return <ellipse rx="22" ry="28.5" fill={color} />;
  }
}

export function Ears({ halfWidth, color }: { halfWidth: number; color: string }) {
  return (
    <g fill={shade(color, 0.08)}>
      <ellipse cx={-halfWidth} cy="3" rx="5" ry="6" />
      <ellipse cx={halfWidth} cy="3" rx="5" ry="6" />
    </g>
  );
}

export function Nose({ shape, skin }: { shape: NoseShape; skin: string }) {
  const c = shade(skin, 0.2);
  switch (shape) {
    case 'none':
      return null;
    case 'button':
      return <ellipse cx="0" cy="8.5" rx="2.6" ry="2" fill={c} />;
    case 'round':
      return <circle cx="0" cy="7.5" r="4" fill={shade(skin, 0.12)} />;
    case 'triangle':
      return (
        <path
          d="M0 2 L3.6 9.2 Q0 10.8 -3.6 9.2 Z"
          fill={c}
          stroke={c}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      );
    case 'long':
      return <path d="M-1.4 -1 L1.4 -1 L3.4 9 Q0 11.2 -3.4 9 Z" fill={c} />;
    case 'hooked':
      return (
        <path
          d="M-0.5 0 Q5.5 6 3 10 Q0 11.2 -2.6 9.6"
          fill="none"
          stroke={c}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      );
    case 'wide':
      return <ellipse cx="0" cy="8.8" rx="5.4" ry="2.8" fill={c} />;
  }
}

/** Hair that falls behind the head and shoulders (drawn before the body). */
export function HairBack({ style, color }: { style: HairStyle; color: string }) {
  switch (style) {
    case 'afro':
      return <circle cx="0" cy="-7" r="36" fill={color} />;
    case 'afropuff':
      return <circle cx="0" cy="-31" r="17" fill={color} />;
    case 'longstraight':
      return <path d="M-30 -6 C-33 -40 33 -40 30 -6 L32 44 C20 50 -20 50 -32 44 Z" fill={color} />;
    case 'longwavy':
      return (
        <path
          d="M-30 -6 C-35 -40 35 -40 30 -6 C37 6 29 16 35 26 C39 36 31 44 31 46 C18 52 -18 52 -31 46 C-31 44 -39 36 -35 26 C-29 16 -37 6 -30 -6 Z"
          fill={color}
        />
      );
    case 'bob':
      return (
        <path
          d="M-31 -4 C-35 -40 35 -40 31 -4 L32 17 C32 24 25 25 22 22 L-22 22 C-25 25 -32 24 -32 17 Z"
          fill={color}
        />
      );
    case 'bun':
      return <circle cx="0" cy="-31" r="11" fill={color} />;
    case 'topknot':
      return (
        <g>
          <circle cx="0" cy="-36" r="8.5" fill={color} />
          <rect x="-5" y="-30" width="10" height="4" rx="2" fill={shade(color, 0.3)} />
        </g>
      );
    case 'ponytail':
      return <path d="M14 -24 C42 -26 46 10 34 32 C33 14 30 0 18 -10 Z" fill={color} />;
    case 'pigtails':
      return (
        <g fill={color}>
          <circle cx="-32" cy="-4" r="11" />
          <circle cx="32" cy="-4" r="11" />
        </g>
      );
    case 'braids':
      return (
        <g>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i} fill={i % 2 ? shade(color, 0.18) : color}>
              <ellipse cx={-26} cy={6 + i * 8} rx={5.4 - i * 0.3} ry="5" />
              <ellipse cx={26} cy={6 + i * 8} rx={5.4 - i * 0.3} ry="5" />
            </g>
          ))}
        </g>
      );
    case 'cap':
      // Tufts poking out from under the cap.
      return (
        <path
          d="M-26 -12 L-28 4 L-22 -2 Z M26 -12 L28 4 L22 -2 Z"
          fill={color}
          stroke={color}
          strokeWidth="3"
          strokeLinejoin="round"
        />
      );
    default:
      return null;
  }
}

/** A headscarf's drape, over the neck and shoulders (drawn after the body). */
export function HeadscarfDrape({ color }: { color: string }) {
  return (
    <g>
      <path
        d="M-33 -8 C-37 -46 37 -46 33 -8 C34 14 30 32 44 54 L-44 54 C-30 32 -34 14 -33 -8 Z"
        fill={color}
      />
      <path d="M8 30 C18 36 26 44 30 54 L18 54 C16 44 12 38 8 30 Z" fill={shade(color, 0.15)} />
    </g>
  );
}

const CAP_FRONT = {
  crop: 'M-26.5 -2 C-29 -34 29 -34 26.5 -2 C24 -13 16 -18 0 -18 C-16 -18 -24 -13 -26.5 -2 Z',
  buzz: 'M-25.5 -7 C-27 -31 27 -31 25.5 -7 C22 -15 14 -20 0 -20 C-14 -20 -22 -15 -25.5 -7 Z',
  sidepart: 'M-27 3 C-32 -36 31 -37 27.5 -2 C26 -11 22 -16 15 -17 C8 -9 -14 -11 -27 3 Z',
  swoop: 'M-27.5 6 C-33 -39 33 -37 27.5 -4 C20 -14 8 -16 -2 -14 C-8 -6 -18 0 -27.5 6 Z',
  smooth: 'M-26 -2 C-29 -34 29 -34 26 -2 C22 -16 12 -21 0 -21 C-12 -21 -22 -16 -26 -2 Z',
  center:
    'M-27.5 4 C-32 -38 32 -38 27.5 4 C25 -10 14 -19 2 -19 L0 -15 L-2 -19 C-14 -19 -25 -10 -27.5 4 Z',
  bangs: 'M-28 -2 C-31 -38 31 -38 28 -2 L27 -10 C18 -12 -18 -12 -27 -10 Z',
} as const;

/** Hair (or headwear) over the top of the head. */
export function HairFront({
  style,
  color,
  hat,
}: {
  style: HairStyle;
  color: string;
  /** Hat or headscarf colour. */
  hat: string;
}) {
  const hl = tint(color, 0.35);
  const highlight = (
    <path
      d="M-15 -22 Q-8 -28 0 -27"
      fill="none"
      stroke={hl}
      strokeWidth="2.6"
      strokeLinecap="round"
    />
  );
  switch (style) {
    case 'bald':
      return (
        <path
          d="M-13 -19 Q-7 -24 0 -23.5"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.45"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      );
    case 'buzz':
      return <path d={CAP_FRONT.buzz} fill={color} fillOpacity="0.8" />;
    case 'crop':
      return (
        <g>
          <path d={CAP_FRONT.crop} fill={color} />
          {highlight}
        </g>
      );
    case 'sidepart':
      return (
        <g>
          <path d={CAP_FRONT.sidepart} fill={color} />
          {highlight}
        </g>
      );
    case 'swoop':
    case 'longwavy':
      return (
        <g>
          <path d={CAP_FRONT.swoop} fill={color} />
          <path
            d="M8 -26 Q16 -24 20 -18"
            fill="none"
            stroke={hl}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </g>
      );
    case 'quiff':
      return (
        <g fill={color}>
          <path d={CAP_FRONT.crop} />
          <ellipse cx="-3" cy="-27" rx="19" ry="10" transform="rotate(-8 -3 -27)" />
          <path
            d="M-14 -31 Q-4 -37 8 -34"
            fill="none"
            stroke={hl}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </g>
      );
    case 'spiky':
      return (
        <path
          d="M-26 -1 L-27 -22 L-19 -20 L-17 -35 L-9 -26 L-3 -41 L4 -27 L11 -37 L15 -24 L24 -30 L22 -16 L27 -12 L26.5 -1 C23 -12 15 -16 0 -16 C-15 -16 -23 -12 -26 -1 Z"
          fill={color}
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      );
    case 'mohawk':
      return (
        <g fill={color}>
          <path d={CAP_FRONT.buzz} fillOpacity="0.35" />
          <path d="M-7 -18 C-9 -32 -4 -44 3 -46 C7 -37 9 -27 7 -18 Z" />
        </g>
      );
    case 'curly':
      return (
        <g fill={color}>
          {[
            [-24, -8, 7],
            [-22, -18, 8],
            [-14, -26, 8.5],
            [-4, -30, 8.5],
            [7, -29, 8.5],
            [16, -25, 8],
            [23, -16, 7.5],
            [25, -7, 6.5],
          ].map(([x, y, r]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r={r} />
          ))}
        </g>
      );
    case 'afro':
      return <path d={CAP_FRONT.crop} fill={color} />;
    case 'afropuff':
    case 'bun':
    case 'topknot':
    case 'ponytail':
      return (
        <g>
          <path d={CAP_FRONT.smooth} fill={color} />
          {highlight}
        </g>
      );
    case 'longstraight':
    case 'pigtails':
    case 'braids':
      return (
        <g>
          <path d={CAP_FRONT.center} fill={color} />
          {highlight}
        </g>
      );
    case 'bob':
      return (
        <g>
          <path d={CAP_FRONT.bangs} fill={color} />
          {highlight}
        </g>
      );
    case 'beanie':
      return (
        <g>
          <path d="M-28 -6 C-30 -44 30 -44 28 -6 Z" fill={hat} />
          <rect x="-29.5" y="-12" width="59" height="10" rx="5" fill={shade(hat, 0.18)} />
          <circle cx="0" cy="-40" r="6.5" fill={tint(hat, 0.35)} />
        </g>
      );
    case 'cap':
      return (
        <g>
          <path d="M-27 -9 C-28 -41 28 -41 27 -9 Z" fill={hat} />
          <path d="M-27 -10 C-10 -15 22 -15 42 -6 C32 -1 10 -4 -27 -6 Z" fill={shade(hat, 0.22)} />
          <circle cx="0" cy="-35" r="2.2" fill={shade(hat, 0.22)} />
        </g>
      );
    case 'headscarf':
      return (
        <path
          d="M-26.5 0 C-30 -34 30 -34 26.5 0 C23 -14 13 -18 0 -18 C-13 -18 -23 -14 -26.5 0 Z"
          fill={hat}
        />
      );
  }
}

export function FacialHairShape({
  kind,
  color,
  chin,
}: {
  kind: FacialHair;
  color: string;
  chin: number;
}) {
  const mustache =
    'M-8 13 C-5 9.4 -1.4 10.4 0 11.8 C1.4 10.4 5 9.4 8 13 C4.6 14.4 1.2 13.6 0 13 C-1.2 13.6 -4.6 14.4 -8 13 Z';
  switch (kind) {
    case 'none':
      return null;
    case 'stubble':
      return (
        <path
          d={`M-23 4 C-21 ${chin + 2} 21 ${chin + 2} 23 4 C17 15 8 13 0 13 C-8 13 -17 15 -23 4 Z`}
          fill={color}
          fillOpacity="0.25"
        />
      );
    case 'mustache':
      return <path d={mustache} fill={color} />;
    case 'beard':
      return (
        <g fill={color}>
          <path
            d={`M-24.5 2 C-25 ${chin + 6} -10 ${chin + 9} 0 ${chin + 9} C10 ${chin + 9} 25 ${chin + 6} 24.5 2 C21 11 14 13 0 13 C-14 13 -21 11 -24.5 2 Z`}
          />
          <path d={mustache} />
        </g>
      );
    case 'goatee':
      return (
        <g fill={color}>
          <path d={`M-6 ${chin - 5} C-6 ${chin + 4} 6 ${chin + 4} 6 ${chin - 5} Z`} />
          <path d={mustache} />
        </g>
      );
  }
}

export function HeadAccessoryShape({ kind, color }: { kind: HeadAccessory; color: string }) {
  switch (kind) {
    case 'none':
      return null;
    case 'bow':
      return (
        <g fill={color} transform="translate(17 -24) rotate(20)">
          <path
            d="M0 0 L-9 -6 L-9 6 Z M0 0 L9 -6 L9 6 Z"
            strokeLinejoin="round"
            stroke={color}
            strokeWidth="2"
          />
          <circle r="2.8" fill={shade(color, 0.2)} />
        </g>
      );
    case 'band':
      return (
        <path
          d="M-26 -12 C-20 -26 20 -26 26 -12"
          fill="none"
          stroke={color}
          strokeWidth="4.5"
          strokeLinecap="round"
        />
      );
    case 'flower':
      return (
        <g transform="translate(-18 -21)">
          {[0, 72, 144, 216, 288].map((a) => (
            <circle
              key={a}
              cx={Math.round(Math.cos((a * Math.PI) / 180) * 4 * 100) / 100}
              cy={Math.round(Math.sin((a * Math.PI) / 180) * 4 * 100) / 100}
              r="3.4"
              fill={color}
            />
          ))}
          <circle r="2.4" fill="#ffd84a" />
        </g>
      );
  }
}
