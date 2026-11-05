// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/CollapsedGeometry.cs (CollapsedLimits) and Settings.cs (their Fit).
// The sizes of the closed notch, capsule and line: limits, defaults and the repair of saved values, the content scale that follows the
// height, and the window length the widest closed surface needs. Sizes are CSS px before the panel scale (the page is zoomed by it); the
// capsule's distance from the edge (display.y) and the line's are places on the screen, saved at 100 % (panelSize.ts toPageCss). Pure.

import { ROW } from "./row/layout.ts";
import { COLUMN } from "./column.ts";
import { WINDOW } from "./edge.ts";

/** The capsule's distance from the edge is display.y, which dragging sets too. */
export interface ClosedSize {
  notchWidth: number;
  notchHeight: number;
  capsuleWidth: number;
  capsuleHeight: number;
  lineLength: number;
  lineThickness: number;
  lineTop: number;
}

/** The height the row is designed at; the content scale is the surface's height over it. */
export const BASE_HEIGHT = 30;

/**
 * [min, max] of the saved values. The widths are minimums (the content widens the surface) and may be as wide as a monitor; the monitor
 * narrows what is drawn, never the saved value. The heights give a content scale of 0.8 to 2.
 */
export const LIMITS = {
  notchWidth: [72, 8000],
  notchHeight: [24, 60],
  capsuleWidth: [48, 8000],
  capsuleHeight: [24, 60],
  capsuleTop: [0, 8000],
  lineLength: [24, 600],
  lineThickness: [2, 8],
  lineTop: [0, 16],
} as const satisfies Record<keyof ClosedSize | "capsuleTop", readonly [number, number]>;

/** The sizes NotNotch had before they became settings: notch and capsule 188 x 30 (the capsule 5 below the edge, display.y), line 150 x 5 at the edge. */
export const CLOSED_SIZE_DEFAULTS: ClosedSize = {
  notchWidth: ROW.minSurface,
  notchHeight: BASE_HEIGHT,
  capsuleWidth: ROW.minSurface,
  capsuleHeight: BASE_HEIGHT,
  lineLength: 150,
  lineThickness: 5,
  lineTop: 0,
};
export const CAPSULE_TOP_DEFAULT = 5;

const fit = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** The thickness in half px steps, within its limits; a value that is not a number gives the default. */
export function roundThickness(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? fit(Math.round(v * 2) / 2, LIMITS.lineThickness, CLOSED_SIZE_DEFAULTS.lineThickness) : CLOSED_SIZE_DEFAULTS.lineThickness;
}

/** The capsule's saved top (display.y) within its limits. */
export const fitCapsuleTop = (v: unknown) => fit(v, LIMITS.capsuleTop, CAPSULE_TOP_DEFAULT);

/** Whatever was saved (nothing before these settings) becomes valid sizes: each value clamped to its limits, one that is not a number the default. */
export function normalizeClosedSize(saved: unknown): ClosedSize {
  const s = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {}, d = CLOSED_SIZE_DEFAULTS;
  return {
    notchWidth: fit(s.notchWidth, LIMITS.notchWidth, d.notchWidth),
    notchHeight: fit(s.notchHeight, LIMITS.notchHeight, d.notchHeight),
    capsuleWidth: fit(s.capsuleWidth, LIMITS.capsuleWidth, d.capsuleWidth),
    capsuleHeight: fit(s.capsuleHeight, LIMITS.capsuleHeight, d.capsuleHeight),
    lineLength: fit(s.lineLength, LIMITS.lineLength, d.lineLength),
    lineThickness: roundThickness(s.lineThickness),
    lineTop: fit(s.lineTop, LIMITS.lineTop, d.lineTop),
  };
}

/** How much bigger than designed the content of a notch or capsule this high is drawn. */
export const contentScale = (height: number) => (Number.isFinite(height) && height > 0 ? height / BASE_HEIGHT : 1);

/** On a side edge the notch stands as a column along the edge: its shortest length follows the width, the column's own minimum (120) at the default width. */
export const sideLength = (notchWidth: number) => (COLUMN.minLength * notchWidth) / CLOSED_SIZE_DEFAULTS.notchWidth;

/**
 * The window's length along its edge: WINDOW.along, or longer when the widest the closed surface can get needs it, with the room the default
 * keeps around its widest (700) for the hover nudge and the hit zone. That widest is the larger of the saved width and the content's widest
 * at its scale, at most the monitor's `span`. The line opens into the notch for an urgent notice, so it takes the notch's sizes.
 */
export function windowAlong(size: ClosedSize, style: "notch" | "capsule" | "line", side: boolean, span: number): number {
  const capsule = style === "capsule" && !side, k = contentScale(capsule ? size.capsuleHeight : size.notchHeight);
  const widest = side ? Math.max(sideLength(size.notchWidth), COLUMN.maxLength * k) : Math.max(capsule ? size.capsuleWidth : size.notchWidth, ROW.maxSurface * k);
  const room = Number.isFinite(span) && span > 0 ? Math.min(span, widest) : widest;
  return Math.max(WINDOW.along, Math.ceil(room - 1e-9) + WINDOW.along - ROW.maxSurface);
}

/** A grip of the resize mode (ClosedResize.tsx): the two ends of the shape, or its far side from the edge. */
export type ClosedGrip = "start" | "end" | "depth";

/** The sizes each closed style's grips change: the ends its width (the line's length), the far side its height (the line's thickness). */
const GRIP_KEYS = { notch: ["notchWidth", "notchHeight"], capsule: ["capsuleWidth", "capsuleHeight"], line: ["lineLength", "lineThickness"] } as const;

/**
 * The size a resize drag sets. `along` and `depth` are the drag in the notch's frame (edge.ts deltaFromScreen), in page px: the ends move
 * apart by twice the drag, as the shape stays centred, and the far side moves with it. Held to the limits, the width also to `widest`
 * (the monitor), in whole px, the thickness in half px.
 */
export function resizeClosed(start: ClosedSize, style: "notch" | "capsule" | "line", grip: ClosedGrip, along: number, depth: number, widest: number): Partial<ClosedSize> {
  const [width, height] = GRIP_KEYS[style];
  if (grip === "depth") return { [height]: height === "lineThickness" ? roundThickness(start.lineThickness + depth) : fit(Math.round(start[height] + depth), LIMITS[height], start[height]) };
  const [lo, hi] = LIMITS[width];
  const grown = start[width] + (grip === "start" ? -along : along) * 2;
  return { [width]: Math.round(Math.max(lo, Math.min(hi, widest, grown))) };
}

/** The size a double click on a grip goes back to. */
export function defaultClosed(style: "notch" | "capsule" | "line", grip: ClosedGrip): Partial<ClosedSize> {
  const key = GRIP_KEYS[style][grip === "depth" ? 1 : 0];
  return { [key]: CLOSED_SIZE_DEFAULTS[key] };
}
