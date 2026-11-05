// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/EdgeFrame.cs and CollapsedMove.cs.
// The edge the notch and the line hang from. Everything is laid out as if they hung from the top: x runs along the edge and y away from it,
// into the screen (the frame). The frame maps that onto the edge actually used; the shape's content is turned back upright.
// - top: x and y as on the screen. - bottom: y runs up from the edge.
// - left: x runs down the edge, y right from it (the monitor mirrored about its diagonal).
// - right: x runs down the edge, y left from it (the monitor turned a quarter clockwise).
// Pure (no DOM, no React). CSS px, relative to the monitor's top-left corner (screen) or to the frame's origin (frame).

export type Edge = "top" | "bottom" | "left" | "right";
/** What the notch hangs from: the screen's edge (over a taskbar there) or the taskbar's inner edge; auto = the screen on top, the taskbar elsewhere. */
export type Anchor = "auto" | "screen" | "taskbar";
export interface Rect { x: number; y: number; w: number; h: number }
/** The monitor's work area, relative to its top-left corner. */
export interface Work { x: number; y: number; width: number; height: number }

export const EDGES: Edge[] = ["top", "bottom", "left", "right"];
/** How much nearer than the current edge another one has to be before a dragged notch moves there. */
export const EDGE_HYSTERESIS = 32;
/** The window in the frame: as long as on top (tauri.conf.json), and on a side edge as deep as long, so the widest panel (740) fits across. */
export const WINDOW = { along: 760, depth: 560, sideDepth: 760 } as const;

const fin = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const across = (edge: Edge) => edge === "left" || edge === "right";
export const isEdge = (v: unknown): v is Edge => EDGES.includes(v as Edge);
export const isAnchor = (v: unknown): v is Anchor => v === "auto" || v === "screen" || v === "taskbar";

/** The window's size on the screen for an edge. */
export function windowSize(edge: Edge): { w: number; h: number } {
  return across(edge) ? { w: WINDOW.sideDepth, h: WINDOW.along } : { w: WINDOW.along, h: WINDOW.depth };
}

/** Where the window's own edge lies in it, for frameCss: the window is placed with that edge on the frame's line (display.rs). */
export const windowLine = (edge: Edge) => (edge === "bottom" ? WINDOW.depth : edge === "right" ? WINDOW.sideDepth : 0);

/** The saved choice (settings `dock`). */
export interface Dock { edge: Edge; anchor: Anchor }
export const DOCK_DEFAULTS: Dock = { edge: "top", anchor: "auto" };
/** Whatever was saved becomes a valid choice. */
export function normalizeDock(saved: unknown): Dock {
  const s = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  return { edge: isEdge(s.edge) ? s.edge : DOCK_DEFAULTS.edge, anchor: isAnchor(s.anchor) ? s.anchor : DOCK_DEFAULTS.anchor };
}

export const overTaskbar =(edge: Edge, anchor: Anchor) => (anchor === "auto" ? edge === "top" : anchor === "screen");

/** Whether a taskbar takes part of the screen along an edge: there the screen's edge and the work area's differ. */
export function hasTaskbar(edge: Edge, screenW: number, screenH: number, work: Work): boolean {
  switch (edge) {
    case "bottom": return work.y + work.height < fin(screenH) - 0.5;
    case "left": return work.x > 0.5;
    case "right": return work.x + work.width < fin(screenW) - 0.5;
    default: return work.y > 0.5;
  }
}

/** Where the frame starts on the screen's axis across the edge (y for top and bottom, x for the sides). */
export function edgeLine(edge: Edge, anchor: Anchor, screenW: number, screenH: number, work: Work): number {
  const w = fin(screenW), h = fin(screenH);
  const valid = [work.x, work.y, work.width, work.height].every(Number.isFinite) && work.width > 0 && work.height > 0;
  const over = overTaskbar(edge, anchor) || !valid;
  switch (edge) {
    case "bottom": return over ? h : clamp(work.y + work.height, 0, h);
    case "left": return over ? 0 : clamp(work.x, 0, w);
    case "right": return over ? w : clamp(work.x + work.width, 0, w);
    default: return over ? 0 : clamp(work.y, 0, h);
  }
}

export interface Frame { edge: Edge; screenW: number; screenH: number; line: number }

export function frameFor(edge: Edge, anchor: Anchor, screenW: number, screenH: number, work: Work): Frame {
  return { edge: isEdge(edge) ? edge : "top", screenW: fin(screenW), screenH: fin(screenH), line: edgeLine(edge, anchor, screenW, screenH, work) };
}

/** The length of the frame's edge: the span a notch's centre moves along. */
export const span = (edge: Edge, screenW: number, screenH: number) => (across(edge) ? fin(screenH) : fin(screenW));

/** A screen rectangle in the frame. */
export function fromScreen(f: Frame, r: Rect): Rect {
  switch (f.edge) {
    case "bottom": return { x: r.x, y: f.line - (r.y + r.h), w: r.w, h: r.h };
    case "left": return { x: r.y, y: r.x - f.line, w: r.h, h: r.w };
    case "right": return { x: r.y, y: f.line - (r.x + r.w), w: r.h, h: r.w };
    default: return { x: r.x, y: r.y - f.line, w: r.w, h: r.h };
  }
}

/** A frame rectangle on the screen. */
export function toScreen(f: Frame, r: Rect): Rect {
  switch (f.edge) {
    case "bottom": return { x: r.x, y: f.line - (r.y + r.h), w: r.w, h: r.h };
    case "left": return { x: r.y + f.line, y: r.x, w: r.h, h: r.w };
    case "right": return { x: f.line - (r.y + r.h), y: r.x, w: r.h, h: r.w };
    default: return { x: r.x, y: r.y + f.line, w: r.w, h: r.h };
  }
}

/** A frame point (along, depth) on the screen. */
export function pointToScreen(f: Frame, along: number, depth: number): { x: number; y: number } {
  const r = toScreen(f, { x: along, y: depth, w: 0, h: 0 });
  return { x: r.x, y: r.y };
}

/** A movement on the screen (a drag) as a movement in the frame. */
export function deltaFromScreen(edge: Edge, dx: number, dy: number): { x: number; y: number } {
  switch (edge) {
    case "bottom": return { x: dx, y: -dy };
    case "left": return { x: dy, y: dx };
    case "right": return { x: dy, y: -dx };
    default: return { x: dx, y: dy };
  }
}

/** Linear part of the frame-to-screen mapping as CSS matrix(a, b, c, d): x' = a x + c y, y' = b x + d y. */
const LINEAR: Record<Edge, [number, number, number, number]> = { top: [1, 0, 0, 1], bottom: [1, 0, 0, -1], left: [0, 1, 1, 0], right: [0, 1, -1, 0] };
/** Its inverse, which sets content upright. */
const UPRIGHT: Record<Edge, [number, number, number, number]> = { top: [1, 0, 0, 1], bottom: [1, 0, 0, -1], left: [0, 1, 1, 0], right: [0, -1, 1, 0] };

/** The CSS transform (origin 0 0) that draws the frame with its edge at `line` in the view (y for the bottom, x for the sides); undefined on top, where nothing changes. */
export function frameCss(edge: Edge, line: number): string | undefined {
  if (edge === "top") return undefined;
  const [a, b, c, d] = LINEAR[edge], e = across(edge) ? fin(line) : 0, f = edge === "bottom" ? fin(line) : 0;
  return `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
}

/** The CSS transform (around the centre) that turns content back upright; undefined on top. */
export function uprightCss(edge: Edge): string | undefined {
  if (edge === "top") return undefined;
  const [a, b, c, d] = UPRIGHT[edge];
  return `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;
}

/** Applies a linear map to a vector; for tests (the frame and upright maps compose to the identity). */
export function applyLinear(m: [number, number, number, number], x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}
export const linear = (edge: Edge) => LINEAR[edge];
export const upright = (edge: Edge) => UPRIGHT[edge];

/** The edge a dragged notch hangs from for a pointer at (x, y): the nearest side of the screen, unless the current one is less than EDGE_HYSTERESIS farther. */
export function nearestEdge(x: number, y: number, screenW: number, screenH: number, current: Edge): Edge {
  const dist = (e: Edge) => (e === "bottom" ? Math.abs(fin(screenH) - y) : e === "left" ? Math.abs(x) : e === "right" ? Math.abs(fin(screenW) - x) : Math.abs(y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return current;
  let nearest = current, best = dist(current) - EDGE_HYSTERESIS;
  for (const e of EDGES) {
    const d = dist(e);
    if (d < best) { best = d; nearest = e; }
  }
  return nearest;
}

/** What a notch dragged to an edge hangs from: the screen's edge while the pointer is over the taskbar there, the taskbar's inner edge otherwise; null where no taskbar is on that edge. */
export function anchorAt(edge: Edge, x: number, y: number, screenW: number, screenH: number, work: Work): "screen" | "taskbar" | null {
  if (!hasTaskbar(edge, screenW, screenH, work)) return null;
  const over = edge === "bottom" ? y > work.y + work.height : edge === "left" ? x < work.x : edge === "right" ? x > work.x + work.width : y < work.y;
  return over ? "screen" : "taskbar";
}

/** Where a point lies along an edge. */
export const alongOf = (edge: Edge, x: number, y: number) => (across(edge) ? y : x);

/** A client rectangle (left, top, right, bottom) of something hanging from the edge: how far a pointer is from the edge side, and how far along from its centre. */
export function pointerIn(edge: Edge, r: { left: number; top: number; right: number; bottom: number }, x: number, y: number): { depth: number; along: number } {
  const along = across(edge) ? y - (r.top + r.bottom) / 2 : x - (r.left + r.right) / 2;
  const depth = edge === "bottom" ? r.bottom - y : edge === "left" ? x - r.left : edge === "right" ? r.right - x : y - r.top;
  return { depth, along };
}
