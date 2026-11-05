import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTICE_DEFAULTS, MAX_APPS, inQuiet, minutes, normalizeNotices, rememberApp, route, ruleFor, setRule } from "./rules.ts";
import { HISTORY, addNotice, removeApp, type Notice } from "./history.ts";
import { duration, noticeText, popLine, shortTime } from "./format.ts";

const tr = (de: string, vars?: Record<string, string | number>) => (vars ? `${de} ${JSON.stringify(vars)}` : de);
const n = (p: Partial<Notice> = {}): Notice => ({ id: p.id ?? "1", source: "windows", appId: "App", appName: "App", title: "T", body: "B", at: 0, ...p });

test("rule lookup is case-insensitive and defaults to show", () => {
  const rules = setRule(setRule({}, "Microsoft.Teams", "mute"), "cli:ci", "hide");
  assert.equal(ruleFor(rules, "microsoft.teams"), "mute");
  assert.equal(ruleFor(rules, "CLI:CI"), "hide");
  assert.equal(ruleFor(rules, "other"), "show");
  assert.deepEqual(setRule(rules, "MICROSOFT.TEAMS", "show"), { "cli:ci": "hide" });
});

test("routing", () => {
  const on = { ...NOTICE_DEFAULTS, enabled: true, rules: { muted: "mute" as const, gone: "hide" as const } };
  const ctx = { presenting: false, now: 12 * 60 };
  assert.equal(route("x", NOTICE_DEFAULTS, ctx), "drop");
  assert.equal(route("x", on, ctx), "pop");
  assert.equal(route("Muted", on, ctx), "history");
  assert.equal(route("gone", on, ctx), "drop");
  assert.equal(route("gone", on, { ...ctx, presenting: true }), "drop");
  assert.equal(route("x", on, { ...ctx, presenting: true }), "history");
  const quiet = { ...on, quiet: { on: true, from: "22:00", to: "07:00" } };
  assert.equal(route("x", quiet, { presenting: false, now: 23 * 60 }), "history");
  assert.equal(route("x", quiet, { presenting: false, now: 8 * 60 }), "pop");
});

test("a fullscreen app or Windows focus keeps notices in the history", () => {
  const on = { ...NOTICE_DEFAULTS, enabled: true, rules: { gone: "hide" as const } };
  const ctx = { presenting: false, now: 12 * 60 };
  assert.equal(route("x", on, { ...ctx, fullscreen: true }), "history");
  assert.equal(route("x", on, { ...ctx, focus: true }), "history");
  assert.equal(route("x", on, { ...ctx, fullscreen: false, focus: false }), "pop");
  assert.equal(route("gone", on, { ...ctx, fullscreen: true, focus: true }), "drop");
  assert.equal(route("x", NOTICE_DEFAULTS, { ...ctx, focus: true }), "drop");
});

test("quiet window", () => {
  assert.equal(minutes("7:05"), 425);
  assert.equal(minutes("24:00"), null);
  assert.equal(minutes("12:60"), null);
  assert.equal(minutes("noon"), null);
  assert.equal(inQuiet(23 * 60, "22:00", "07:00"), true);
  assert.equal(inQuiet(3 * 60, "22:00", "07:00"), true);
  assert.equal(inQuiet(7 * 60, "22:00", "07:00"), false);
  assert.equal(inQuiet(13 * 60, "12:00", "14:00"), true);
  assert.equal(inQuiet(14 * 60, "12:00", "14:00"), false);
  assert.equal(inQuiet(5, "10:00", "10:00"), false);
  assert.equal(inQuiet(5, "bad", "10:00"), false);
});

test("normalizing saved settings", () => {
  assert.deepEqual(normalizeNotices(undefined), NOTICE_DEFAULTS);
  const s = normalizeNotices({ enabled: true, quiet: { on: true, from: "x", to: "06:30" }, rules: { A: "mute", b: "show", c: "boom" }, apps: { A: "Alpha", b: 3 } });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.quiet, { on: true, from: "22:00", to: "06:30" });
  assert.deepEqual(s.rules, { a: "mute" });
  assert.deepEqual(s.apps, { a: "Alpha" });
});

test("apps seen", () => {
  const apps = { a: "A" };
  assert.equal(rememberApp(apps, "A", "A"), apps);
  assert.deepEqual(rememberApp(apps, "B", "Bee"), { a: "A", b: "Bee" });
  let many: Record<string, string> = {};
  for (let i = 0; i < MAX_APPS + 5; i++) many = rememberApp(many, `app${i}`, `${i}`);
  assert.equal(Object.keys(many).length, MAX_APPS);
  assert.equal(many.app0, undefined);
  assert.equal(many[`app${MAX_APPS + 4}`], `${MAX_APPS + 4}`);
});

test("history: replace key, age and cap", () => {
  let list = addNotice([], n({ id: "1", replace: "build", progress: 10, at: 1 }), 1);
  list = addNotice(list, n({ id: "2", at: 2 }), 2);
  list = addNotice(list, n({ id: "3", replace: "build", progress: 50, at: 3 }), 3);
  assert.deepEqual(list.map((x) => x.id), ["3", "2"]);
  // Same key from another app is another notice.
  list = addNotice(list, n({ id: "4", appId: "Other", replace: "build", at: 4 }), 4);
  assert.equal(list.length, 3);
  list = addNotice(list, n({ id: "5", at: HISTORY.maxAgeMs + 3 }), HISTORY.maxAgeMs + 3);
  assert.deepEqual(list.map((x) => x.id), ["5", "4"]);
  let big: Notice[] = [];
  for (let i = 0; i < HISTORY.max + 10; i++) big = addNotice(big, n({ id: `${i}`, at: i }), i);
  assert.equal(big.length, HISTORY.max);
  assert.equal(big[0].id, `${HISTORY.max + 9}`);
  assert.deepEqual(removeApp(list, "other").map((x) => x.id), ["5"]);
});

test("words", () => {
  assert.equal(duration(850), "850 ms");
  assert.equal(duration(12_400), "12 s");
  assert.equal(duration(72_000), "1 min 12 s");
  assert.equal(duration(3 * 3600_000 + 5 * 60_000), "3 h 5 min");
  const day = new Date(2026, 9, 31, 14, 5).getTime();
  assert.equal(shortTime(day, day + 30_000, "24", tr), "Jetzt");
  assert.equal(shortTime(day, day + 5 * 60_000, "24", tr), '{n} Min. {"n":5}');
  assert.equal(shortTime(day, day + 3 * 3600_000, "24", tr), "14:05");
  assert.equal(shortTime(day, day + 3 * 3600_000, "12", tr), "2:05 pm");
  assert.equal(shortTime(day, new Date(2026, 10, 1, 9).getTime(), "24", tr), 'Gestern {t} {"t":"14:05"}');
  // Older: day and month in the language's order, and its own day period.
  const older = new Date(2026, 10, 5, 9).getTime();
  assert.equal(shortTime(day, older, "24", tr, "en-GB"), `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric" }).format(day)} 14:05`);
  assert.match(shortTime(day, day + 3 * 3600_000, "12", tr, "ja"), /^午後/);
  assert.equal(noticeText(n({ exitCode: 0, durationMs: 1500 }), tr), 'Fertig nach {d} {"d":"2 s"}');
  assert.equal(noticeText(n({ exitCode: 2, durationMs: 100 }), tr), 'Fehlgeschlagen (Code {c}) nach {d} {"c":2,"d":"100 ms"}');
  assert.equal(popLine(n({ title: "Mail", body: "Hello\nmore" }), tr), "Mail · Hello");
  assert.equal(popLine(n({ title: "", body: "Only" }), tr), "Only");
});
