// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/ThemeColor.cs and ColorMath.cs.

/**
 * Colour maths for the themes: parsing, WCAG 2 contrast and the readability correction.
 * Channels are 0 to 255 integers, alpha is 0 to 1.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** A background a colour is drawn on and the contrast it must keep there. */
export interface ContrastNeed {
  background: Rgba;
  minimum: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const byte = (v: number) => Math.round(clamp(v, 0, 255));

/**
 * `#rgb`, `#rrggbb`, `#rrggbbaa` (CSS order, alpha last), `rgb(r g b / a)`, `rgb(r, g, b)` and
 * `hsl(h s% l%)` (what the cover accent produces). Anything else is null.
 */
export function parseColor(text: unknown): Rgba | null {
  if (typeof text !== "string") return null;
  const s = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (![r, g, b, a].every(Number.isFinite) || Math.max(r, g, b) > 255 || a > 1) return null;
    return { r: byte(r), g: byte(g), b: byte(b), a };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*([\d.]+))?\s*\)$/.exec(s);
  if (m) {
    const [h, sat, l] = [m[1], m[2], m[3]].map(Number);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (![h, sat, l, a].every(Number.isFinite) || sat > 100 || l > 100 || a > 1) return null;
    return { ...fromHsl(h, sat / 100, l / 100), a };
  }
  return null;
}

/** Opaque as `#rrggbb`, translucent as `rgb(r g b / a)` (the form tokens.css uses). */
export function formatColor(c: Rgba): string {
  if (c.a >= 1) return toHex(c);
  return `rgb(${c.r} ${c.g} ${c.b} / ${Math.round(c.a * 1000) / 1000})`;
}

/** `#rrggbb`, alpha dropped. */
export function toHex(c: Rgba): string {
  return "#" + [c.r, c.g, c.b].map((v) => byte(v).toString(16).padStart(2, "0")).join("");
}

export const withAlpha = (c: Rgba, a: number): Rgba => ({ ...c, a: clamp(a, 0, 1) });

/** This colour drawn over an opaque background. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  if (top.a >= 1) return top;
  const blend = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a: 1 };
}

/** Channel by channel from one colour to another, alpha included. */
export function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  const t = clamp(amount, 0, 1);
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return { r: Math.round(lerp(from.r, to.r)), g: Math.round(lerp(from.g, to.g)), b: Math.round(lerp(from.b, to.b)), a: lerp(from.a, to.a) };
}

const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/** WCAG 2 contrast; a translucent foreground is first laid over the background, a translucent background over black. */
export function contrast(fg: Rgba, bg: Rgba): number {
  const bottom = over(bg, BLACK);
  const a = luminance(over(fg, bottom));
  const b = luminance(bottom);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The lowest ratio of contrast to minimum over all needs: 1 or more means every need passes. */
export function contrastScore(c: Rgba, needs: ContrastNeed[]): number {
  let lowest = Infinity;
  for (const n of needs) lowest = Math.min(lowest, contrast(c, n.background) / n.minimum);
  return lowest;
}

export const isDark = (background: Rgba) => luminance(over(background, BLACK)) < 0.18;

const STEPS = 256;

/**
 * The nearest colour of the same hue and saturation that meets every need. A colour that already
 * passes comes back unchanged, so a theme that passes looks exactly as written. Lightness moves in
 * whichever direction needs the smaller step, found on a scan of 256 steps and refined by bisection.
 * When no lightness meets every need (backgrounds both light and dark), the lightness with the best
 * worst case is used, never one worse than the colour as written. A translucent colour that has to
 * move is settled over the first background and comes back opaque.
 */
export function ensureContrast(c: Rgba, needs: ContrastNeed[]): Rgba {
  if (needs.length === 0 || contrastScore(c, needs) >= 1) return c;
  const [h, s, l] = toHsl(over(c, over(needs[0].background, BLACK)));
  const passes = (lightness: number) => contrastScore(fromHsl(h, s, lightness), needs) >= 1;
  let best: number | null = null;
  for (const dir of [1, -1]) {
    for (let i = 1; i <= STEPS; i++) {
      const at = clamp(l + (dir * i) / STEPS, 0, 1);
      if (passes(at)) {
        let fail = l + (dir * (i - 1)) / STEPS;
        let pass = at;
        for (let k = 0; k < 12; k++) {
          const mid = (fail + pass) / 2;
          if (passes(mid)) pass = mid;
          else fail = mid;
        }
        if (best === null || Math.abs(pass - l) < Math.abs(best - l)) best = pass;
        break;
      }
      if (at === 0 || at === 1) break;
    }
  }
  if (best !== null) return fromHsl(h, s, best);
  let top = contrastScore(c, needs);
  let found: number | null = null;
  for (let i = 0; i <= STEPS; i++) {
    const score = contrastScore(fromHsl(h, s, i / STEPS), needs);
    if (score > top) {
      top = score;
      found = i / STEPS;
    }
  }
  return found === null ? c : fromHsl(h, s, found);
}

/** Hue in degrees 0 to 360, saturation and lightness 0 to 1. */
export function toHsl(c: Rgba): [number, number, number] {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, clamp(s, 0, 1), l];
}

export function fromHsl(h: number, s: number, l: number): Rgba {
  l = clamp(l, 0, 1);
  s = clamp(s, 0, 1);
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a: 1 };
}

/** For the colour picker: hue 0 to 360, saturation and value 0 to 1. Grays report hue 0; the picker keeps its own hue for them. */
export function toHsv(c: Rgba): [number, number, number] {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [h < 0 ? h + 360 : h, max === 0 ? 0 : d / max, max];
}

export function fromHsv(h: number, s: number, v: number): Rgba {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1);
  v = clamp(v, 0, 1);
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a: 1 };
}
