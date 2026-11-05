import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_APP_RULES, WINDOW_DEFAULTS, addRule, cycle, exeName, newRule, normalizeWindow, ruleKey } from "./model.ts";

test("without a saved group the rules follow the old visibility setting", () => {
  assert.deepEqual(normalizeWindow(undefined).rules, WINDOW_DEFAULTS.rules);
  // The old setting only read the window in front, so the check behind starts off.
  assert.deepEqual(normalizeWindow(undefined, "hide-fullscreen").rules, { maximized: "normal", borderless: "hide", exclusive: "hide", background: false });
  assert.equal(WINDOW_DEFAULTS.rules.background, true);
  // Once saved, the old setting no longer matters.
  assert.equal(normalizeWindow({ rules: { borderless: "line" } }, "hide-fullscreen").rules.borderless, "line");
});

test("broken values fall back, valid ones stay", () => {
  const w = normalizeWindow({ rules: { maximized: "bogus", exclusive: "hide", background: "yes" }, scale: 150, closeDelay: "slow", wheelTools: false });
  assert.deepEqual(w.rules, { maximized: "normal", borderless: "normal", exclusive: "hide", background: true });
  assert.equal(w.scale, 150);
  assert.equal(w.closeDelay, "fast");
  assert.equal(w.wheelTools, false);
  assert.equal(w.rightClickSettings, true);
});

test("hotkeys: missing open takes the default, an empty one stays unset, invalid ones are dropped", () => {
  assert.equal(normalizeWindow({}).hotkeys.open, "Ctrl+Alt+Space");
  assert.equal(normalizeWindow({ hotkeys: { open: "" } }).hotkeys.open, "");
  assert.deepEqual(normalizeWindow({ hotkeys: { open: "KeyK", hide: "ctrl+alt+KeyH", resize: "Alt+Arrows" } }).hotkeys, { open: "", hide: "Ctrl+Alt+KeyH", resize: "", find: "Ctrl+Alt+KeyF" });
  assert.equal(normalizeWindow({ hotkeys: { find: "" } }).hotkeys.find, "");
});

test("app rules: keys, duplicates, follow values and the cap", () => {
  assert.equal(ruleKey({ name: "Foo", path: "C:/Games/Foo.EXE" }), "path:c:\\games\\foo.exe");
  assert.equal(ruleKey({ name: "Foo.exe", path: "" }), "name:foo");
  assert.equal(exeName("C:\\Games\\Foo.exe"), "Foo");
  const rule = newRule("vlc.exe");
  assert.deepEqual(rule, { name: "vlc", path: "", maximized: "normal", borderless: "normal", exclusive: "normal" });
  assert.equal(addRule([rule], newRule("VLC")).length, 1);
  assert.equal(addRule([], newRule("")).length, 0);
  const full = Array.from({ length: MAX_APP_RULES }, (_, i) => newRule(`app${i}`));
  assert.equal(addRule(full, newRule("one-more")).length, MAX_APP_RULES);
  const saved = normalizeWindow({ apps: [{ name: "mpv", path: "", maximized: "line", borderless: "x" }, { name: "MPV.exe" }, null] }).apps;
  assert.deepEqual(saved, [{ name: "mpv", path: "", maximized: "line", borderless: null, exclusive: null }]);
});

test("cycling tools wraps and skips when there is nothing to switch to", () => {
  assert.equal(cycle(["a", "b", "c"], "c", 1), "a");
  assert.equal(cycle(["a", "b", "c"], "a", -1), "c");
  assert.equal(cycle(["a", "b"], "settings", 1), "a");
  assert.equal(cycle(["a"], "a", 1), null);
});
