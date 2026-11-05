import { test } from "node:test";
import assert from "node:assert/strict";
import { HALF_HOURS, activeThemeId, chooseTheme, isNight, nextChange, parseTime } from "./daynight.ts";
import { THEME_DEFAULTS } from "./themes.ts";

const at = (h: number, m = 0, day = 15) => new Date(2026, 9, day, h, m);
const schedule = (dayStart: string, nightStart: string) => ({ on: true, day: "light", night: "dark", dayStart, nightStart });

test("parseTime", () => {
  assert.equal(parseTime("07:30"), 450);
  assert.equal(parseTime("7:05"), 425);
  for (const bad of ["24:00", "12:60", "noon", "", "1230"]) assert.equal(parseTime(bad), null, bad);
});

test("isNight with a normal day", () => {
  const s = schedule("07:00", "19:00");
  assert.equal(isNight(s, at(6, 59)), true);
  assert.equal(isNight(s, at(7, 0)), false);
  assert.equal(isNight(s, at(18, 59)), false);
  assert.equal(isNight(s, at(19, 0)), true);
  assert.equal(isNight(s, at(0, 0)), true);
});

test("isNight with a day past midnight", () => {
  const s = schedule("20:00", "08:00");
  assert.equal(isNight(s, at(21)), false);
  assert.equal(isNight(s, at(3)), false);
  assert.equal(isNight(s, at(8)), true);
  assert.equal(isNight(s, at(19, 59)), true);
});

test("equal or invalid times fall back to the defaults", () => {
  assert.equal(isNight(schedule("10:00", "10:00"), at(12)), false);
  assert.equal(isNight(schedule("x", "10:00"), at(20)), true);
});

test("nextChange", () => {
  const s = schedule("07:00", "19:00");
  assert.deepEqual(nextChange(s, at(12)), at(19));
  assert.deepEqual(nextChange(s, at(19)), at(7, 0, 16));
  assert.deepEqual(nextChange(s, at(6, 59)), at(7));
  assert.deepEqual(nextChange(s, at(23, 30)), at(7, 0, 16));
});

test("active theme and choosing", () => {
  const off = THEME_DEFAULTS;
  assert.equal(activeThemeId(off, at(23)), "dark");
  const on = { ...off, schedule: { ...off.schedule, on: true } };
  assert.equal(activeThemeId(on, at(12)), "light");
  assert.equal(activeThemeId(on, at(23)), "dark");
  assert.equal(chooseTheme(off, "dracula", at(12)).id, "dracula");
  assert.equal(chooseTheme(on, "dracula", at(12)).schedule.day, "dracula");
  assert.equal(chooseTheme(on, "dracula", at(23)).schedule.night, "dracula");
  assert.equal(HALF_HOURS.length, 48);
  assert.equal(HALF_HOURS[15], "07:30");
});
