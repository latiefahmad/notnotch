/*
 * Notch dimensions per state (CSS px = DIPs, scaled with Windows DPI).
 * Derived from NotchDrop (MIT) and the MacBook notch proportions.
 *
 *   w    width of the black body (without ears)
 *   h    height
 *   r    radius of the bottom corners
 *   ear  radius of the outward-curved "ears" at the top edge
 *   rt   radius of the top corners (0 where the shape hangs from the screen edge)
 */
export interface NotchGeometry {
  w: number;
  h: number;
  r: number;
  ear: number;
  rt: number;
}

/** Header height when open = height of the closed notch. */
export const HEADER_HEIGHT = 32;

/** Tool bar at the bottom of the open notch (like OmniNotch). */
export const DOCK_HEIGHT = 46;

/** Padding when open. Inner radii = r − PADDING (concentric). */
export const PADDING = 16;

/**
 * The line (the idle style, or focus mode's thin strip at the edge, just enough to find it again), `w` long and `h` thick: hanging from the
 * edge with ears, or round all over when `floating` away from it. Hovered it stays a line, just a touch bigger, then opens straight away.
 */
export function lineGeometry(w: number, h: number, floating: boolean, peek: boolean): NotchGeometry {
  const t = peek ? h + 2 : h;
  return { w: peek ? w + 16 : w, h: t, r: t / 2, ear: floating ? 0 : peek ? 3.5 : 3, rt: floating ? t / 2 : 0 };
}

/** Idle at width w and height h: the notch hangs from the edge with ears (MacBook proportions), the capsule is round all over. The notch's corners keep their size at every height. */
export function closedGeometry(style: "notch" | "capsule", w: number, h = 30): NotchGeometry {
  return style === "capsule" ? { w, h, r: h / 2, ear: 0, rt: h / 2 } : { w, h, r: 10, ear: 6, rt: 0 };
}

/** Hover on a closed shape of width w and height h: slightly larger, as feedback. */
export function peekGeometry(style: "notch" | "capsule", w: number, h = 30): NotchGeometry {
  return style === "capsule" ? { w: w + 16, h: h + 4, r: h / 2 + 2, ear: 0, rt: h / 2 + 2 } : { w: w + 16, h: h + 4, r: 12, ear: 7, rt: 0 };
}

/** The notch on a side edge, in its frame: `w` along the edge, `h` away from it (column.ts); hovered it grows like the notch on top. */
export function columnGeometry(w: number, h: number, peek: boolean): NotchGeometry {
  return peek ? { w: w + 16, h: h + 4, r: 12, ear: 7, rt: 0 } : { w, h, r: 10, ear: 6, rt: 0 };
}

/** Open state: size comes from the active tab, radii are fixed; floating (a capsule away from the edge) rounds the top too. */
export function openGeometry(w: number, h: number, floating = false): NotchGeometry {
  return floating ? { w, h, r: 30, ear: 0, rt: 30 } : { w, h, r: 30, ear: 14, rt: 0 };
}
