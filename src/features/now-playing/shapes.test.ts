import { test } from "node:test";
import assert from "node:assert/strict";
import { sinePath, wavePath } from "./shapes.ts";

/** All numbers of a path, as [x, y] pairs. */
const pairs = (d: string) => {
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i], n[2 * i + 1]]);
};

test("wave runs through every band level inside the box", () => {
  const d = wavePath([0, 1, 0.5, 0], 30, 16, 1);
  assert.match(d, /^M0 15C/);
  assert.equal((d.match(/C/g) ?? []).length, 3);
  // Segment ends are the points: level 1 at the top, 0.5 in the middle, 0 at the bottom.
  const ends = d.split("C").slice(1).map((s) => s.trim().split(" ").slice(-2).map(Number));
  assert.deepEqual(ends, [[10, 1], [20, 8], [30, 15]]);
  for (const [, y] of pairs(d)) assert.ok(y >= 1 && y <= 15, `y ${y} outside`);
});

test("wave clamps levels and handles tiny inputs", () => {
  assert.equal(wavePath([], 10, 10), "");
  assert.equal(wavePath([0.5], 10, 10, 1), "M0 5H10");
  const flat = wavePath([2, -1], 10, 10, 1);
  assert.equal(flat.split("C")[0], "M0 1");
  assert.ok(flat.endsWith(" 10 9"));
});

test("sine spans exactly to the played end and flattens at zero amplitude", () => {
  assert.equal(sinePath(0, 8, 3, 20, 0), "");
  assert.equal(sinePath(100, 8, 0, 20, 0), "M0 8H100");
  // Full amplitude up to half a period before the head, then a taper that ends on the middle line.
  const d = sinePath(40, 8, 3, 20, 0, 5);
  assert.deepEqual(pairs(d), [[0, 8], [5, 5], [10, 8], [15, 11], [20, 8], [25, 5], [30, 8], [35, 9.5], [40, 8]]);
  assert.equal(pairs(sinePath(33, 8, 3, 20, 1))[0][1] < 8, true);
  assert.equal(pairs(sinePath(33, 8, 3, 20, 1)).at(-1)![1], 8);
  // The phase shifts the wave: a quarter period starts it at the notnotch.
  assert.equal(pairs(sinePath(10, 8, 3, 20, Math.PI / 2, 5))[0][1], 5);
  for (const [, y] of pairs(sinePath(300, 8, 3, 18, 1.234))) assert.ok(y >= 5 && y <= 11);
});
