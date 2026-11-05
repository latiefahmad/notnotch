import { test } from "node:test";
import assert from "node:assert/strict";
import { followTarget, normalizeMonitorMode, spotFor, type Metrics } from "./follow.ts";

const present = ["A", "B"];

test("the notch moves only to a present monitor, only while free, and only with follow or all", () => {
  assert.equal(followTarget("follow", "B", "A", false, present), "B");
  assert.equal(followTarget("all", "B", "A", false, present), "B");
  // Open, peeking, dragged or recording: it stays.
  assert.equal(followTarget("follow", "B", "A", true, present), null);
  // On the chosen monitor nothing follows.
  assert.equal(followTarget("chosen", "B", "A", false, present), null);
  // Already there, nothing reported yet, or the pointer over no copy ("all" reports null).
  assert.equal(followTarget("follow", "A", "A", false, present), null);
  assert.equal(followTarget("all", null, "A", false, present), null);
  // A monitor unplugged after Rust reported it.
  assert.equal(followTarget("follow", "C", "A", false, present), null);
});

test("an unknown saved mode is the chosen monitor", () => {
  assert.equal(normalizeMonitorMode("all"), "all");
  assert.equal(normalizeMonitorMode("follow"), "follow");
  assert.equal(normalizeMonitorMode(undefined), "chosen");
  assert.equal(normalizeMonitorMode("everywhere"), "chosen");
});

// 1920 x 1080 at 100 % with a 48 px taskbar at the bottom, and 2560 x 1440 at 150 % (CSS px) without one.
const a: Metrics = { width: 1920, height: 1080, workTop: 0, workHeight: 1032, workLeft: 0, workWidth: 1920 };
const b: Metrics = { width: 2560 / 1.5, height: 960, workTop: 0, workHeight: 960, workLeft: 0, workWidth: 2560 / 1.5 };

test("each monitor gets its own line for the same edge and anchor", () => {
  const top = { edge: "top", anchor: "auto" } as const;
  assert.deepEqual(spotFor(a, top, "notch", 5, 30), { line: 0, y: 0 });
  assert.deepEqual(spotFor(b, top, "notch", 5, 30), { line: 0, y: 0 });
  // Over the taskbar: the screen's bottom, which depends on the monitor's size and scale.
  const overBottom = { edge: "bottom", anchor: "screen" } as const;
  assert.deepEqual(spotFor(a, overBottom, "notch", 5, 30), { line: 1080, y: 0 });
  assert.deepEqual(spotFor(b, overBottom, "notch", 5, 30), { line: 960, y: 0 });
  // On the taskbar's edge where there is one, the screen's edge where there is none.
  const onBar = { edge: "bottom", anchor: "taskbar" } as const;
  assert.equal(spotFor(a, onBar, "line", 5, 30).line, 1032);
  assert.equal(spotFor(b, onBar, "line", 5, 30).line, 960);
  const right = { edge: "right", anchor: "auto" } as const;
  assert.equal(spotFor(a, right, "notch", 5, 30).line, 1920);
  assert.equal(spotFor(b, right, "notch", 5, 30).line, 2560 / 1.5);
});

test("a taskbar on top moves the notch's window down on that monitor only", () => {
  const withTopBar: Metrics = { ...a, workTop: 40, workHeight: 1040 };
  const onBar = { edge: "top", anchor: "taskbar" } as const;
  assert.deepEqual(spotFor(withTopBar, onBar, "notch", 5, 30), { line: 40, y: 40 });
  assert.deepEqual(spotFor(b, onBar, "notch", 5, 30), { line: 0, y: 0 });
});

test("the capsule keeps its saved top, held on each monitor", () => {
  const dock = { edge: "left", anchor: "auto" } as const;
  // Bridged near the top: the window starts at the screen's top; lower down it starts just above the capsule.
  assert.deepEqual(spotFor(a, dock, "capsule", 5, 30), { line: 0, y: 0 });
  assert.equal(spotFor(a, dock, "capsule", 300, 30).y, 294);
  // Far down: kept so the 560 px window stays on each monitor.
  assert.equal(spotFor(a, dock, "capsule", 5000, 30).y, 1080 - 560);
  assert.equal(spotFor(b, dock, "capsule", 5000, 30).y, 960 - 560);
  // Right after a scale change the metrics are still in the old scale's px (drag.ts applyDisplay).
  assert.equal(spotFor({ ...a, height: 1080 * 1.5 }, dock, "capsule", 300, 30, 1.5).y, (300 * 1.5 - 6) / 1.5);
  assert.ok(Number.isFinite(spotFor(a, dock, "capsule", Number.NaN, 30).y));
});
