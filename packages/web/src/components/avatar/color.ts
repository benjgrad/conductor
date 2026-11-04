// Colour helpers for the avatar: pure, on #rrggbb strings.

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const hex = (r: number, g: number, b: number): string =>
  `#${((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).padStart(6, '0')}`;

/** Darken by `f` (0..1), for shadows (neck, ears, collar). */
export function shade(color: string, f: number): string {
  const [r, g, b] = rgb(color);
  return hex(r * (1 - f), g * (1 - f), b * (1 - f));
}

/** Lighten toward white by `f` (0..1), for highlights and muzzles. */
export function tint(color: string, f: number): string {
  const [r, g, b] = rgb(color);
  return hex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
}

/** Euclidean distance in RGB (0..441). */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

/** Relative luminance, roughly (0 = black, 1 = white). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
