import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_SIZE_DEFAULTS, contentScale, defaultClosed, fitCapsuleTop, normalizeClosedSize, resizeClosed, roundThickness, sideLength, windowAlong, type ClosedSize } from "./collapsed.ts";
import { closedGeometry, lineGeometry, peekGeometry } from "./geometry.ts";
import { rowRoom, surfaceWidth } from "./row/layout.ts";
import { COLUMN_ROOM, columnRoom, columnSurface } from "./column.ts";
import { capsuleY, windowYFor } from "./capsule.ts";
import { toPageCss } from "../features/window/panelSize.ts";

const d = CLOSED_SIZE_DEFAULTS;

test("the defaults are the sizes from before: notch and capsule 188 x 30, line 150 x 5, the window 760 long", () => {
  assert.deepEqual(closedGeometry("notch", surfaceWidth("notch", 0, d.notchWidth, contentScale(d.notchHeight)), d.notchHeight), { w: 188, h: 30, r: 10, ear: 6, rt: 0 });
  assert.deepEqual(closedGeometry("capsule", surfaceWidth("capsule", 0, d.capsuleWidth, contentScale(d.capsuleHeight)), d.capsuleHeight), { w: 188, h: 30, r: 15, ear: 0, rt: 15 });
  assert.deepEqual(peekGeometry("notch", 188, 30), { w: 204, h: 34, r: 12, ear: 7, rt: 0 });
  assert.deepEqual(peekGeometry("capsule", 188, 30), { w: 204, h: 34, r: 17, ear: 0, rt: 17 });
  assert.deepEqual(lineGeometry(d.lineLength, d.lineThickness, d.lineTop > 0, false), { w: 150, h: 5, r: 2.5, ear: 3, rt: 0 });
  assert.deepEqual(lineGeometry(d.lineLength, d.lineThickness, d.lineTop > 0, true), { w: 166, h: 7, r: 3.5, ear: 3.5, rt: 0 });
  assert.equal(contentScale(d.notchHeight), 1);
  assert.equal(rowRoom("notch"), 644); assert.equal(rowRoom("capsule"), 670); assert.equal(columnRoom(), COLUMN_ROOM);
  assert.deepEqual(columnSurface(0, 20, 1, sideLength(d.notchWidth)), { w: 120, h: 30 });
  for (const style of ["notch", "capsule", "line"] as const) for (const side of [false, true]) assert.equal(windowAlong(d, style, side, 1920), 760, `${style} ${side}`);
});

test("the content scale is the height over 30 and the insets grow with it; the notch's corners keep their size", () => {
  assert.equal(contentScale(60), 2); assert.equal(contentScale(24), 0.8); assert.equal(contentScale(Number.NaN), 1);
  // Content 100 at scale 2: 200 plus the insets 56 and 30 at both ends.
  assert.equal(surfaceWidth("notch", 100, 72, 2), 312);
  assert.equal(surfaceWidth("capsule", 100, 48, 2), 260);
  assert.deepEqual(closedGeometry("notch", 300, 60), { w: 300, h: 60, r: 10, ear: 6, rt: 0 });
  assert.deepEqual(closedGeometry("capsule", 300, 48), { w: 300, h: 48, r: 24, ear: 0, rt: 24 });
  // On a side edge the height is the column's depth; its content grows the same way.
  assert.deepEqual(columnSurface(100, 20, 2, sideLength(188)), { w: 248, h: 60 });
});

test("the width is a minimum: the content keeps the surface wide enough for what it shows", () => {
  assert.equal(surfaceWidth("capsule", 10, 300), 300);
  assert.equal(surfaceWidth("capsule", 400, 100), 430);
  assert.equal(surfaceWidth("notch", 400, 72, 0.8), (400 + 56) * 0.8);
  assert.equal(sideLength(376), 240);
});

test("a small monitor narrows what is drawn and the content's room, never the saved value", () => {
  const saved: ClosedSize = { ...d, notchWidth: 8000, capsuleWidth: 8000, lineLength: 600 };
  assert.equal(surfaceWidth("notch", 0, saved.notchWidth, 1, 1920), 1920);
  assert.equal(surfaceWidth("notch", 5000, 72, 2, 1280), 1280);
  assert.equal(columnSurface(5000, 20, 2, sideLength(saved.notchWidth), 1080).w, 1080);
  assert.equal(normalizeClosedSize(saved).notchWidth, 8000);
  // The content is never given a negative room.
  assert.equal(rowRoom("notch", 2, 100), 0);
  assert.equal(rowRoom("notch", 2, 1280), 640 - 56);
  assert.equal(columnRoom(2, 1080), 540 - 24);
});

test("the capsule stops at the bottom of a shorter monitor and its window still holds it", () => {
  assert.equal(capsuleY(600, 30, 1080), 600);
  assert.equal(capsuleY(4000, 30, 1080), 1050);
  assert.equal(capsuleY(200, 60, 240), 180);
  assert.equal(capsuleY(-5, 30, 1080), 0); assert.equal(capsuleY(Number.NaN, 30, 1080), 0);
  for (const [y, h, mh] of [[4000, 60, 1080], [4000, 24, 600], [300, 60, 400]]) {
    const top = capsuleY(y, h, mh), win = windowYFor("capsule", top, mh);
    assert.ok(top - win >= 0 && top - win + h <= 560, `capsule ${h} at ${y} on ${mh}`);
  }
});

test("normalize clamps every value to its limits and replaces what is not a number with the default", () => {
  assert.deepEqual(normalizeClosedSize({ notchWidth: 9000, notchHeight: 1, capsuleWidth: 10, capsuleHeight: 100, lineLength: 1000, lineThickness: 3.3, lineTop: 50 }), {
    notchWidth: 8000, notchHeight: 24, capsuleWidth: 48, capsuleHeight: 60, lineLength: 600, lineThickness: 3.5, lineTop: 16,
  });
  assert.deepEqual(normalizeClosedSize(undefined), d);
  assert.deepEqual(normalizeClosedSize({ notchWidth: Number.POSITIVE_INFINITY, notchHeight: "40", capsuleWidth: null, lineTop: Number.NaN }), d);
  assert.equal(fitCapsuleTop(-3), 0); assert.equal(fitCapsuleTop(9000), 8000); assert.equal(fitCapsuleTop(Number.NaN), 5); assert.equal(fitCapsuleTop(600), 600);
});

test("the line's thickness rounds to half px within 2 to 8", () => {
  assert.equal(roundThickness(2.24), 2); assert.equal(roundThickness(2.25), 2.5); assert.equal(roundThickness(0.4), 2);
  assert.equal(roundThickness(9), 8); assert.equal(roundThickness(Number.NaN), 5); assert.equal(roundThickness("4"), 5);
});

test("the line away from the edge is round all over; its distance stays a place on the screen at 150 %", () => {
  assert.deepEqual(lineGeometry(56, 4, true, false), { w: 56, h: 4, r: 2, ear: 0, rt: 2 });
  assert.deepEqual(lineGeometry(56, 4, true, true), { w: 72, h: 6, r: 3, ear: 0, rt: 3 });
  // The page is zoomed by the panel scale, so the distance in page px times 1.5 is the saved one.
  assert.ok(Math.abs(toPageCss(4, 150) * 1.5 - 4) < 1e-9);
});

test("the window grows along its edge only for a wider closed surface, at most to the monitor", () => {
  const tall = { ...d, notchHeight: 60, capsuleHeight: 60 };
  assert.equal(windowAlong(tall, "notch", false, 2560), 1460);
  assert.equal(windowAlong(tall, "notch", false, 1280), 1340);
  assert.equal(windowAlong(tall, "capsule", false, 2560), 1460);
  assert.equal(windowAlong(tall, "notch", true, 1080), 1140);
  assert.equal(windowAlong({ ...d, notchWidth: 1000 }, "notch", false, 2560), 1060);
  assert.equal(windowAlong({ ...d, notchWidth: 1000 }, "line", false, 2560), 1060);
  assert.equal(windowAlong({ ...d, capsuleWidth: 1000 }, "notch", false, 2560), 760);
  assert.equal(windowAlong(tall, "notch", false, Number.NaN), 1460);
});

test("extreme sizes on small monitors stay finite, not negative and on the monitor", () => {
  const extremes = [
    { notchWidth: 72, notchHeight: 60, capsuleWidth: 48, capsuleHeight: 60, lineLength: 24, lineThickness: 8, lineTop: 16 },
    { notchWidth: 8000, notchHeight: 24, capsuleWidth: 8000, capsuleHeight: 24, lineLength: 600, lineThickness: 2, lineTop: 0 },
    { notchWidth: Number.NaN, notchHeight: Number.NEGATIVE_INFINITY, capsuleWidth: -50, capsuleHeight: 0, lineThickness: Number.NaN },
    { notchWidth: 1e300, notchHeight: 1e300, capsuleWidth: -1e300, lineLength: 1e300, lineTop: -1e300 },
  ];
  for (const raw of extremes) {
    const s = normalizeClosedSize(raw);
    for (const span of [0, 320, 533, 800, Number.NaN]) {
      const on = (v: number) => Number.isFinite(v) && v >= 0 && (!(span > 0) || v <= span + 1e-9);
      for (const content of [0, 50, 5000]) {
        assert.ok(on(surfaceWidth("notch", content, s.notchWidth, contentScale(s.notchHeight), span)), `notch ${JSON.stringify(raw)} on ${span}`);
        assert.ok(on(surfaceWidth("capsule", content, s.capsuleWidth, contentScale(s.capsuleHeight), span)), `capsule ${JSON.stringify(raw)} on ${span}`);
        const column = columnSurface(content, 20, contentScale(s.notchHeight), sideLength(s.notchWidth), span);
        assert.ok(on(column.w) && column.h > 0, `column ${JSON.stringify(raw)} on ${span}`);
      }
      assert.ok(rowRoom("notch", contentScale(s.notchHeight), span) >= 0 && columnRoom(contentScale(s.notchHeight), span) >= 0);
      for (const style of ["notch", "capsule", "line"] as const) assert.ok(Number.isFinite(windowAlong(s, style, false, span)) && windowAlong(s, style, true, span) >= 760);
    }
  }
});

test("resize grips: the ends widen both sides, the far side sets the height, held to the limits and the monitor", () => {
  const s = CLOSED_SIZE_DEFAULTS;
  assert.deepEqual(resizeClosed(s, "notch", "end", 10, 0, 1920), { notchWidth: s.notchWidth + 20 });
  assert.deepEqual(resizeClosed(s, "notch", "start", -10, 0, 1920), { notchWidth: s.notchWidth + 20 });
  assert.deepEqual(resizeClosed(s, "notch", "end", -500, 0, 1920), { notchWidth: 72 });
  assert.deepEqual(resizeClosed(s, "capsule", "end", 2000, 0, 1920), { capsuleWidth: 1920 });
  assert.deepEqual(resizeClosed(s, "notch", "depth", 0, 6.4, 1920), { notchHeight: 36 });
  assert.deepEqual(resizeClosed(s, "notch", "depth", 0, 100, 1920), { notchHeight: 60 });
  assert.deepEqual(resizeClosed(s, "line", "depth", 0, 1.3, 1920), { lineThickness: 6.5 });
  assert.deepEqual(resizeClosed(s, "line", "end", 5, 0, 1920), { lineLength: 160 });
  assert.deepEqual(defaultClosed("capsule", "depth"), { capsuleHeight: 30 });
});
