import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMN, COLUMN_ROOM, columnSurface, columnWidth, fitLines, ringLines, stack } from "./column.ts";

test("column width: widest fixed part, at least the minimum, readings up to the cap", () => {
  assert.equal(columnWidth([], []), COLUMN.minWidth);
  assert.equal(columnWidth([20, 16], []), 20);
  assert.equal(columnWidth([20, 61.3], []), 62);
  assert.equal(columnWidth([20], [50]), 50);
  assert.equal(columnWidth([20], [120]), COLUMN.readingCap);
  assert.equal(columnWidth([100], [120]), 100);
  assert.equal(columnWidth([Number.NaN, -5], [Number.POSITIVE_INFINITY]), COLUMN.minWidth);
});

test("rings: as many per line as fit, at least one", () => {
  assert.deepEqual(ringLines(0, 12, 6, 40), { perLine: 0, lines: 0 });
  assert.deepEqual(ringLines(3, 12, 6, 20), { perLine: 1, lines: 3 });
  assert.deepEqual(ringLines(3, 12, 6, 30), { perLine: 2, lines: 2 });
  assert.deepEqual(ringLines(3, 12, 6, 48), { perLine: 3, lines: 1 });
  assert.deepEqual(ringLines(4, 12, 6, 200), { perLine: 4, lines: 1 });
  assert.deepEqual(ringLines(2, 12, 6, 0), { perLine: 1, lines: 2 });
});

test("stack: tops with the gap between lines, and the length", () => {
  assert.deepEqual(stack([], 6), { tops: [], length: 0 });
  assert.deepEqual(stack([20], 6), { tops: [0], length: 20 });
  assert.deepEqual(stack([20, 16, 12], 6), { tops: [0, 26, 48], length: 60 });
  assert.deepEqual(stack([20, Number.NaN, 12], 6), { tops: [0, 26, 32], length: 44 });
});

test("fit: lines that do not fit are left out from the end", () => {
  assert.equal(fitLines([20, 20, 20], 6, 72), 3);
  assert.equal(fitLines([20, 20, 20], 6, 71), 2);
  assert.equal(fitLines([20, 20, 20], 6, 19), 0);
  assert.equal(fitLines([], 6, 100), 0);
  const many = new Array(40).fill(20);
  const n = fitLines(many, COLUMN.gap, COLUMN_ROOM);
  assert.ok(stack(many.slice(0, n), COLUMN.gap).length <= COLUMN_ROOM);
  assert.ok(stack(many.slice(0, n + 1), COLUMN.gap).length > COLUMN_ROOM);
});

test("surface: length plus insets within limits, width plus pads", () => {
  assert.deepEqual(columnSurface(0, 20), { w: COLUMN.minLength, h: 30 });
  assert.deepEqual(columnSurface(200, 62), { w: 224, h: 72 });
  assert.deepEqual(columnSurface(5000, 20), { w: COLUMN.maxLength, h: 30 });
  assert.deepEqual(columnSurface(Number.NaN, Number.NaN), { w: COLUMN.minLength, h: 30 });
});
