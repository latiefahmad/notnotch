import { createStore } from "../../lib/store";
import { FONTS } from "../../features/themes/themes";

// Text widths for the closed row, from a canvas (no layout pass). Not a pure module: it needs the DOM.

/** text-footnote font-medium, the row's text (live bindings: setRowFamily changes them). */
export let ROW_FONT = `500 12px ${FONTS.inter}`;
/** text-caption font-medium, the FPS label. */
export let CAPTION_FONT = `500 11px ${FONTS.inter}`;

const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null = null;

/** Bumped when a font finishes loading: widths measured before were taken with a fallback face. */
export const fontEpoch = createStore(0);
document.fonts?.addEventListener("loadingdone", () => {
  cache.clear();
  fontEpoch.set((n) => n + 1);
});

/** The font chosen in Themes: widths measured before were taken with the old one. */
export function setRowFamily(family: string) {
  ROW_FONT = `500 12px ${family}`;
  CAPTION_FONT = `500 11px ${family}`;
  cache.clear();
  fontEpoch.set((n) => n + 1);
}

/** Width in CSS px, rounded up so a reserved box never clips its text. */
export function measureText(text: string, font = ROW_FONT): number {
  const key = `${font}\n${text}`;
  let w = cache.get(key);
  if (w === undefined) {
    ctx ??= document.createElement("canvas").getContext("2d");
    if (!ctx) return 0;
    ctx.font = font;
    w = Math.ceil(ctx.measureText(text).width);
    // One entry per song title over a long session; start over rather than grow without end.
    if (cache.size > 500) cache.clear();
    cache.set(key, w);
  }
  return w;
}
