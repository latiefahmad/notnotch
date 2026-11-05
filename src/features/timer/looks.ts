/*
 * Timer looks: what the big countdown shows per style. Pure, no React, so it can be tested
 * (looks.test.ts) and shared by the Timer tool, the detached window and the settings preview.
 */

export const TIMER_LOOKS = ["clean", "pixel", "dots", "retro", "terminal", "zen", "hud", "flip", "nixie", "ring", "lcd", "analog"] as const;
export type TimerLook = (typeof TIMER_LOOKS)[number];

/** German id for t(), English in en.json. */
export const lookLabels: Record<TimerLook, string> = {
  clean: "Schlicht",
  pixel: "Pixel-Abend",
  dots: "Punkte",
  retro: "Retro-Uhr",
  terminal: "Fokus-Terminal",
  zen: "Zen",
  hud: "Cyber-HUD",
  flip: "Klappzahlen",
  nixie: "Nixie",
  ring: "Ring",
  lcd: "LCD",
  analog: "Analog",
};

export function normalizeLook(v: unknown): TimerLook {
  return TIMER_LOOKS.includes(v as TimerLook) ? (v as TimerLook) : "clean";
}

/** Colours of the focus timer and of the clock (Settings, Timer); a break stays green. */
export const LOOK_COLORS = ["orange", "red", "amber", "yellow", "green", "teal", "sky", "blue", "indigo", "violet", "pink", "accent", "white"] as const;
export type LookColor = (typeof LOOK_COLORS)[number];

/** German id for t(), English in en.json. */
export const lookColorLabels: Record<LookColor, string> = {
  orange: "Orange",
  red: "Rot",
  amber: "Bernstein",
  yellow: "Gelb",
  green: "Grün",
  teal: "Türkis",
  sky: "Himmelblau",
  blue: "Blau",
  indigo: "Indigo",
  violet: "Violett",
  pink: "Pink",
  accent: "Theme-Akzent",
  white: "Weiß",
};

/** The CSS colour: orange is the theme's warning colour, as before; the rest are the coloured-icon hues held to 3:1 by the theme. */
export function lookTint(c: LookColor): string {
  if (c === "orange") return "var(--color-orange)";
  if (c === "accent") return "var(--theme-accent)";
  if (c === "white") return "var(--color-label)";
  return `var(--hue-${c})`;
}

/** A focus timer in its chosen colour, a break in green. */
export const modeTint = (mode: string, color: LookColor) => (mode === "focus" ? lookTint(color) : "var(--color-green)");

export function normalizeLookColor(v: unknown, fallback: LookColor): LookColor {
  return LOOK_COLORS.includes(v as LookColor) ? (v as LookColor) : fallback;
}

/** The Overview clock: its usual text ("standard") or one of the timer looks. */
export type ClockLook = "standard" | TimerLook;

/** Clock text in ASCII digits, which the pixel and segment fonts draw: "07:05" or, on a 12 hour clock, "7:05". */
export function clockText(hours: number, minutes: number, h12: boolean): string {
  return `${h12 ? hours % 12 || 12 : pad(hours)}:${pad(minutes)}`;
}

export function normalizeClockLook(v: unknown): ClockLook {
  return TIMER_LOOKS.includes(v as TimerLook) ? (v as TimerLook) : "standard";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Elapsed share 0..1. */
export function progressOf(remaining: number, duration: number): number {
  if (duration <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - remaining / duration));
}

/**
 * Main text of a look. Whole seconds round up, so a countdown never shows 0 while time is left.
 * - clean, pixel, dots: "24:59" (minutes may pass 59, the timer allows up to 180 min)
 * - retro: "24:59", from one hour "1:05:00"
 * - terminal: always "00:24:59"
 * - hud: tenths, "24:59.9"
 * - zen: see zenParts
 */
export function lookText(look: TimerLook, seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-9));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  switch (look) {
    case "retro":
    case "lcd":
      return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    case "terminal":
      return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    case "hud": {
      const tenths = Math.max(0, Math.ceil(seconds * 10 - 1e-6));
      const whole = Math.floor(tenths / 10);
      return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}.${tenths % 10}`;
    }
    case "zen": {
      const z = zenParts(seconds);
      return `${z.value} ${z.unit}`;
    }
    default:
      return `${Math.floor(s / 60)}:${pad(sec)}`;
  }
}

/** Zen: only minutes (rounded up), the last minute in seconds. */
export function zenParts(seconds: number): { value: number; unit: "min" | "s" } {
  const s = Math.max(0, Math.ceil(seconds - 1e-9));
  return s < 60 ? { value: s, unit: "s" } : { value: Math.ceil(s / 60), unit: "min" };
}

/** Cells still lit out of `cells` for the remaining time; at least one while time is left. */
export function litCells(remaining: number, duration: number, cells: number): number {
  if (remaining <= 0 || duration <= 0) return 0;
  return Math.min(cells, Math.max(1, Math.ceil((remaining / duration) * cells - 1e-9)));
}

/** Width of a time like "24:59" in em of a tabular font: digits about 0.6 em, separators 0.3 em. For the Ring look's capsule. */
export function timeWidth(text: string): number {
  return [...text].reduce((w, c) => w + (/\d/.test(c) ? 0.6 : 0.3), 0);
}

/** Analog clock: hand angles in degrees from 12 o'clock for "H:MM" or "HH:MM"; null for anything else. */
export function handAngles(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const minutes = Number(m[2]);
  return { hour: ((Number(m[1]) % 12) + minutes / 60) * 30, minute: minutes * 6 };
}

/** Analog timer: the slice of time still left, from 12 o'clock clockwise, as an SVG path around (0, 0). */
export function slicePath(left: number, r: number): string {
  if (left <= 0) return "";
  if (left >= 1) return `M0,${-r}A${r},${r} 0 1 1 0,${r}A${r},${r} 0 1 1 0,${-r}Z`;
  const a = left * 2 * Math.PI;
  const x = +(r * Math.sin(a)).toFixed(3);
  const y = +(-r * Math.cos(a)).toFixed(3);
  return `M0,0L0,${-r}A${r},${r} 0 ${left > 0.5 ? 1 : 0} 1 ${x},${y}Z`;
}

/** Terminal progress bar of the elapsed time, ASCII so every monospace font lines it up. */
export function terminalBar(remaining: number, duration: number, width: number): string {
  const done = Math.round(progressOf(remaining, duration) * width);
  return `[${"#".repeat(done)}${"-".repeat(width - done)}]`;
}

/** 3x5 pixel font, rows top to bottom, "1" = lit. The colon is one column wide. */
const PIXEL_FONT: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ":": ["0", "1", "0", "1", "0"],
};

/** Text as a pixel matrix (5 rows), one blank column between characters. Unknown characters are skipped. */
export function pixelMatrix(text: string): boolean[][] {
  const glyphs = [...text].map((c) => PIXEL_FONT[c]).filter(Boolean);
  return [0, 1, 2, 3, 4].map((row) => {
    const out: boolean[] = [];
    glyphs.forEach((g, i) => {
      if (i > 0) out.push(false);
      for (const bit of g[row]) out.push(bit === "1");
    });
    return out;
  });
}

/** Seven segments per digit: a top, b top right, c bottom right, d bottom, e bottom left, f top left, g middle. */
export const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abdeg",
  "3": "abcdg",
  "4": "bcfg",
  "5": "acdfg",
  "6": "acdefg",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};
