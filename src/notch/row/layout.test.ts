import { test } from "node:test";
import assert from "node:assert/strict";
import { carouselWindow, minimumWindow, share, arrange, requiredWidth, naturalWidth, planRow, planVisible, surfaceWidth, type RowItem } from "./layout.ts";

const w = [30, 40, 20, 50];
test("carousel window", () => {
  assert.deepEqual(carouselWindow(w, 8, 100), { count: 2, window: 78, gaps: 1, travel: 86 });
  assert.deepEqual(carouselWindow(w, 8, 164), { count: 4, window: 164, gaps: 3, travel: 0 });
  assert.equal(carouselWindow(w, 8, 29).count, 0);
  assert.equal(carouselWindow([], 8, 100).count, 0);
  assert.equal(carouselWindow(w, 8, Number.NaN).count, 0);
  assert.equal(carouselWindow(w, 8, 60).count, 0);
  assert.deepEqual(carouselWindow([30, 40, 20, 36], 8, 60), { count: 1, window: 36, gaps: 0, travel: 114 });
  assert.deepEqual(carouselWindow([30, 50, 20, 20], 8, 40), { count: 1, window: 30, gaps: 0, travel: 124 });
});
test("minimum window", () => {
  assert.equal(minimumWindow([30, 40, 20, 50], 8), 78);
  assert.equal(minimumWindow([30, 40, 20, 36], 8), 36);
  assert.equal(minimumWindow([30, 50, 20, 20], 8), 30);
  assert.equal(minimumWindow([12, 12, 12], 8), 12);
  assert.equal(minimumWindow([50], 8), 50);
  assert.equal(minimumWindow([], 8), 0);
});
const rings = [12, 12, 12, 12], readings = [42, 50, 42, 45, 45, 70];
test("share", () => {
  let s = share(rings, 8, readings, 6, 110);
  assert.deepEqual(s.first, { count: 1, window: 12, gaps: 0, travel: 60 });
  assert.deepEqual(s.second, { count: 2, window: 98, gaps: 1, travel: 254 });
  s = share(rings, 8, readings, 6, 396);
  assert.deepEqual(s.first, { count: 4, window: 72, gaps: 3, travel: 0 });
  assert.deepEqual(s.second, { count: 6, window: 324, gaps: 5, travel: 0 });
  s = share(rings, 8, readings, 6, 50);
  assert.equal(s.first.count, 1); assert.equal(s.second.count, 0);
  assert.equal(share([], 8, readings, 6, 100).second.count, 2);
  let last = { a: 0, b: 0 };
  for (let room = 0; room <= 420; room++) {
    const r = share(rings, 8, readings, 6, room);
    assert.ok(r.first.window + r.second.window <= room + 1e-6);
    assert.ok(r.first.count >= last.a && r.second.count >= last.b);
    last = { a: r.first.count, b: r.second.count };
  }
});
test("arrange", () => {
  const parts = [20, 0, 52, 18, 40];
  let p = arrange(parts, 1, 100, 18, 400, 8, 1);
  assert.equal(p.room[1], 100); assert.equal(p.gap, 16); assert.equal(p.left[0], 53);
  p = arrange(parts, 1, 100, 18, 260, 8, 1);
  assert.equal(p.room[1], 98); assert.equal(p.gap, 8); assert.equal(p.left[0], 0);
  p = arrange(parts, 1, 500, 18, 400, 8, 1);
  assert.equal(p.room[1], 206); assert.equal(p.gap, 16);
  p = arrange([84, 40], -1, 0, 0, 300, 8, 1);
  assert.equal(p.gap, 16); assert.ok(Math.abs(p.left[0] - (300 - (84 + 16 + 40)) / 2) <= 0.5);
  assert.equal(arrange([40], -1, 0, 0, 100, 8, 1).left[0], 30);
  for (const dpi of [1, 1.25, 1.5, 1.75, 2]) for (let width = 160; width <= 700; width += 7) {
    const q = arrange(parts, 1, 230, 18, width, 8, dpi);
    assert.ok(q.room[1] >= 18); assert.ok(Math.abs(q.gap * dpi - Math.round(q.gap * dpi)) < 1e-9);
  }
});
test("row widths", () => {
  const items = [{ id: "cover", kind: "fixed", width: 20 }, { id: "title", kind: "title", text: 300 }, { id: "equalizer", kind: "fixed", width: 16 }] as const;
  assert.equal(requiredWidth([...items]), 20 + 18 + 16 + 16);
  assert.equal(naturalWidth([...items]), 20 + 160 + 16 + 16);
  const plan = planRow([{ id: "cover", kind: "fixed", width: 20 }, { id: "rings", kind: "carousel", items: [12, 12, 12], gap: 8 }, { id: "equalizer", kind: "fixed", width: 16 }, { id: "clock", kind: "fixed", width: 40 }], 70, 1);
  assert.deepEqual(plan.dropped, ["equalizer", "cover"]);   // 112 > 70, poi 88 > 70, poi 60 entra
  assert.equal(surfaceWidth("capsule", 100), 188); assert.equal(surfaceWidth("notch", 200), 256);
  assert.equal(surfaceWidth("capsule", 900), 700); assert.equal(surfaceWidth("notch", Number.NaN), 188);
});
test("plan row", () => {
  const items: RowItem[] = [
    { id: "cover", kind: "fixed", width: 20 }, { id: "title", kind: "title", text: 300 },
    { id: "rings", kind: "carousel", items: rings, gap: 8 }, { id: "readings", kind: "carousel", items: readings, gap: 6 },
    { id: "equalizer", kind: "fixed", width: 16 }, { id: "clock", kind: "fixed", width: 40 },
  ];
  for (const dpi of [1, 1.25, 2]) for (let width = 100; width <= 700; width += 13) {
    const plan = planRow(items, width, dpi), p = plan.parts;
    assert.equal(p.length, items.length - plan.dropped.length);
    for (let i = 0; i < p.length; i++) {
      if (i > 0) assert.ok(Math.abs(p[i].left - (p[i - 1].left + p[i - 1].width + plan.gap)) < 1e-9, "equal gaps, no overlap");
      if (p[i].window) assert.ok(p[i].width >= p[i].window!.window - 1e-9, "a window is never cut");
    }
    assert.ok(p[0].left >= 0 && p[p.length - 1].left + p[p.length - 1].width <= width + 1e-9, "inside the row");
    assert.deepEqual(plan.dropped, ["equalizer", "cover", "clock"].slice(0, plan.dropped.length));
  }
  assert.deepEqual(planRow(items, 700, 1).parts.map((x) => x.window?.count), [undefined, undefined, 4, 6, undefined, undefined]);
  assert.deepEqual(planRow(items, 400, 1).dropped, []);
});
test("plan visible drops a carousel with no whole item and its gap", () => {
  const items: RowItem[] = [{ id: "timer", kind: "fixed", width: 600 }, { id: "rings", kind: "carousel", items: [12, 12], gap: 8 }];
  assert.equal(planRow(items, 610, 1).parts[1].window?.count, 0);
  const plan = planVisible(items, 610, 1);
  assert.deepEqual(plan.parts.map((p) => [p.id, p.left]), [["timer", 5]]);
  assert.deepEqual(planVisible(items, 700, 1), planRow(items, 700, 1));
});
