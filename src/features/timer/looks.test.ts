import { test } from "node:test";
import assert from "node:assert/strict";
import { SEGMENTS, TIMER_LOOKS, clockText, handAngles, litCells, lookText, lookTint, normalizeClockLook, normalizeLook, normalizeLookColor, pixelMatrix, progressOf, slicePath, terminalBar, timeWidth, zenParts } from "./looks.ts";

test("text per look", () => {
  assert.equal(lookText("clean", 1500), "25:00");
  assert.equal(lookText("clean", 1499.2), "25:00"); // rounds up
  assert.equal(lookText("clean", 1499), "24:59");
  assert.equal(lookText("clean", 180 * 60), "180:00");
  assert.equal(lookText("pixel", 65), "1:05");
  assert.equal(lookText("dots", 0), "0:00");
  assert.equal(lookText("retro", 299), "04:59");
  assert.equal(lookText("retro", 3900), "1:05:00");
  assert.equal(lookText("terminal", 1499), "00:24:59");
  assert.equal(lookText("terminal", 7322), "02:02:02");
  assert.equal(lookText("hud", 1499.84), "24:59.9");
  assert.equal(lookText("hud", 1500), "25:00.0");
  assert.equal(lookText("hud", 0.01), "00:00.1");
  assert.equal(lookText("hud", 0), "00:00.0");
  assert.equal(lookText("zen", 1499), "25 min");
  assert.equal(lookText("zen", 61), "2 min");
  assert.equal(lookText("zen", 59.5), "1 min"); // 60 whole seconds left
  assert.equal(lookText("zen", 59), "59 s");
  assert.equal(lookText("clean", -3), "0:00");
});

test("zen parts", () => {
  assert.deepEqual(zenParts(60), { value: 1, unit: "min" });
  assert.deepEqual(zenParts(0), { value: 0, unit: "s" });
});

test("normalize look", () => {
  for (const l of TIMER_LOOKS) assert.equal(normalizeLook(l), l);
  assert.equal(normalizeLook("neon"), "clean");
  assert.equal(normalizeLook(undefined), "clean");
});

test("progress and lit cells", () => {
  assert.equal(progressOf(1500, 1500), 0);
  assert.equal(progressOf(0, 1500), 1);
  assert.equal(progressOf(750, 1500), 0.5);
  assert.equal(progressOf(10, 0), 1);
  assert.equal(litCells(1500, 1500, 40), 40);
  assert.equal(litCells(750, 1500, 40), 20);
  assert.equal(litCells(1, 1500, 40), 1); // last cell stays lit until the end
  assert.equal(litCells(0, 1500, 40), 0);
  assert.equal(litCells(2000, 1500, 40), 40);
});

test("terminal bar", () => {
  assert.equal(terminalBar(1500, 1500, 10), "[----------]");
  assert.equal(terminalBar(750, 1500, 10), "[#####-----]");
  assert.equal(terminalBar(0, 1500, 4), "[####]");
});

test("pixel matrix", () => {
  const m = pixelMatrix("1:0");
  assert.equal(m.length, 5);
  // 3 + gap + 1 + gap + 3
  assert.equal(m[0].length, 9);
  assert.deepEqual(m[1].map(Number), [1, 1, 0, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(pixelMatrix("x")[0], []);
});

test("seven segments", () => {
  assert.equal(SEGMENTS["8"], "abcdefg");
  assert.equal(SEGMENTS["1"], "bc");
  for (let d = 0; d <= 9; d++) assert.ok(SEGMENTS[String(d)].length >= 2);
});

test("clock text and clock look", () => {
  assert.equal(clockText(7, 5, false), "07:05");
  assert.equal(clockText(0, 0, false), "00:00");
  assert.equal(clockText(0, 30, true), "12:30");
  assert.equal(clockText(12, 0, true), "12:00");
  assert.equal(clockText(23, 59, true), "11:59");
  // every character has a pixel glyph and seven segments
  assert.equal(pixelMatrix(clockText(20, 6, false))[0].length, pixelMatrix("20:06")[0].length);
  for (const c of "0123456789") assert.ok(SEGMENTS[c]);
  assert.equal(normalizeClockLook("pixel"), "pixel");
  assert.equal(normalizeClockLook(undefined), "standard");
  assert.equal(normalizeClockLook("standard"), "standard");
});

test("new looks: LCD reads like the retro clock, the others like the clean one", () => {
  assert.equal(lookText("lcd", 3900), "1:05:00");
  assert.equal(lookText("flip", 1499), "24:59");
  assert.ok(TIMER_LOOKS.includes("analog"));
});

test("colours: orange keeps the theme's warning colour, unknown values fall back", () => {
  assert.equal(lookTint("orange"), "var(--color-orange)");
  assert.equal(lookTint("blue"), "var(--hue-blue)");
  assert.equal(lookTint("white"), "var(--color-label)");
  assert.equal(normalizeLookColor("purple-ish", "orange"), "orange");
  assert.equal(normalizeLookColor("teal", "white"), "teal");
});

test("analog hands and the slice of time left", () => {
  assert.deepEqual(handAngles("3:00"), { hour: 90, minute: 0 });
  assert.deepEqual(handAngles("12:30"), { hour: 15, minute: 180 });
  assert.equal(handAngles("noon"), null);
  assert.equal(slicePath(0, 10), "");
  assert.match(slicePath(1, 10), /^M0,-10A10,10 0 1 1 0,10/);
  assert.equal(slicePath(0.25, 10), "M0,0L0,-10A10,10 0 0 1 10,0Z");
  assert.match(slicePath(0.75, 10), / 0 1 1 -10,/);
  assert.ok(Math.abs(timeWidth("24:59") - 2.7) < 1e-9);
});
