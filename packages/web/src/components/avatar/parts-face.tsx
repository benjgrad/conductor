// Features every species shares: eyes, brows, mouths and glasses, in head-local coordinates
// (the head is centred on 0,0 with a radius of about 25). Expressions set eyes, brows and mouth
// together, so a smirk or a laugh reads the same on a person and on a fox.
import type { Brows, EyeShape, Expression, Glasses } from './traits.js';

export const INK = '#2b2335';
const MOUTH = '#4b1d2b';
const TONGUE = '#ff7a8a';
const WHITE = '#ffffff';

export interface EyeProps {
  x: number;
  y: number;
  shape: EyeShape;
  /** `arc`: a closed, happy ^ (laughing, winking). */
  closed: boolean;
  /** -1 for the left eye, +1 for the right: the side the lashes and the pupil lean to. */
  side: -1 | 1;
  lashes: boolean;
  /** Eye size multiplier (species and age). */
  scale: number;
  /** The face colour, for a sleepy eye's lid. */
  lid: string;
  /** Line colour for a closed eye (light on dark fur). */
  ink?: string;
}

export function Eye({ x, y, shape, closed, side, lashes, scale, lid, ink = INK }: EyeProps) {
  const s = scale;
  if (closed) {
    return (
      <path
        d={`M${x - 4.6 * s} ${y + 1.6 * s} Q${x} ${y - 4.6 * s} ${x + 4.6 * s} ${y + 1.6 * s}`}
        fill="none"
        stroke={ink}
        strokeWidth={2.8 * s}
        strokeLinecap="round"
      />
    );
  }
  const lash = lashes && (
    <path
      d={`M${x + side * 3.4 * s} ${y - 3.8 * s} l${side * 3.2 * s} ${-1.8 * s}`}
      stroke={INK}
      strokeWidth={2.2 * s}
      strokeLinecap="round"
    />
  );
  // Pupils glance a little toward the centre: a friendlier, more "looking at you" face.
  const look = -side * 0.5 * s;
  switch (shape) {
    case 'dot':
      return (
        <g>
          {lash}
          <ellipse cx={x} cy={y} rx={3.6 * s} ry={4.6 * s} fill={INK} />
          <circle cx={x + 1.3 * s} cy={y - 1.7 * s} r={1.4 * s} fill={WHITE} />
        </g>
      );
    case 'button':
      return (
        <g>
          {lash}
          <circle cx={x} cy={y} r={3 * s} fill={INK} />
          <circle cx={x + 1 * s} cy={y - 1 * s} r={1 * s} fill={WHITE} />
        </g>
      );
    case 'big':
      return (
        <g>
          {lash}
          <ellipse cx={x} cy={y} rx={5.8 * s} ry={6.8 * s} fill={WHITE} />
          <circle cx={x + look} cy={y + 1 * s} r={3.8 * s} fill={INK} />
          <circle cx={x + look + 1.4 * s} cy={y - 0.4 * s} r={1.3 * s} fill={WHITE} />
        </g>
      );
    case 'wide':
      return (
        <g>
          {lash}
          <circle cx={x} cy={y} r={6.6 * s} fill={WHITE} />
          <circle cx={x + look} cy={y} r={2.9 * s} fill={INK} />
          <circle cx={x + look + 1 * s} cy={y - 1 * s} r={0.9 * s} fill={WHITE} />
        </g>
      );
    case 'almond':
      return (
        <g>
          {lash}
          <path
            d={`M${x - 6.4 * s} ${y + 0.6 * s} Q${x} ${y - 7 * s} ${x + 6.4 * s} ${y + 0.6 * s} Q${x} ${y + 5 * s} ${x - 6.4 * s} ${y + 0.6 * s} Z`}
            fill={WHITE}
          />
          <circle cx={x + look} cy={y} r={3.2 * s} fill={INK} />
          <circle cx={x + look + 1 * s} cy={y - 1 * s} r={1 * s} fill={WHITE} />
        </g>
      );
    case 'sleepy':
      // A heavy lid over a white eye: relaxed and a little knowing, not bored.
      return (
        <g>
          <ellipse cx={x} cy={y} rx={5.6 * s} ry={6 * s} fill={WHITE} />
          <circle cx={x + look} cy={y + 1.6 * s} r={3.4 * s} fill={INK} />
          <circle cx={x + look + 1.2 * s} cy={y + 0.6 * s} r={1 * s} fill={WHITE} />
          <path
            d={`M${x - 6.4 * s} ${y + 0.4 * s} C${x - 6.4 * s} ${y - 8.4 * s} ${x + 6.4 * s} ${y - 8.4 * s} ${x + 6.4 * s} ${y + 0.4 * s} Z`}
            fill={lid}
          />
          <path
            d={`M${x - 6 * s} ${y + 0.4 * s} L${x + 6 * s} ${y + 0.4 * s}`}
            stroke={INK}
            strokeWidth={2.2 * s}
            strokeLinecap="round"
          />
          {lashes && (
            <path
              d={`M${x + side * 5.6 * s} ${y + 0.4 * s} l${side * 2.6 * s} ${-1.2 * s}`}
              stroke={INK}
              strokeWidth={2 * s}
              strokeLinecap="round"
            />
          )}
        </g>
      );
  }
}

/** Which eyes an expression closes or reshapes. */
export function expressionEyes(
  expression: Expression,
  shape: EyeShape,
): { left: boolean; right: boolean; shape: EyeShape } {
  switch (expression) {
    case 'laugh':
      return { left: true, right: true, shape };
    case 'wink':
      return { left: false, right: true, shape };
    case 'surprised':
      return { left: false, right: false, shape: shape === 'sleepy' ? 'wide' : shape };
    default:
      return { left: false, right: false, shape };
  }
}

const BROW_WIDTH: Record<Brows, number> = { none: 0, thin: 2.4, thick: 3.4, bushy: 4.6 };

/** Brow lift per expression: [inner, outer] for the left brow, then the right. Negative = up. */
function browLift(e: Expression): [number, number, number, number] {
  switch (e) {
    case 'determined':
      return [1.8, -0.8, 1.8, -0.8];
    case 'surprised':
      return [-3.4, -2.4, -3.4, -2.4];
    case 'smirk':
      return [0.6, 0, -2.6, -2.2];
    case 'laugh':
      return [-1.6, -0.6, -1.6, -0.6];
    case 'cheeky':
      return [-2.2, -1.6, 0.8, 0];
    case 'calm':
      return [-0.6, 0.8, -0.6, 0.8];
    default:
      return [0, 0, 0, 0];
  }
}

export function BrowPair({
  style,
  expression,
  ex,
  ey,
  color,
}: {
  style: Brows;
  expression: Expression;
  ex: number;
  ey: number;
  color: string;
}) {
  // A face with no brows still needs them for the expressions that are all brow.
  const w =
    style === 'none'
      ? ['determined', 'surprised', 'smirk'].includes(expression)
        ? 2
        : 0
      : BROW_WIDTH[style];
  if (w === 0) return null;
  const [li, lo, ri, ro] = browLift(expression);
  const by = ey - 10.5;
  const brow = (x: number, side: -1 | 1, inner: number, outer: number) => {
    const ix = x - side * 4.2;
    const ox = x + side * 4.2;
    return `M${ox} ${by + outer + 0.8} Q${x} ${by + (inner + outer) / 2 - 2} ${ix} ${by + inner + 0.8}`;
  };
  return (
    <path
      d={`${brow(-ex, -1, li, lo)} ${brow(ex, 1, ri, ro)}`}
      fill="none"
      stroke={color}
      strokeWidth={w}
      strokeLinecap="round"
    />
  );
}

/** The mouth, centred on x = 0 at `y`. */
export function Mouth({ expression, y }: { expression: Expression; y: number }) {
  const m = y;
  const stroke = { fill: 'none', stroke: MOUTH, strokeWidth: 2.8, strokeLinecap: 'round' } as const;
  switch (expression) {
    case 'happy':
      return <path d={`M-6.5 ${m} Q0 ${m + 6.5} 6.5 ${m}`} {...stroke} />;
    case 'calm':
      return <path d={`M-4.5 ${m + 1} Q0 ${m + 4} 4.5 ${m + 1}`} {...stroke} />;
    case 'determined':
      return <path d={`M-4.5 ${m + 1.5} Q0 ${m + 3.5} 4.5 ${m + 1}`} {...stroke} />;
    case 'smirk':
      return <path d={`M-5 ${m + 1.8} Q1.5 ${m + 4.5} 7 ${m - 1.6}`} {...stroke} />;
    case 'surprised':
      return <ellipse cx="0" cy={m + 2.4} rx="3.4" ry="4.2" fill={MOUTH} />;
    case 'cheeky':
      return (
        <g>
          <path
            d={`M-3.2 ${m + 2.6} L3.2 ${m + 2.6} Q3.2 ${m + 9} 0 ${m + 9} Q-3.2 ${m + 9} -3.2 ${m + 2.6} Z`}
            fill={TONGUE}
          />
          <path d={`M-6.5 ${m} Q0 ${m + 5.4} 6.5 ${m}`} {...stroke} />
        </g>
      );
    case 'grin':
    case 'wink':
    case 'laugh': {
      const big = expression === 'laugh' ? 1.25 : 1;
      const w = 7 * big;
      const d = 8 * big;
      return (
        <g>
          <path
            d={`M${-w} ${m - 1} Q0 ${m + 0.6} ${w} ${m - 1} Q${w - 1} ${m + d} 0 ${m + d} Q${-w + 1} ${m + d} ${-w} ${m - 1} Z`}
            fill={MOUTH}
          />
          {expression === 'grin' && (
            <path
              d={`M${-w + 1.4} ${m - 0.4} Q0 ${m + 1} ${w - 1.4} ${m - 0.4} L${w - 1.8} ${m + 1.8} Q0 ${m + 2.8} ${-w + 1.8} ${m + 1.8} Z`}
              fill={WHITE}
            />
          )}
          <ellipse cx="0" cy={m + d - 2} rx={3.6 * big} ry={2 * big} fill={TONGUE} />
        </g>
      );
    }
  }
}

/** True for the expressions drawn with an open mouth. */
export const openMouth = (e: Expression) =>
  e === 'grin' || e === 'wink' || e === 'laugh' || e === 'surprised' || e === 'cheeky';

/** A beak for the birds, opening for the open-mouthed expressions. */
export function Beak({ y, open, color }: { y: number; open: boolean; color: string }) {
  return (
    <g>
      {open && <path d={`M-5 ${y + 3} Q0 ${y + 13} 5 ${y + 3} Z`} fill={MOUTH} />}
      {open && <ellipse cx="0" cy={y + 8} rx="2.4" ry="1.6" fill={TONGUE} />}
      <path
        d={`M-6 ${y} Q0 ${y - 3.5} 6 ${y} Q2 ${y + 6} 0 ${y + 6.5} Q-2 ${y + 6} -6 ${y} Z`}
        fill={color}
      />
    </g>
  );
}

export function GlassesPair({ kind, ex, ey }: { kind: Glasses; ex: number; ey: number }) {
  if (kind === 'none') return null;
  const lens = (x: number) =>
    kind === 'round' ? (
      <circle cx={x} cy={ey} r="7.6" />
    ) : (
      <rect x={x - 8} y={ey - 6.4} width="16" height="12.4" rx="3.5" />
    );
  return (
    <g fill="#ffffff" fillOpacity="0.18" stroke={INK} strokeWidth="2.2">
      {lens(-ex)}
      {lens(ex)}
      <path d={`M${-ex + 7.6} ${ey - 1} Q0 ${ey - 3.5} ${ex - 7.6} ${ey - 1}`} fill="none" />
    </g>
  );
}
