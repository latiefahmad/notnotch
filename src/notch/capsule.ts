// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/CollapsedMove.cs and CollapsedHover.cs.
// Pure placement rules of the floating capsule (no DOM, no React): where a drag lands once it snaps, whether the strip up to the screen edge still opens the panel, where the window and the panel sit. x is absolute from the monitor's left edge (the caller converts from and to display.offset). CSS px.

/** gap: held this far from the edges; snapReach: how near a place the capsule has to come to be held there; bridgeMax: the largest gap to the work area's top that is still bridged; windowH: the window's height; panelLift: how far the window starts above a low capsule. */
export const CAPSULE = { gap: 5, snapReach: 12, bridgeMax: 20, windowH: 560, panelLift: 6 } as const;

type Style = "notch" | "capsule" | "line";
/** The monitor's work area, from the monitor's top edge. */
export interface WorkArea { top: number; height: number }

const safe = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The capsule's top for the saved one: kept on the monitor, so on a shorter one it stops at the bottom (the saved value stays as it is). */
export function capsuleY(y: number, h: number, monitorH: number): number {
  return clamp(Number.isFinite(y) ? y : 0, 0, Math.max(0, safe(monitorH) - safe(h)));
}

/** The top of the window: at the screen's top for the notch, the line and a bridged capsule (the strip up to the work area's top has to lie inside the window), else just above the capsule and kept inside the monitor (at 0 on a monitor shorter than the window). */
export function windowYFor(style: Style, y: number, monitorH: number, workTop = 0): number {
  if (Number.isNaN(y) || hasBridge(style, y, workTop)) return 0;
  return clamp(y - CAPSULE.panelLift, 0, Math.max(0, safe(monitorH) - CAPSULE.windowH));
}

/** Whether the strip from the surface up to the screen edge senses the pointer: always for the notch and the line, for the capsule while it stays within bridgeMax of the work area's top. */
export function hasBridge(style: Style, y: number, workTop: number): boolean {
  return style !== "capsule" || y - (Number.isFinite(workTop) ? Math.max(0, workTop) : 0) <= CAPSULE.bridgeMax;
}

type Place = [place: number, guide: number | null];
// The nearest place within snapReach; on a tie the later one wins (the order of the lists below is part of the rule).
function nearest(value: number, places: Place[]): Place | null {
  let best: Place | null = null, dist: number = CAPSULE.snapReach;
  for (const p of places) { const d = Math.abs(value - p[0]); if (d <= dist) { dist = d; best = p; } }
  return best;
}

/** The capsule's top-left corner for the corner the pointer asks for. guideX is the vertical line its centre is held on, guideY the horizontal line its middle or one of its edges is held at; null where nothing holds it that way (a side needs no guide, the edge is the guide). */
export function snapCapsule(x: number, y: number, w: number, h: number, monitorW: number, monitorH: number, work: WorkArea): { x: number; y: number; guideX: number | null; guideY: number | null } {
  w = safe(w); h = safe(h);
  const mw = safe(monitorW), mh = safe(monitorH), top = safe(work.top), wb = top + safe(work.height), right = Math.max(0, mw - w), bottom = Math.max(top, mh - h), gap = CAPSULE.gap;
  x = clamp(Number.isFinite(x) ? x : 0, 0, right);
  y = clamp(Number.isFinite(y) ? y : top, top, bottom);
  let guideX: number | null = null, guideY: number | null = null;
  const sx = nearest(x, [[mw / 2 - w / 2, mw / 2], [gap, null], [right - gap, null]]);
  if (sx) { x = clamp(sx[0], 0, right); guideX = sx[1]; }
  // Above a bottom taskbar the guide is the taskbar's top; at the monitor's bottom (or with no taskbar there) its bottom.
  const places: Place[] = [[top + gap, top], [mh - gap - h, mh], [(top + wb) / 2 - h / 2, (top + wb) / 2]];
  if (wb < mh - 0.5) places.push([wb - gap - h, wb]);
  const sy = nearest(y, places);
  if (sy) { y = clamp(sy[0], top, bottom); guideY = sy[1]; }
  return { x, y, guideX, guideY };
}

/** The panel's top inside the window: from the capsule's top, moved up as far as it takes to fit (0 for a panel taller than the window). */
export function panelTop(capsuleTopInWindow: number, panelH: number): number {
  return clamp(Number.isFinite(capsuleTopInWindow) ? capsuleTopInWindow : 0, 0, Math.max(0, CAPSULE.windowH - safe(panelH)));
}
