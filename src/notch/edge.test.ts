import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDGES, EDGE_HYSTERESIS, anchorAt, applyLinear, deltaFromScreen, edgeLine, frameCss, frameFor, fromScreen, hasTaskbar, linear, nearestEdge, normalizeDock,
  pointToScreen, pointerIn, toScreen, upright, uprightCss, windowSize, type Work,
} from "./edge.ts";

const W = 1920, H = 1080;
const bottomBar: Work = { x: 0, y: 0, width: W, height: H - 48 };
const leftBar: Work = { x: 60, y: 0, width: W - 60, height: H };
const topBar: Work = { x: 0, y: 40, width: W, height: H - 40 };
const rightBar: Work = { x: 0, y: 0, width: W - 70, height: H };

test("line: top hangs from the screen by default, the other edges from the taskbar", () => {
  assert.equal(edgeLine("top", "auto", W, H, topBar), 0);
  assert.equal(edgeLine("top", "taskbar", W, H, topBar), 40);
  assert.equal(edgeLine("bottom", "auto", W, H, bottomBar), H - 48);
  assert.equal(edgeLine("bottom", "screen", W, H, bottomBar), H);
  assert.equal(edgeLine("left", "auto", W, H, leftBar), 60);
  assert.equal(edgeLine("left", "screen", W, H, leftBar), 0);
  assert.equal(edgeLine("right", "auto", W, H, rightBar), W - 70);
  // No taskbar on that edge: screen and taskbar are the same line.
  assert.equal(edgeLine("right", "auto", W, H, bottomBar), W);
  // A broken work area falls back to the screen's edge.
  assert.equal(edgeLine("bottom", "taskbar", W, H, { x: 0, y: 0, width: 0, height: Number.NaN }), H);
});

test("frame: screen rectangles go there and back on every edge", () => {
  const r = { x: 300, y: 200, w: 120, h: 40 };
  for (const edge of EDGES) for (const work of [bottomBar, leftBar, topBar, rightBar]) for (const anchor of ["auto", "screen", "taskbar"] as const) {
    const f = frameFor(edge, anchor, W, H, work);
    assert.deepEqual(toScreen(f, fromScreen(f, r)), r, `${edge} ${anchor}`);
    assert.deepEqual(fromScreen(f, toScreen(f, r)), r, `${edge} ${anchor}`);
  }
});

test("frame: a shape hanging from the frame's origin touches the real edge", () => {
  const shape = { x: 900, y: 0, w: 120, h: 30 };
  assert.deepEqual(toScreen(frameFor("top", "auto", W, H, bottomBar), shape), shape);
  assert.deepEqual(toScreen(frameFor("bottom", "auto", W, H, bottomBar), shape), { x: 900, y: H - 48 - 30, w: 120, h: 30 });
  assert.deepEqual(toScreen(frameFor("bottom", "screen", W, H, bottomBar), shape), { x: 900, y: H - 30, w: 120, h: 30 });
  assert.deepEqual(toScreen(frameFor("left", "auto", W, H, leftBar), shape), { x: 60, y: 900, w: 30, h: 120 });
  assert.deepEqual(toScreen(frameFor("right", "auto", W, H, rightBar), shape), { x: W - 70 - 30, y: 900, w: 30, h: 120 });
  assert.deepEqual(pointToScreen(frameFor("right", "screen", W, H, rightBar), 10, 5), { x: W - 5, y: 10 });
});

test("drag deltas: moving away from the edge is +y in the frame", () => {
  assert.deepEqual(deltaFromScreen("top", 5, 7), { x: 5, y: 7 });
  assert.deepEqual(deltaFromScreen("bottom", 5, -7), { x: 5, y: 7 });
  assert.deepEqual(deltaFromScreen("left", 7, 5), { x: 5, y: 7 });
  assert.deepEqual(deltaFromScreen("right", -7, 5), { x: 5, y: 7 });
});

test("css: the frame and upright maps compose to the identity, top stays untouched", () => {
  assert.equal(frameCss("top", 560), undefined);
  assert.equal(uprightCss("top"), undefined);
  assert.equal(frameCss("bottom", 560), "matrix(1, 0, 0, -1, 0, 560)");
  assert.equal(frameCss("left", 0), "matrix(0, 1, 1, 0, 0, 0)");
  assert.equal(frameCss("left", 60), "matrix(0, 1, 1, 0, 60, 0)");
  assert.equal(frameCss("right", 760), "matrix(0, 1, -1, 0, 760, 0)");
  for (const edge of EDGES) for (const [x, y] of [[1, 0], [0, 1], [3, -2]]) {
    const u = applyLinear(upright(edge), x, y), back = applyLinear(linear(edge), u.x, u.y);
    assert.deepEqual([back.x + 0, back.y + 0], [x, y], edge);
  }
  // The CSS matrix agrees with the frame for a point (along 10, depth 5) in a window 560 deep on the bottom edge.
  assert.deepEqual(applyLinear(linear("bottom"), 10, 5), { x: 10, y: -5 });
  assert.deepEqual(applyLinear(linear("right"), 10, 5), { x: -5, y: 10 });
});

test("window: side edges are as deep as long", () => {
  assert.deepEqual(windowSize("top"), { w: 760, h: 560 });
  assert.deepEqual(windowSize("bottom"), { w: 760, h: 560 });
  assert.deepEqual(windowSize("left"), { w: 760, h: 760 });
});

test("nearest edge with hysteresis", () => {
  assert.equal(nearestEdge(960, 10, W, H, "top"), "top");
  assert.equal(nearestEdge(960, H - 10, W, H, "top"), "bottom");
  assert.equal(nearestEdge(10, 540, W, H, "top"), "left");
  assert.equal(nearestEdge(W - 3, 540, W, H, "bottom"), "right");
  // Near the top-left corner: left wins only once it is EDGE_HYSTERESIS nearer than the top.
  assert.equal(nearestEdge(20, 40, W, H, "top"), "top");
  assert.equal(nearestEdge(20, 20 + EDGE_HYSTERESIS, W, H, "top"), "top");
  assert.equal(nearestEdge(20, 20 + EDGE_HYSTERESIS + 1, W, H, "top"), "left");
  // And back: once on the left, the top has to be as much nearer.
  assert.equal(nearestEdge(40, 20, W, H, "left"), "left");
  assert.equal(nearestEdge(60, 20, W, H, "left"), "top");
  assert.equal(nearestEdge(Number.NaN, 20, W, H, "right"), "right");
});

test("taskbar and anchor while dragging", () => {
  assert.equal(hasTaskbar("bottom", W, H, bottomBar), true);
  assert.equal(hasTaskbar("top", W, H, bottomBar), false);
  assert.equal(hasTaskbar("left", W, H, leftBar), true);
  assert.equal(hasTaskbar("right", W, H, rightBar), true);
  assert.equal(anchorAt("bottom", 900, H - 10, W, H, bottomBar), "screen");
  assert.equal(anchorAt("bottom", 900, H - 60, W, H, bottomBar), "taskbar");
  assert.equal(anchorAt("left", 30, 500, W, H, leftBar), "screen");
  assert.equal(anchorAt("left", 90, 500, W, H, leftBar), "taskbar");
  assert.equal(anchorAt("right", W - 10, 500, W, H, rightBar), "screen");
  assert.equal(anchorAt("top", 900, 5, W, H, bottomBar), null);
});

test("saved dock: valid values kept, anything else falls back", () => {
  assert.deepEqual(normalizeDock(undefined), { edge: "top", anchor: "auto" });
  assert.deepEqual(normalizeDock({ edge: "left", anchor: "screen" }), { edge: "left", anchor: "screen" });
  assert.deepEqual(normalizeDock({ edge: "middle", anchor: 3 }), { edge: "top", anchor: "auto" });
  assert.deepEqual(normalizeDock([1, 2]), { edge: "top", anchor: "auto" });
});

test("pointer in a hanging rectangle: depth from the edge side, along from the centre", () => {
  const r = { left: 100, top: 200, right: 160, bottom: 400 };
  assert.deepEqual(pointerIn("top", r, 130, 210), { depth: 10, along: 0 });
  assert.deepEqual(pointerIn("bottom", r, 140, 390), { depth: 10, along: 10 });
  assert.deepEqual(pointerIn("left", r, 110, 280), { depth: 10, along: -20 });
  assert.deepEqual(pointerIn("right", r, 150, 300), { depth: 10, along: 0 });
});
