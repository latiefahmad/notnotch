import { test } from "node:test";
import assert from "node:assert/strict";
import { streaks, todayCount, total, weekColumns, type Day } from "./contributions.ts";

/** Consecutive days from `first`, one count each. */
function run(first: string, counts: number[]): Day[] {
  const start = Date.parse(`${first}T00:00:00Z`);
  return counts.map((count, i) => ({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), count, level: count ? 1 : 0 }));
}

test("total and today", () => {
  const days = run("2026-10-25", [0, 3, 0, 5, 1, 0, 2]);
  assert.equal(total(days), 11);
  assert.equal(todayCount(days, "2026-10-31"), 2);
  assert.equal(todayCount(days, "2026-11-01"), 0);
});

test("current streak counts up to today", () => {
  const days = run("2026-10-25", [1, 0, 2, 2, 2, 2, 1]);
  assert.deepEqual(streaks(days, "2026-10-31"), { current: 5, longest: 5 });
});

test("an empty today does not break the streak", () => {
  const days = run("2026-10-25", [0, 0, 4, 1, 1, 1, 0]);
  assert.deepEqual(streaks(days, "2026-10-31"), { current: 4, longest: 4 });
  // Two empty days do.
  assert.deepEqual(streaks(run("2026-10-25", [0, 0, 4, 1, 1, 0, 0]), "2026-10-31"), { current: 0, longest: 3 });
});

test("longest streak across months and a gap in the data", () => {
  const days = [...run("2026-01-30", [1, 1, 1, 1, 1]), ...run("2026-03-01", [1, 1])];
  assert.deepEqual(streaks(days, "2026-03-02"), { current: 2, longest: 5 });
  assert.deepEqual(streaks([], "2026-03-02"), { current: 0, longest: 0 });
});

test("a shade without a readable count still counts as active", () => {
  assert.deepEqual(streaks([{ date: "2026-10-31", count: 0, level: 2 }], "2026-10-31"), { current: 1, longest: 1 });
});

test("week columns end with today's week", () => {
  // 2026-10-31 is a Saturday, 2026-10-28 a Wednesday.
  const days = run("2026-10-11", Array.from({ length: 21 }, (_, i) => i));
  const cols = weekColumns(days, "2026-10-31", 3);
  assert.equal(cols.length, 3);
  assert.deepEqual(cols.map((c) => c[0]!.date), ["2026-10-11", "2026-10-18", "2026-10-25"]);
  assert.equal(cols[2][6]!.date, "2026-10-31");
  assert.equal(cols[2][6]!.count, 20);

  const mid = weekColumns(days, "2026-10-28", 2);
  assert.deepEqual(mid[1].map((d) => d?.date ?? null), ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", null, null, null]);
  // Before the data starts: empty days, not null.
  assert.deepEqual(weekColumns([], "2026-10-28", 1)[0][0], { date: "2026-10-25", count: 0, level: 0 });
});
