// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/DeckPages.cs (sizes, PanelScales).
// The open panel's size per tool: limits, quick sizes, a drag at an edge, a step of the resize shortcut, and the
// panel scale. Pure; sizes are CSS px before the scale (display.rs zooms the page and grows the window).

export interface Size {
  w: number;
  h: number;
}

/** Largest open panel: the window (760 × 560, tauri.conf.json) less a margin for the hit zone. */
export const PANEL_MAX: Size = { w: 740, h: 540 };
/** Never smaller than this, whatever the tool's default. */
const FLOOR: Size = { w: 360, h: 150 };
/** A tool can shrink to this share of its default; below it its layout breaks. */
const MIN_SHARE = 0.8;

export type QuickSize = "compact" | "standard" | "spacious";
export const QUICK_FACTOR: Record<QuickSize, number> = { compact: 0.85, standard: 1, spacious: 1.2 };

export type Edge = "left" | "right" | "bottom" | "bottom-left" | "bottom-right";
export type Direction = "left" | "right" | "up" | "down";

export interface Limits {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `monitorH`: the monitor's height in CSS px; the panel keeps 20 px free below it. */
export function limits(def: Size, monitorH?: number): Limits {
  const minW = Math.min(PANEL_MAX.w, Math.max(FLOOR.w, Math.round(def.w * MIN_SHARE)));
  const minH = Math.min(PANEL_MAX.h, Math.max(FLOOR.h, Math.round(def.h * MIN_SHARE)));
  const maxH = finite(monitorH) ? Math.min(PANEL_MAX.h, Math.round(monitorH - 20)) : PANEL_MAX.h;
  return { minW, maxW: PANEL_MAX.w, minH, maxH: Math.max(minH, maxH) };
}

export function clampSize(s: Size, l: Limits): Size {
  const w = finite(s.w) ? s.w : l.minW, h = finite(s.h) ? s.h : l.minH;
  return { w: Math.round(Math.min(l.maxW, Math.max(l.minW, w))), h: Math.round(Math.min(l.maxH, Math.max(l.minH, h))) };
}

/** The size a tool opens at: its saved size, else its default, within its limits. */
export function sizeFor(def: Size, saved: Size | undefined, monitorH?: number): Size {
  return clampSize(saved ?? def, limits(def, monitorH));
}

export function quickSize(def: Size, q: QuickSize, monitorH?: number): Size {
  const f = QUICK_FACTOR[q];
  return clampSize({ w: def.w * f, h: def.h * f }, limits(def, monitorH));
}

/** The quick size every tool is at, or null when sizes were dragged by hand. No saved sizes = standard. */
export function currentQuick(defs: Record<string, Size>, saved: Record<string, Size>): QuickSize | null {
  const ids = Object.keys(defs);
  for (const q of Object.keys(QUICK_FACTOR) as QuickSize[]) {
    const all = ids.every((id) => {
      const s = saved[id];
      if (!s) return q === "standard";
      const want = quickSize(defs[id], q);
      return s.w === want.w && s.h === want.h;
    });
    if (all) return q;
  }
  return null;
}

/** A drag at an edge, `dx`/`dy` the pointer's move. The panel stays centred, so a side edge moves the width twice as far. */
export function dragSize(start: Size, edge: Edge, dx: number, dy: number, l: Limits): Size {
  const right = edge === "right" || edge === "bottom-right", left = edge === "left" || edge === "bottom-left";
  const w = start.w + (right ? 2 * dx : left ? -2 * dx : 0);
  const h = start.h + (edge.startsWith("bottom") ? dy : 0);
  return clampSize({ w, h }, l);
}

/** One press of the resize shortcut: left and right change the width, up and down the height. */
export function stepSize(s: Size, dir: Direction, l: Limits, step = 20): Size {
  const dw = dir === "right" ? step : dir === "left" ? -step : 0;
  const dh = dir === "down" ? step : dir === "up" ? -step : 0;
  return clampSize({ w: s.w + dw, h: s.h + dh }, l);
}

export type PanelScale = 100 | 150;
/** Only the two scales the settings offer; anything else is 100 %. */
export function fitScale(v: unknown): PanelScale {
  return v === 150 ? 150 : 100;
}

/*
 * display.offset and display.y are saved at 100 % scale, so a scale change never rewrites (or drifts) them; the page
 * works in CSS px of the current scale, which Rust multiplies by the zoom again.
 */
export function toPageCss(saved: number, scale: number): number {
  return Number.isFinite(saved) ? (saved * 100) / scale : 0;
}

export function toSaved(css: number, scale: number): number {
  return Number.isFinite(css) ? (css * scale) / 100 : 0;
}

/** Saved sizes from a settings file: finite, positive pairs only. */
export function normalizeSizes(v: unknown): Record<string, Size> {
  const out: Record<string, Size> = {};
  if (!v || typeof v !== "object") return out;
  for (const [id, s] of Object.entries(v as Record<string, unknown>)) {
    const { w, h } = (s ?? {}) as Partial<Size>;
    if (finite(w) && finite(h) && w > 0 && h > 0) out[id] = { w: Math.round(w), h: Math.round(h) };
  }
  return out;
}
