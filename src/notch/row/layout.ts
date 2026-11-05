// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/CompactSpacing.cs.
// Pure layout rules of the collapsed row (no DOM, no React): which carousel items fit whole, how the row's parts are spread, what gets dropped when it is too narrow. Scale 1, CSS px.

const EPS = 1e-6, MAX_GAP_UNITS = 2;
const safe = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

export const ROW = { unit: 8, maxGap: 16, titleMax: 160, titleMin: 18, maxSurface: 700, minSurface: 188, insetNotch: 28, insetCapsule: 15 } as const;

export interface CarouselWindow { count: number; window: number; gaps: number; travel: number }
const none = (): CarouselWindow => ({ count: 0, window: 0, gaps: 0, travel: 0 });

/** How far the strip moves for its second rest: to the left edge of the item from which none crosses the window's right edge, the one that shows the furthest item whole (0 when the first rest already does). */
function travel(widths: number[], gap: number, win: number): number {
  const n = widths.length, lefts: number[] = [];
  for (let i = 0, x = 0; i < n; i++) { lefts.push(x); x += safe(widths[i]) + gap; }
  let furthest = -1, best = 0;
  for (let j = 0; j < n; j++) {
    const edge = lefts[j] + win;
    let k = j - 1, clean = true;
    for (let i = j; i < n && clean; i++) {
      if (lefts[i] + safe(widths[i]) <= edge + EPS) k = i;
      else clean = lefts[i] >= edge - EPS;
    }
    if (clean && k > furthest) { furthest = k; best = lefts[j]; }
  }
  return best;
}

/** The most whole items from the first that fit in `span`, and the window they need. Zero when no window in the span can show both the first and the last item whole. */
export function carouselWindow(widths: number[], gap: number, span: number): CarouselWindow {
  const n = widths.length;
  if (n === 0 || !Number.isFinite(span) || span <= 0) return none();
  const g = safe(gap);
  let count = 0, window = 0;
  for (let i = 0; i < n; i++) {
    const next = window + (i > 0 ? g : 0) + safe(widths[i]);
    if (next > span + EPS) break;
    window = next; count++;
  }
  if (count === 0 || count === n) return { count, window, gaps: Math.max(0, count - 1), travel: 0 };
  const last = safe(widths[n - 1]);
  // Widened to the last item, the window still ends before the next of the first items begins.
  if (last > window && last <= Math.min(span, window + g) + EPS) return { count, window: last, gaps: 0, travel: travel(widths, g, last) };
  // A window narrower than the last item would leave it out of both rests.
  return last <= window + EPS ? { count, window, gaps: count - 1, travel: travel(widths, g, window) } : none();
}

/** The narrowest window a carousel of these items can take; 0 without items. */
export function minimumWindow(widths: number[], gap: number): number {
  const g = safe(gap), last = widths.length ? safe(widths[widths.length - 1]) : 0;
  let prefix = 0;
  for (let i = 0; i < widths.length; i++) {
    prefix += (i > 0 ? g : 0) + safe(widths[i]);
    if (last > prefix) { const own = carouselWindow(widths, gap, last); if (own.count > 0) return own.window; }
    const fit = carouselWindow(widths, gap, prefix);
    if (fit.count > 0) return fit.window;
  }
  return 0;
}

/** The windows a carousel can take, narrowest first, each one more step of whole items than the one before. */
export function windowSteps(widths: number[], gap: number): number[] {
  const g = safe(gap), minimum = minimumWindow(widths, gap), steps: number[] = minimum > 0 ? [minimum] : [];
  let prefix = 0;
  for (let i = 0; i < widths.length; i++) {
    prefix += (i > 0 ? g : 0) + safe(widths[i]);
    if (prefix <= minimum + EPS) continue;
    const fit = carouselWindow(widths, gap, prefix);
    if (fit.count > 0 && fit.window > (steps.at(-1) ?? 0) + EPS) steps.push(fit.window);
  }
  return steps;
}

/**
 * Two carousels share one room: both take their narrowest window first, then widen by turns (the one showing fewer items first), one whole step at a time.
 * A step that does not fit is never skipped for a later one, so neither shows fewer items as the room grows.
 */
export function share(first: number[], firstGap: number, second: number[], secondGap: number, room: number): { first: CarouselWindow; second: CarouselWindow } {
  room = Number.isFinite(room) ? Math.max(0, room) : 0;
  const a = windowSteps(first, firstGap), b = windowSteps(second, secondGap);
  let ia = -1, ib = -1;
  if (a.length && b.length && a[0] + b[0] <= room + EPS) ia = ib = 0;
  else if (a.length && a[0] <= room + EPS) ia = 0;
  else if (b.length && b[0] <= room + EPS) ib = 0;
  const shown = (widths: number[], gap: number, steps: number[], i: number) => (i < 0 ? 0 : carouselWindow(widths, gap, steps[i]).count);
  // One shown alone for want of room keeps its narrowest window, so they only widen while both show or one has nothing to show.
  let together = (ia >= 0 || a.length === 0) && (ib >= 0 || b.length === 0);
  while (together) {
    const canA = ia >= 0 && ia + 1 < a.length, canB = ib >= 0 && ib + 1 < b.length;
    if (!canA && !canB) break;
    const takeA = canA && (!canB || shown(first, firstGap, a, ia) <= shown(second, secondGap, b, ib));
    const used = (ia < 0 ? 0 : a[ia]) + (ib < 0 ? 0 : b[ib]);
    if ((takeA ? used - a[ia] + a[ia + 1] : used - b[ib] + b[ib + 1]) > room + EPS) break;
    if (takeA) ia++; else ib++;
  }
  return { first: ia < 0 ? none() : carouselWindow(first, firstGap, a[ia]), second: ib < 0 ? none() : carouselWindow(second, secondGap, b[ib]) };
}

export interface Placement { left: number[]; room: number[]; gap: number }

/**
 * Where each part stands, in device pixels so every gap is exactly the same. The room the parts leave is handed out in this order:
 * the title up to its text but at most titleMax, every gap alike up to two units, the title again up to its text, the rest as centring.
 * `title` is the index of the title part (-1 for none), whose room is worked out and whose entry in `parts` is ignored.
 */
export function arrange(parts: number[], title: number, titleText: number, titleShortest: number, width: number, unit: number, dpi: number): Placement {
  dpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 1;
  const n = parts.length, left: number[] = [], room: number[] = new Array(n).fill(0);
  const px = (dips: number) => (Number.isFinite(dips) && dips > 0 ? dips * dpi : 0);
  const available = Math.floor(px(width) + EPS), hasTitle = title >= 0 && title < n, gaps = Math.max(0, n - 1);
  let u = Math.round(px(unit)), fixedRoom = 0;
  for (let i = 0; i < n; i++) if (i !== title) fixedRoom += room[i] = Math.ceil(px(parts[i]) - EPS);
  // The title keeps its shortest room (or its text, if shorter); parts rounded to whole pixels may come to a pixel or two more than the row, and the gaps give that up, alike.
  const want = Math.ceil(px(titleText) - EPS), shortest = hasTitle ? Math.min(want, Math.round(px(titleShortest))) : 0;
  if (available - fixedRoom - shortest - u * gaps < 0 && gaps > 0) u = Math.max(0, Math.floor((available - fixedRoom - shortest) / gaps));
  let free = Math.max(0, available - fixedRoom - u * gaps);
  const maxExtra = Math.floor(u * (MAX_GAP_UNITS - 1));
  const extraFor = (rest: number) => (gaps > 0 ? Math.max(0, Math.min(maxExtra, Math.floor(rest / gaps + 1e-9))) : 0);
  if (hasTitle) {
    let titleRoom = Math.floor(Math.min(free, Math.max(shortest, Math.min(want, Math.round(px(ROW.titleMax))))));
    let rest = free - titleRoom;
    rest -= extraFor(rest) * gaps;
    if (want > titleRoom) titleRoom += Math.floor(Math.max(0, Math.min(rest, want - titleRoom)));
    room[title] = titleRoom;
    free -= titleRoom;
  }
  const extra = extraFor(free), gap = u + extra;
  free -= extra * gaps;
  let x = Math.floor(Math.max(0, free) / 2);
  for (let i = 0; i < n; i++) { left.push(x / dpi); x += room[i] + gap; room[i] /= dpi; }
  return { left, room, gap: gap / dpi };
}

export type RowItem =
  | { id: string; kind: "fixed"; width: number }
  | { id: "title"; kind: "title"; text: number }
  | { id: "rings" | "readings"; kind: "carousel"; items: number[]; gap: number };
type TitleItem = Extract<RowItem, { kind: "title" }>;
type CarouselItem = Extract<RowItem, { kind: "carousel" }>;
export interface PlacedPart { id: string; left: number; width: number; window?: CarouselWindow }
export interface RowPlan { parts: PlacedPart[]; gap: number; dropped: string[] }

const gapsOf = (items: RowItem[]) => ROW.unit * Math.max(0, items.length - 1);
const fixedOf = (items: RowItem[]) => items.reduce((sum, it) => sum + (it.kind === "fixed" ? safe(it.width) : 0), 0);
const fullWindow = (items: number[], gap: number) => items.reduce((sum, w, i) => sum + safe(w) + (i > 0 ? safe(gap) : 0), 0);

/** The narrowest the row can be: fixed parts, the title's shortest room, every carousel at its narrowest window, one unit between parts. Rounded up so rounding never takes a part away. */
export function requiredWidth(items: RowItem[]): number {
  let width = fixedOf(items) + gapsOf(items);
  for (const it of items) {
    if (it.kind === "title") width += Math.min(ROW.titleMin, safe(it.text));
    else if (it.kind === "carousel") width += minimumWindow(it.items, it.gap);
  }
  return Math.ceil(width - 1e-9);
}

/** The width the row takes without cutting or rotating anything: the title at titleMax, every carousel whole. */
export function naturalWidth(items: RowItem[]): number {
  let width = fixedOf(items) + gapsOf(items);
  for (const it of items) {
    if (it.kind === "title") width += ROW.titleMax;
    else if (it.kind === "carousel") width += fullWindow(it.items, it.gap);
  }
  return width;
}

/** Drops what does not fit (equalizer, then cover, then clock), gives the carousels what the title and gaps leave, then spreads it all. */
export function planRow(items: RowItem[], contentWidth: number, dpi: number): RowPlan {
  const dropped: string[] = [];
  let row = items;
  for (const id of ["equalizer", "cover", "clock"]) {
    if (requiredWidth(row) <= contentWidth + EPS) break;
    if (!row.some((it) => it.id === id)) continue;
    row = row.filter((it) => it.id !== id);
    dropped.push(id);
  }
  const title = row.find((it): it is TitleItem => it.kind === "title"), carousels = row.filter((it): it is CarouselItem => it.kind === "carousel");
  const text = title ? safe(title.text) : 0;
  let titleWant = Math.min(text, ROW.titleMax), pool = contentWidth - fixedOf(row) - gapsOf(row) - titleWant;
  const minimum = carousels.reduce((sum, it) => sum + minimumWindow(it.items, it.gap), 0);
  // The title gives back what the narrowest windows need, down to its shortest room.
  if (pool < minimum) { const back = Math.max(0, Math.min(titleWant - Math.min(ROW.titleMin, text), minimum - pool)); titleWant -= back; pool += back; }
  const rings = carousels.find((it) => it.id === "rings"), readings = carousels.find((it) => it.id === "readings");
  const shared = share(rings?.items ?? [], rings?.gap ?? 0, readings?.items ?? [], readings?.gap ?? 0, pool);
  const windows: Record<string, CarouselWindow> = { rings: shared.first, readings: shared.second };
  const widths = row.map((it) => (it.kind === "fixed" ? it.width : it.kind === "carousel" ? windows[it.id].window : 0));
  const placement = arrange(widths, row.findIndex((it) => it.kind === "title"), text, ROW.titleMin, contentWidth, ROW.unit, dpi);
  return {
    parts: row.map((it, i) => ({ id: it.id, left: placement.left[i], width: placement.room[i], ...(it.kind === "carousel" ? { window: windows[it.id] } : {}) })),
    gap: placement.gap,
    dropped,
  };
}

/** planRow, then again without any carousel left with no whole item, so the row keeps no gap for it. */
export function planVisible(items: RowItem[], contentWidth: number, dpi: number): RowPlan {
  const plan = planRow(items, contentWidth, dpi);
  const empty = plan.parts.filter((p) => p.window?.count === 0).map((p) => p.id);
  return empty.length ? planRow(items.filter((it) => !empty.includes(it.id)), contentWidth, dpi) : plan;
}

const insetOf = (style: "notch" | "capsule") => (style === "notch" ? ROW.insetNotch : ROW.insetCapsule);
const scaleOf = (scale: number) => (Number.isFinite(scale) && scale > 0 ? scale : 1);
const spanOf = (span: number) => (Number.isFinite(span) && span > 0 ? span : Infinity);

/**
 * The surface's width for a content width at scale 1: the content plus the inset at both ends (at most maxSurface), both grown by `scale`,
 * never narrower than `min` (the saved width) and never wider than `span` (the monitor along the edge), which only narrows what is drawn.
 */
export function surfaceWidth(style: "notch" | "capsule", content: number, min: number = ROW.minSurface, scale = 1, span = Infinity): number {
  const wanted = Math.min(ROW.maxSurface, (content > 0 ? content : 0) + 2 * insetOf(style)) * scaleOf(scale);
  return Math.min(spanOf(span), Math.max(Number.isFinite(min) ? min : ROW.minSurface, wanted));
}

/** The widest the row's content gets, at scale 1: the widest surface (maxSurface, or less on a monitor that is shorter at this scale) less the insets. */
export function rowRoom(style: "notch" | "capsule", scale = 1, span = Infinity): number {
  return Math.max(0, Math.min(ROW.maxSurface, spanOf(span) / scaleOf(scale)) - 2 * insetOf(style));
}
