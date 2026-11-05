import { test } from "node:test";
import assert from "node:assert/strict";
import { WATER_DEFAULTS, dayStart, formatMinutes, hourly, nextWaterAlert, normalizeWater, progress, prune, todayTotal, undoLast } from "./water.ts";

const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026
const cfg = { ...WATER_DEFAULTS, remind: true }; // 09:00 to 21:00, every 60 min
const H = 3_600_000;

test("today's total and progress, split at local midnight", () => {
  const log = [{ at: at(30, 23, 59), ml: 300 }, { at: at(31, 0, 0), ml: 250 }, { at: at(31, 14), ml: 500 }, { at: at(32, 0, 0), ml: 999 }];
  assert.equal(todayTotal(log, at(31, 18)), 750);
  assert.equal(progress(750, 2000), 0.375);
  assert.equal(progress(3000, 2000), 1);
  assert.equal(progress(10, 0), 0);
});

test("prune keeps seven calendar days", () => {
  const log = [{ at: at(24, 23), ml: 1 }, { at: at(25, 0, 1), ml: 2 }];
  assert.deepEqual(prune(log, at(31, 12)).map((d) => d.ml), [2]);
});

test("hourly chart covers the reminder hours and any drink outside them", () => {
  const now = at(31, 18);
  const bars = hourly([{ at: at(31, 9, 10), ml: 200 }, { at: at(31, 9, 50), ml: 100 }, { at: at(31, 22, 5), ml: 50 }, { at: at(30, 9), ml: 999 }], now, cfg);
  assert.equal(bars[0].hour, 9);
  assert.equal(bars.at(-1)!.hour, 22);
  assert.equal(bars[0].ml, 300);
  assert.equal(bars.find((b) => b.hour === 22)!.ml, 50);
  assert.equal(hourly([], now, { from: 22 * 60, to: 2 * 60 }).length, 24);
});

test("next reminder: after the last drink, inside the window", () => {
  assert.equal(nextWaterAlert(at(31, 15), at(31, 14, 30), cfg, []), at(31, 15, 30));
  // Close to the end → tomorrow, one interval after the window opens.
  assert.equal(nextWaterAlert(at(31, 20, 40), at(31, 20, 30), cfg, []), at(32, 10));
  // At night, nothing until tomorrow.
  assert.equal(nextWaterAlert(at(31, 23), at(31, 12), cfg, []), at(32, 10));
  // Nothing drunk since yesterday → overdue (in the past), shows at once.
  assert.ok(nextWaterAlert(at(31, 15), at(30, 20), cfg, [])! <= at(31, 15));
  // Before the window → one interval after it opens.
  assert.equal(nextWaterAlert(at(31, 7), null, cfg, []), at(31, 10));
  // Exactly at the end is still inside.
  assert.equal(nextWaterAlert(at(31, 20, 30), at(31, 20), cfg, []), at(31, 21));
});

test("goal reached: nothing until tomorrow; reminders off: never", () => {
  const full = [{ at: at(31, 11), ml: 2000 }];
  assert.equal(nextWaterAlert(at(31, 12), at(31, 11), cfg, full), at(32, 10));
  // Yesterday's full goal does not silence today.
  assert.equal(nextWaterAlert(at(32, 12), at(32, 11), cfg, full), at(32, 12));
  assert.equal(nextWaterAlert(at(31, 12), at(31, 11), { ...cfg, remind: false }, []), null);
});

test("undo puts the reminder base back and only touches today", () => {
  const log = [{ at: at(31, 9), ml: 500, prev: null }, { at: at(31, 11), ml: 500, prev: at(31, 9) }];
  assert.deepEqual(undoLast(log, at(31, 11), at(31, 12)), { log: [log[0]], lastAt: at(31, 9) });
  assert.deepEqual(undoLast(log, at(31, 11), at(32, 8)), { log, lastAt: at(31, 11) });
  // Entries saved before `prev` existed keep the current base.
  assert.equal(undoLast([{ at: at(31, 9), ml: 1 }], 5, at(31, 10)).lastAt, 5);
  assert.deepEqual(undoLast([], null, 0), { log: [], lastAt: null });
});

test("window past midnight", () => {
  const night = { ...cfg, from: 22 * 60, to: 2 * 60 };
  assert.equal(nextWaterAlert(at(31, 1), at(31, 0, 30), night, []), at(31, 1, 30));
  assert.equal(nextWaterAlert(at(31, 1, 30), at(31, 1, 30), night, []), at(31, 23));
  assert.equal(nextWaterAlert(at(31, 23), at(31, 22, 10), night, []), at(31, 23, 10));
});

test("goal reached before midnight: the window's tail after midnight stays quiet", () => {
  const night = { ...cfg, from: 22 * 60, to: 2 * 60 };
  const full = [{ at: at(31, 23), ml: 2000 }];
  // Just after midnight today's total is 0 again, but the window started yesterday, whose goal is met.
  for (const now of [at(32, 0, 0), at(32, 0, 1), at(32, 1, 30)]) assert.equal(nextWaterAlert(now, at(31, 23), night, full), at(32, 23), String(new Date(now)));
  // The same with day hours: midnight brings no reminder before the morning window.
  assert.equal(nextWaterAlert(at(32, 0, 0), at(31, 20), cfg, [{ at: at(31, 20), ml: 2000 }]), at(32, 10));
});

test("DST: the window opens at 09:00 local on the change day", () => {
  for (const d of [25, 26]) {
    const r = new Date(nextWaterAlert(at(d - 1, 23), at(d - 1, 20), { ...cfg, everyMin: 60 }, [])!);
    assert.equal(r.getHours(), 10);
    assert.equal(r.getDate(), d);
  }
  assert.equal(new Date(dayStart(at(25, 12), 1)).getHours(), 0);
  assert.ok(Math.abs(dayStart(at(25, 12), 1) - dayStart(at(25, 12)) - 24 * H) <= H);
});

test("config is repaired", () => {
  assert.deepEqual(normalizeWater(null), WATER_DEFAULTS);
  const c = normalizeWater({ remind: true, bottleMl: 5, goalMl: "x", from: 2000, everyMin: 30.4 });
  assert.equal(c.remind, true);
  assert.equal(c.bottleMl, 100);
  assert.equal(c.goalMl, WATER_DEFAULTS.goalMl);
  assert.equal(c.from, 24 * 60 - 1);
  assert.equal(c.everyMin, 30);
  assert.equal(formatMinutes(9 * 60 + 5), "09:05");
});
