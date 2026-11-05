// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/CompactColumn.cs.
// The closed notch on a side edge: the parts the row shows side by side stand one below the other, centred across the column, in the
// same order. Text stays upright. The column is as wide as its widest fixed part (at least minWidth), the readings widen it up to
// readingCap. Lines that do not fit in the notch's longest length are left out from the end. Pure, CSS px.

export const COLUMN = {
  /** As wide as the cover, so a column with only the cover is as deep as the closed notch on top (30). */
  minWidth: 20,
  readingCap: 84,
  /** Between two lines, and between rings on one line. */
  gap: 6,
  ringGap: 6,
  /** Across the column on either side: (30 - 20) / 2, as on top. */
  pad: 5,
  /** Along the edge at both ends. */
  inset: 12,
  minLength: 120,
  maxLength: 700,
} as const;

const fin = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);

/** The width the column needs: the widest fixed part and the readings up to the cap, never below the minimum; whole px, rounded up. */
export function columnWidth(fixedParts: number[], readings: number[]): number {
  const widest = Math.max(COLUMN.minWidth, ...fixedParts.map(fin));
  const reading = Math.min(COLUMN.readingCap, Math.max(0, ...readings.map(fin)));
  return Math.ceil(Math.max(widest, reading) - 1e-9);
}

/** How many rings of this size stand side by side in a column of this width (at least one), and how many lines they take. */
export function ringLines(count: number, size: number, gap: number, width: number): { perLine: number; lines: number } {
  if (!(count > 0)) return { perLine: 0, lines: 0 };
  const step = Math.max(1e-9, fin(size) + fin(gap));
  const perLine = Math.min(count, Math.max(1, Math.floor((fin(width) + fin(gap)) / step + 1e-9)));
  return { perLine, lines: Math.ceil(count / perLine) };
}

/** The tops of lines of these heights, stacked with the gap between them, and the column's length. */
export function stack(heights: number[], gap: number): { tops: number[]; length: number } {
  const tops: number[] = [];
  let y = 0;
  heights.forEach((h, i) => {
    if (i > 0) y += fin(gap);
    tops.push(y);
    y += fin(h);
  });
  return { tops, length: y };
}

/** How many lines from the first fit in `room`. */
export function fitLines(heights: number[], gap: number, room: number): number {
  let n = 0;
  for (let i = 1; i <= heights.length; i++) if (stack(heights.slice(0, i), gap).length <= fin(room) + 1e-6) n = i;
  return n;
}

const scaleOf = (scale: number) => (Number.isFinite(scale) && scale > 0 ? scale : 1);
const spanOf = (span: number) => (Number.isFinite(span) && span > 0 ? span : Infinity);

/**
 * The closed shape in the frame for a column of content at scale 1: along the edge its length plus the insets (at most maxLength), away
 * from the edge its width plus the pads, both grown by `scale`; along the edge never shorter than `minLength` nor longer than `span` (the monitor).
 */
export function columnSurface(length: number, width: number, scale = 1, minLength: number = COLUMN.minLength, span = Infinity): { w: number; h: number } {
  const k = scaleOf(scale), along = Math.min(COLUMN.maxLength, fin(length) + 2 * COLUMN.inset) * k;
  return { w: Math.min(spanOf(span), Math.max(Number.isFinite(minLength) ? minLength : COLUMN.minLength, along)), h: (Math.max(COLUMN.minWidth, fin(width)) + 2 * COLUMN.pad) * k };
}

/** The room for lines along the edge in the longest notch, at scale 1 (less on a monitor shorter than that notch at this scale). */
export function columnRoom(scale = 1, span = Infinity): number {
  return Math.max(0, Math.min(COLUMN.maxLength, spanOf(span) / scaleOf(scale)) - 2 * COLUMN.inset);
}
export const COLUMN_ROOM = columnRoom();
