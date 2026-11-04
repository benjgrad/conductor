// The shoulders and the outfit, in frame coordinates (the 100 × 100 viewBox). `top` is where the
// shoulders start and `w` is their half-width, both set by the build and the height.
import { shade, tint } from './color.js';
import type { Build, Outfit } from './traits.js';

export interface BodyGeometry {
  top: number;
  w: number;
  /** Neck half-width. */
  nw: number;
  build: Build;
}

const CX = 50;
const BOTTOM = 104;

function torsoPath({ top, w, build }: BodyGeometry): string {
  const bulge = build === 'round' ? 5 : 0;
  return [
    `M${CX - w} ${BOTTOM}`,
    `L${CX - w - bulge} ${top + 16}`,
    `C${CX - w - bulge} ${top + 3} ${CX - w * 0.55} ${top} ${CX} ${top}`,
    `C${CX + w * 0.55} ${top} ${CX + w + bulge} ${top + 3} ${CX + w + bulge} ${top + 16}`,
    `L${CX + w} ${BOTTOM} Z`,
  ].join(' ');
}

/** The torso and everything on it that sits under the neck. */
export function Torso({
  g,
  outfit,
  color,
  accent,
  neck,
}: {
  g: BodyGeometry;
  outfit: Outfit;
  color: string;
  accent: string;
  /** Neck colour, for the skin showing at the neckline. */
  neck: string;
}) {
  const { top, w, nw } = g;
  const dark = shade(color, 0.2);
  const torso = <path d={torsoPath(g)} fill={outfit === 'overalls' ? accent : color} />;
  const scoop = (
    <path
      d={`M${CX - nw - 2} ${top - 1} Q${CX} ${top + 10} ${CX + nw + 2} ${top - 1} Z`}
      fill={neck}
    />
  );
  switch (outfit) {
    case 'tee':
    case 'stripes':
    case 'scarf':
    case 'turtleneck':
      return (
        <g>
          {torso}
          {outfit === 'stripes' && (
            <g fill={accent}>
              <rect x={CX - w - 6} y={top + 12} width={2 * w + 12} height="5" />
              <rect x={CX - w - 6} y={top + 22} width={2 * w + 12} height="5" />
            </g>
          )}
          {outfit !== 'turtleneck' && scoop}
          {outfit !== 'turtleneck' && (
            <path
              d={`M${CX - nw - 2} ${top - 0.5} Q${CX} ${top + 10} ${CX + nw + 2} ${top - 0.5}`}
              fill="none"
              stroke={dark}
              strokeWidth="2.4"
            />
          )}
        </g>
      );
    case 'vneck':
      return (
        <g>
          {torso}
          <path
            d={`M${CX - nw - 2} ${top - 1} L${CX} ${top + 13} L${CX + nw + 2} ${top - 1} Z`}
            fill={neck}
          />
          <path
            d={`M${CX - nw - 2} ${top - 0.5} L${CX} ${top + 13} L${CX + nw + 2} ${top - 0.5}`}
            fill="none"
            stroke={dark}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
        </g>
      );
    case 'collared':
    case 'tie':
    case 'blouse':
      return (
        <g>
          {torso}
          {scoop}
        </g>
      );
    case 'hoodie':
      return (
        <g>
          {torso}
          <path
            d={`M${CX - nw - 10} ${top + 3} C${CX - nw - 10} ${top - 7} ${CX + nw + 10} ${top - 7} ${CX + nw + 10} ${top + 3} C${CX + nw + 5} ${top + 12} ${CX - nw - 5} ${top + 12} ${CX - nw - 10} ${top + 3} Z`}
            fill={dark}
          />
          {scoop}
          <path
            d={`M${CX - 4} ${top + 7} L${CX - 5} ${top + 20} M${CX + 4} ${top + 7} L${CX + 5} ${top + 20}`}
            stroke={tint(color, 0.7)}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </g>
      );
    case 'overalls':
      return (
        <g>
          {torso}
          {scoop}
          <rect x={CX - w * 0.55} y={top + 13} width={w * 1.1} height="30" rx="4" fill={color} />
          <path
            d={`M${CX - w * 0.5} ${top + 15} L${CX - w * 0.7} ${top + 1} M${CX + w * 0.5} ${top + 15} L${CX + w * 0.7} ${top + 1}`}
            stroke={color}
            strokeWidth="4.5"
            strokeLinecap="round"
          />
          <circle cx={CX - w * 0.38} cy={top + 17} r="1.8" fill={tint(color, 0.6)} />
          <circle cx={CX + w * 0.38} cy={top + 17} r="1.8" fill={tint(color, 0.6)} />
        </g>
      );
    case 'jacket':
      return (
        <g>
          {torso}
          <path
            d={`M${CX - nw - 3} ${top} L${CX + nw + 3} ${top} L${CX + 7} ${BOTTOM} L${CX - 7} ${BOTTOM} Z`}
            fill={accent}
          />
          {scoop}
          <path
            d={`M${CX - nw - 3} ${top} L${CX - 6} ${top + 22} L${CX - 7} ${BOTTOM} M${CX + nw + 3} ${top} L${CX + 6} ${top + 22} L${CX + 7} ${BOTTOM}`}
            fill="none"
            stroke={dark}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
        </g>
      );
  }
}

/** The parts of an outfit that sit over the neck: collars, ties, turtlenecks, scarves. */
export function OverNeck({
  g,
  outfit,
  color,
  accent,
}: {
  g: BodyGeometry;
  outfit: Outfit;
  color: string;
  accent: string;
}) {
  const { top, nw } = g;
  const collar = color === '#f4f1ea' ? accent : '#ffffff';
  switch (outfit) {
    case 'collared':
    case 'tie':
      return (
        <g>
          {outfit === 'tie' && (
            <g fill={accent}>
              <rect x={CX - 3} y={top + 3} width="6" height="5" rx="1.5" />
              <path
                d={`M${CX - 2.6} ${top + 7} L${CX + 2.6} ${top + 7} L${CX + 4.6} ${top + 25} L${CX} ${top + 30} L${CX - 4.6} ${top + 25} Z`}
              />
            </g>
          )}
          <path
            d={`M${CX - nw - 3} ${top - 2} L${CX} ${top + 5} L${CX - nw - 7} ${top + 9} Z M${CX + nw + 3} ${top - 2} L${CX} ${top + 5} L${CX + nw + 7} ${top + 9} Z`}
            fill={collar}
            stroke={collar}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </g>
      );
    case 'blouse':
      return (
        <g fill={collar}>
          <ellipse cx={CX - nw + 1} cy={top + 3} rx="7.5" ry="4.8" />
          <ellipse cx={CX + nw - 1} cy={top + 3} rx="7.5" ry="4.8" />
        </g>
      );
    case 'turtleneck':
      return (
        <rect
          x={CX - nw - 2.5}
          y={top - 9}
          width={2 * nw + 5}
          height="14"
          rx="4"
          fill={shade(color, 0.12)}
        />
      );
    case 'scarf':
      return (
        <g fill={accent}>
          <ellipse cx={CX} cy={top + 1} rx={nw + 9} ry="5.5" />
          <rect
            x={CX + 2}
            y={top + 2}
            width="7"
            height="20"
            rx="2.5"
            transform={`rotate(-12 ${CX + 5} ${top + 2})`}
          />
        </g>
      );
    default:
      return null;
  }
}
