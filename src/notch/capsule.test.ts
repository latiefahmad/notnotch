import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPSULE, hasBridge, panelTop, snapCapsule, windowYFor } from "./capsule.ts";

const work = { top: 0, height: 1032 };

test("snap", () => {
  assert.deepEqual(snapCapsule(865, 300, 196, 32, 1920, 1080, work), { x: 862, y: 300, guideX: 960, guideY: null });
  assert.equal(snapCapsule(700, 9, 196, 32, 1920, 1080, work).y, 5);
  assert.equal(snapCapsule(700, 992, 196, 32, 1920, 1080, work).y, 995);
  assert.equal(snapCapsule(700, 2000, 196, 32, 1920, 1080, work).y, 1043);
  assert.equal(snapCapsule(-40, 300, 196, 32, 1920, 1080, work).x, 5);
  assert.equal(snapCapsule(5000, 300, 196, 32, 1920, 1080, work).x, 1719);
  assert.deepEqual(snapCapsule(500, 506, 196, 32, 1920, 1080, work), { x: 500, y: 500, guideX: null, guideY: 516 });
  assert.equal(snapCapsule(0, 0, 196, 32, 1920, 1080, { top: 48, height: 1032 }).y, 53);
});
test("snap guides", () => {
  // Held at a side or at the top draws no x guide; the top and bottom edges report the monitor line they sit on.
  assert.deepEqual(snapCapsule(-40, 9, 196, 32, 1920, 1080, work), { x: 5, y: 5, guideX: null, guideY: 0 });
  assert.deepEqual(snapCapsule(700, 2000, 196, 32, 1920, 1080, { top: 0, height: 1080 }), { x: 700, y: 1043, guideX: null, guideY: 1080 });
  assert.equal(snapCapsule(700, 992, 196, 32, 1920, 1080, work).guideY, 1032);   // above the taskbar: its top
  assert.equal(snapCapsule(700, 1000, 196, 32, 1920, 1080, work).guideY, 1032);
});
test("snap picks the nearest place, the later one on a tie", () => {
  // Work area 0..60 on an 80 tall monitor, capsule 20 tall: places 5 (top), 55 (monitor bottom), 20 (middle), 35 (above the taskbar).
  const small = { top: 0, height: 60 };
  assert.deepEqual(snapCapsule(0, 10, 100, 20, 1920, 80, small), { x: 5, y: 5, guideX: null, guideY: 0 });   // 5 from the top place, 10 from the middle
  assert.deepEqual(snapCapsule(0, 12.5, 100, 20, 1920, 80, small), { x: 5, y: 20, guideX: null, guideY: 30 });   // tie of top and middle: the middle comes later
  assert.deepEqual(snapCapsule(0, 27.5, 100, 20, 1920, 80, small), { x: 5, y: 35, guideX: null, guideY: 60 });   // tie of middle and taskbar: the taskbar comes last
});
test("snap keeps the capsule on the monitor", () => {
  const wide = snapCapsule(0, 0, 3000, 32, 1920, 1080, work);
  assert.equal(wide.x, 0);   // wider than the monitor: nowhere to go, and no snap pulls it off
  const tall = snapCapsule(0, 500, 196, 2000, 1920, 1080, work);
  assert.equal(tall.y, 0);
});
test("snap with values that are not numbers", () => {
  assert.deepEqual(snapCapsule(Number.NaN, Number.NaN, 196, 32, 1920, 1080, work), { x: 5, y: 5, guideX: null, guideY: 0 });
  const r = snapCapsule(700, 300, Number.NaN, Number.NaN, 1920, 1080, work);
  assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
  assert.deepEqual(snapCapsule(Number.POSITIVE_INFINITY, 300, 196, 32, 1920, 1080, work).x, 5);   // not finite: back at the left edge
});
test("bridge and window", () => {
  assert.equal(hasBridge("capsule", 20, 0), true); assert.equal(hasBridge("capsule", 20.5, 0), false);
  assert.equal(hasBridge("capsule", 68, 48), true); assert.equal(hasBridge("notch", 300, 0), true);
  assert.equal(windowYFor("capsule", 20, 1080), 0); assert.equal(windowYFor("capsule", 300, 1080), 294);
  assert.equal(windowYFor("capsule", 1040, 1080), 520); assert.equal(windowYFor("line", 300, 1080), 0);
  assert.equal(panelTop(500, 200), 360); assert.equal(panelTop(40, 200), 40);
});
test("window stays at the top while the capsule is bridged", () => {
  // Top taskbar of 48: the bridge reaches up to 48 + 20 = 68, and the window has to cover the strip down to the capsule.
  for (const [y, expected] of [[55, 0], [68, 0], [68.5, 62.5]] as const) {
    assert.equal(windowYFor("capsule", y, 1080, 48), expected, `window at y ${y}`);
    assert.equal(hasBridge("capsule", y, 48), expected === 0, `bridge at y ${y}`);
  }
  for (const y of [0, 20, 40, 48, 68, 68.5, 300, 1043, Number.NaN]) for (const workTop of [0, 48, -10, Number.NaN]) {
    if (hasBridge("capsule", y, workTop)) assert.equal(windowYFor("capsule", y, 1080, workTop), 0, `y ${y}, workTop ${workTop}`);
  }
});
test("bridge and window edges", () => {
  assert.equal(hasBridge("line", 900, 0), true); assert.equal(hasBridge("capsule", 300, 0), false);
  assert.equal(hasBridge("capsule", 20, Number.NaN), true); assert.equal(hasBridge("capsule", 20, -30), true);
  assert.equal(windowYFor("notch", 300, 1080), 0); assert.equal(windowYFor("capsule", 26, 1080), 20);
  assert.equal(windowYFor("capsule", 300, 400), 0);   // monitor shorter than the window
  assert.equal(windowYFor("capsule", Number.NaN, 1080), 0);
  assert.equal(panelTop(-10, 200), 0); assert.equal(panelTop(100, 600), 0); assert.equal(panelTop(Number.NaN, 200), 0);
  assert.equal(CAPSULE.windowH, 560);
});
