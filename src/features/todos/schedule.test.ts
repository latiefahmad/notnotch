import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_WAIT_MS, SNOOZE_MS, dayDiff, defaultDay, dueAt, dueReminders, nextAlert, parseTime, snoozeAt, wait } from "./schedule.ts";

const at = (y: number, mo: number, d: number, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const task = (alertAt: number | null, done = false) => ({ done, alertAt });

test("parse time", () => {
  assert.deepEqual(parseTime("9"), { h: 9, m: 0 });
  assert.deepEqual(parseTime("930"), { h: 9, m: 30 });
  assert.deepEqual(parseTime(" 09:30 "), { h: 9, m: 30 });
  assert.deepEqual(parseTime("21.05"), { h: 21, m: 5 });
  assert.deepEqual(parseTime("9pm"), { h: 21, m: 0 });
  assert.deepEqual(parseTime("9:15 PM"), { h: 21, m: 15 });
  assert.deepEqual(parseTime("12am"), { h: 0, m: 0 });
  assert.deepEqual(parseTime("12pm"), { h: 12, m: 0 });
  for (const bad of ["", "24", "9:60", "13pm", "0am", "abc", "9:5", "12:300"]) assert.equal(parseTime(bad), null, bad);
});

test("due at a wall-clock time, across month and year ends", () => {
  const now = at(2026, 12, 31, 22, 0);
  assert.equal(dueAt(now, 0, 23, 30), at(2026, 12, 31, 23, 30));
  assert.equal(dueAt(now, 1, 8, 0), at(2027, 1, 1, 8, 0));
  assert.equal(dayDiff(now, at(2027, 1, 1, 0, 5)), 1);
  assert.equal(dayDiff(now, at(2026, 12, 31, 0, 0)), 0);
  assert.equal(dayDiff(now, at(2026, 12, 30, 23, 59)), -1);
});

test("default day: today while ahead, else tomorrow (midnight edge)", () => {
  const now = at(2026, 10, 31, 14, 0);
  assert.equal(defaultDay(now, 15, 0), 0);
  assert.equal(defaultDay(now, 14, 0), 1);
  assert.equal(defaultDay(now, 9, 0), 1);
  assert.equal(defaultDay(at(2026, 10, 31, 23, 59), 0, 0), 1);
});

test("DST: tomorrow at 9 stays 9 local even when the day has 23 or 25 hours", () => {
  // Whatever the machine's zone, the result must read 9:00 on the next calendar day.
  for (const [mo, d] of [[3, 28], [3, 29], [10, 24], [10, 25], [11, 1]] as const) {
    const now = at(2026, mo, d, 20, 0);
    const r = new Date(dueAt(now, 1, 9, 0));
    assert.equal(r.getHours(), 9);
    assert.equal(r.getMinutes(), 0);
    assert.equal(dayDiff(now, r.getTime()), 1);
  }
});

test("due reminders, oldest first; done and future ignored", () => {
  const list = [task(300), task(100), task(200, true), task(null), task(900)];
  assert.deepEqual(dueReminders(list, 500).map((t) => t.alertAt), [100, 300]);
  assert.equal(nextAlert(list, 500), 900);
  assert.equal(nextAlert([task(100), task(null)], 500), null);
});

test("snooze and wait", () => {
  assert.equal(snoozeAt(1000), 1000 + SNOOZE_MS);
  const list = [task(snoozeAt(1000))];
  assert.deepEqual(dueReminders(list, 1000 + SNOOZE_MS - 1), []);
  assert.equal(dueReminders(list, 1000 + SNOOZE_MS).length, 1);
  assert.equal(wait(null, 0), null);
  assert.equal(wait(5000, 1000), 4000);
  assert.equal(wait(10 * 86_400_000, 0), MAX_WAIT_MS);
  assert.equal(wait(0, 1000), 0);
});
