// The agent avatar: a flat, Duolingo-style character (a person, or now and then an animal) on a
// coloured circle, drawn procedurally as inline SVG and deterministic per seed. No image
// service, no library. Big head, small shoulders, bold eyes and brows: built to read at 24 px.
import { useId } from 'react';
import { luminance, shade, tint } from './color.js';
import { animalHead, BEAK } from './parts-animal.js';
import {
  Beak,
  BrowPair,
  Eye,
  expressionEyes,
  GlassesPair,
  INK,
  Mouth,
  openMouth,
} from './parts-face.js';
import {
  Ears,
  Face,
  faceGeometry,
  FacialHairShape,
  HairBack,
  HairFront,
  HeadAccessoryShape,
  HeadscarfDrape,
  Nose,
} from './parts-human.js';
import { OverNeck, Torso, type BodyGeometry } from './parts-outfit.js';
import { avatarTraits, type AvatarTraits, type Build, type Height } from './traits.js';

export interface AgentAvatarProps {
  /** `CardAgent.seed`: the agent's name (or a legacy ticket id); null ⇒ the neutral avatar. */
  seed: string | null;
  /** Rendered size in px. Default 32. Designed to read at 24 and 80. */
  size?: number;
  /** An accessible name; omitted → decorative (aria-hidden). */
  title?: string;
  className?: string;
  /** @internal The contact sheet and tests: force traits (e.g. a species). */
  overrides?: Partial<AvatarTraits>;
}

/** A flat, friendly character on a coloured circle, deterministic per seed. */
export function AgentAvatar({ seed, size = 32, title, className, overrides }: AgentAvatarProps) {
  if (seed === null) return <UnassignedAvatar size={size} title={title} className={className} />;
  return (
    <SeededAvatar
      traits={avatarTraits(seed, overrides)}
      size={size}
      title={title}
      className={className}
    />
  );
}

interface DrawProps {
  size: number;
  title: string | undefined;
  className: string | undefined;
}

const a11y = (title: string | undefined) => ({
  role: title ? 'img' : undefined,
  'aria-label': title,
  'aria-hidden': title ? undefined : true,
});

/** Nobody assigned yet: a grey silhouette on a grey circle. */
function UnassignedAvatar({ size, title, className }: DrawProps) {
  return (
    <svg
      className={`avatar avatar-unassigned${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      {...a11y(title)}
    >
      <circle cx="32" cy="32" r="32" fill="#d9dce3" />
      <circle cx="32" cy="27" r="12" fill="#a9afbd" />
      <path d="M12 60 C12 47 21 42 32 42 C43 42 52 47 52 60 Z" fill="#a9afbd" />
    </svg>
  );
}

/** Where the head sits and how big it is: a short character is kid-like, a big head low down. */
const STANCE: Record<Height, { headY: number; scale: number; top: number; widthMul: number }> = {
  short: { headY: 49, scale: 1.07, top: 80, widthMul: 0.86 },
  mid: { headY: 45, scale: 1.02, top: 76, widthMul: 1 },
  tall: { headY: 41, scale: 0.94, top: 71, widthMul: 1.06 },
};
const SHOULDERS: Record<Build, { w: number; nw: number }> = {
  slim: { w: 23, nw: 5.5 },
  average: { w: 29, nw: 6.5 },
  broad: { w: 35, nw: 8.5 },
  round: { w: 30, nw: 8 },
};

const BLUSH = '#ff6f86';
const human = (t: AvatarTraits) => t.species === 'human';

function SeededAvatar({ traits: t, size, title, className }: DrawProps & { traits: AvatarTraits }) {
  const clip = useId();
  const stance = STANCE[t.height];
  const shoulders = SHOULDERS[t.build];
  const body: BodyGeometry = {
    top: stance.top,
    w: Math.round(shoulders.w * stance.widthMul * 10) / 10,
    // Animals get a stockier neck, so a slim build doesn't put a rabbit on a stalk.
    nw: human(t) ? shoulders.nw : shoulders.nw + 2.5,
    build: t.build,
  };
  const head = `translate(50 ${stance.headY}) rotate(${t.tilt}) scale(${stance.scale})`;
  const neckTop = stance.headY + 12 * stance.scale;
  const neckColor = shade(t.skin, 0.14);
  const isHuman = human(t);
  const hair = t.hair === 'none' ? null : t.hair;

  return (
    <svg
      className={`avatar${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      {...a11y(title)}
      data-species={t.species}
      data-expression={t.expression}
      data-hair={t.hair}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="100" height="100" fill={t.background} />
        {hair && (
          <g transform={head}>
            <HairBack style={hair} color={t.hairColor} />
          </g>
        )}
        <Torso
          g={body}
          outfit={t.outfit}
          color={t.outfitColor}
          accent={t.outfitAccent}
          neck={neckColor}
        />
        <rect
          x={50 - body.nw}
          y={neckTop}
          width={body.nw * 2}
          height={body.top + 6 - neckTop}
          rx={body.nw * 0.8}
          fill={neckColor}
        />
        <OverNeck g={body} outfit={t.outfit} color={t.outfitColor} accent={t.outfitAccent} />
        {hair === 'headscarf' && (
          <g transform={head}>
            <HeadscarfDrape color={t.outfitAccent} />
          </g>
        )}
        <g transform={head}>{isHuman ? <HumanHead t={t} /> : <AnimalHeadDrawing t={t} />}</g>
      </g>
    </svg>
  );
}

function Cheeks({ x, y, t }: { x: number; y: number; t: AvatarTraits }) {
  return (
    <g>
      {t.blush && (
        <g fill={BLUSH} opacity="0.35">
          <ellipse cx={-x} cy={y} rx="4.6" ry="3.2" />
          <ellipse cx={x} cy={y} rx="4.6" ry="3.2" />
        </g>
      )}
      {t.freckles && (
        <g fill={shade(t.skin, 0.38)}>
          {[-1, 1].map((d) => (
            <g key={d}>
              <circle cx={d * (x - 2)} cy={y - 2} r="0.9" />
              <circle cx={d * (x + 1)} cy={y - 0.5} r="0.9" />
              <circle cx={d * (x - 1)} cy={y + 1.5} r="0.9" />
            </g>
          ))}
        </g>
      )}
    </g>
  );
}

function EyePair({
  t,
  ex,
  ey,
  scale,
  forceOpen,
}: {
  t: AvatarTraits;
  ex: number;
  ey: number;
  scale: number;
  /** Dark fur hides dot eyes: use whites instead. */
  forceOpen: boolean;
}) {
  const lid = shade(t.skin, 0.06);
  const ink = forceOpen ? tint(t.skin, 0.7) : INK;
  const e = expressionEyes(t.expression, t.eyes);
  const shape = forceOpen && (e.shape === 'dot' || e.shape === 'button') ? 'big' : e.shape;
  return (
    <g>
      <Eye
        x={-ex}
        y={ey}
        shape={shape}
        closed={e.left}
        side={-1}
        lashes={t.lashes}
        scale={scale}
        lid={lid}
        ink={ink}
      />
      <Eye
        x={ex}
        y={ey}
        shape={shape}
        closed={e.right}
        side={1}
        lashes={t.lashes}
        scale={scale}
        lid={lid}
        ink={ink}
      />
    </g>
  );
}

function HumanHead({ t }: { t: AvatarTraits }) {
  const { chin, halfWidth } = faceGeometry(t.face);
  const hair = t.hair === 'none' ? 'bald' : t.hair;
  const ex = 9 + t.eyeSpread * 2.5;
  const ey = 1;
  const browColor = shade(t.hairColor, luminance(t.hairColor) > 0.6 ? 0.4 : 0.1);
  return (
    <g>
      {hair !== 'headscarf' && <Ears halfWidth={halfWidth} color={t.skin} />}
      {t.earrings && (
        <g fill="#ffd84a">
          <circle cx={-halfWidth} cy="10.5" r="2.2" />
          <circle cx={halfWidth} cy="10.5" r="2.2" />
        </g>
      )}
      <Face shape={t.face} color={t.skin} />
      <Cheeks x={ex + 5} y={ey + 9.5} t={t} />
      {t.beautyMark && <circle cx={ex + 3} cy="13" r="0.9" fill={INK} />}
      <Nose shape={t.nose} skin={t.skin} />
      <FacialHairShape kind={t.facialHair} color={t.hairColor} chin={chin} />
      <Mouth expression={t.expression} y={Math.round(chin * 0.6 * 10) / 10} />
      <EyePair t={t} ex={ex} ey={ey} scale={1} forceOpen={false} />
      <HairFront style={hair} color={t.hairColor} hat={t.outfitAccent} />
      <BrowPair style={t.brows} expression={t.expression} ex={ex} ey={ey} color={browColor} />
      <GlassesPair kind={t.glasses} ex={ex} ey={ey} />
      <HeadAccessoryShape kind={t.headAccessory} color={t.outfitAccent} />
    </g>
  );
}

function AnimalHeadDrawing({ t }: { t: AvatarTraits }) {
  if (t.species === 'human') return null;
  const a = animalHead(t.species, t.skin);
  const darkFur = luminance(t.skin) < 0.3;
  const onMarkings = t.species === 'penguin' || t.species === 'owl';
  const browColor =
    t.species === 'penguin'
      ? tint(t.skin, 0.35)
      : darkFur
        ? tint(t.skin, 0.55)
        : shade(t.skin, 0.45);
  return (
    <g>
      {a.back}
      {a.face}
      <Cheeks x={a.eyeX + 6} y={a.eyeY + 10} t={t} />
      <EyePair
        t={t}
        ex={a.eyeX}
        ey={a.eyeY}
        scale={a.eyeScale}
        forceOpen={darkFur && !onMarkings}
      />
      {a.front}
      {a.beak ? (
        <Beak y={a.mouthY} open={openMouth(t.expression)} color={BEAK} />
      ) : (
        <g transform={`translate(0 ${a.mouthY}) scale(0.85) translate(0 ${-a.mouthY})`}>
          <Mouth expression={t.expression} y={a.mouthY} />
        </g>
      )}
      <BrowPair
        // A penguin's brows sit on its white mask: keep them light, or every penguin scowls.
        style={t.species === 'penguin' && t.brows !== 'none' ? 'thin' : t.brows}
        expression={t.expression}
        ex={a.eyeX}
        ey={a.eyeY}
        color={browColor}
      />
      <GlassesPair kind={t.glasses} ex={a.eyeX} ey={a.eyeY} />
    </g>
  );
}
