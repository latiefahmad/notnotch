import { test } from "node:test";
import assert from "node:assert/strict";
import { altGrRisk, combinations, conflicts, launcherKeys, keycaps, label, normalize, parse, record, type KeyLike } from "./hotkeys.ts";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("parse accepts any order and case and gives the fixed order back", () => {
  assert.deepEqual(parse("alt+CONTROL+KeyK"), { mods: ["Ctrl", "Alt"], key: "KeyK" });
  assert.equal(normalize("open", "shift+win+ctrl+Digit1"), "Ctrl+Shift+Win+Digit1");
  assert.equal(normalize("open", "Super+Space"), "Win+Space");
});

test("parse rejects repeats, gaps, unknown keys and a modifier as the key", () => {
  for (const bad of ["Ctrl+Ctrl+KeyK", "Ctrl++KeyK", "Ctrl+Alt", "Ctrl+K", "Ctrl+IntlBackslash", "Ctrl+Key K", "", "   "]) assert.equal(parse(bad), null, bad);
});

test("a key alone is only allowed for F1 to F24", () => {
  assert.equal(normalize("open", "F9"), "F9");
  assert.equal(normalize("open", "F24"), "F24");
  assert.equal(normalize("open", "F25"), "");
  assert.equal(normalize("open", "KeyK"), "");
  assert.equal(normalize("hide", "Space"), "");
});

test("the resize shortcut needs Alt and one more modifier", () => {
  assert.equal(normalize("resize", "Ctrl+Alt+Arrows"), "Ctrl+Alt+Arrows");
  assert.equal(normalize("resize", "Alt+Arrows"), "");
  assert.equal(normalize("resize", "Ctrl+Shift+Arrows"), "");
  assert.equal(normalize("resize", "Ctrl+Alt+KeyK"), "");
  assert.equal(normalize("open", "Ctrl+Alt+Arrows"), "");
  assert.deepEqual(combinations("resize", "Alt+Shift+Arrows"), ["Alt+Shift+ArrowLeft", "Alt+Shift+ArrowRight", "Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown"]);
});

test("recording a key press", () => {
  assert.equal(record("open", key("ControlLeft", { ctrlKey: true })), null);
  assert.deepEqual(record("open", key("KeyK", { ctrlKey: true, altKey: true })), { text: "Ctrl+Alt+KeyK" });
  // German layout: the key in the US Y place types z. Windows saves what was typed, a Mac the place.
  assert.deepEqual(record("open", key("KeyY", { key: "z", ctrlKey: true, altKey: true }), true), { text: "Ctrl+Alt+KeyZ" });
  assert.deepEqual(record("open", key("KeyY", { key: "z", ctrlKey: true, altKey: true })), { text: "Ctrl+Alt+KeyY" });
  assert.deepEqual(record("open", key("Digit1", { key: "&", ctrlKey: true, altKey: true }), true), { text: "Ctrl+Alt+Digit1" });
  assert.deepEqual(record("open", key("KeyK")), { error: "need-modifier" });
  assert.deepEqual(record("open", key("F5")), { text: "F5" });
  assert.deepEqual(record("hide", key("IntlRo", { ctrlKey: true })), { error: "unsupported-key" });
  assert.deepEqual(record("resize", key("ArrowUp", { ctrlKey: true, altKey: true })), { text: "Ctrl+Alt+Arrows" });
  assert.deepEqual(record("resize", key("ArrowUp", { ctrlKey: true })), { error: "resize-modifiers" });
  assert.deepEqual(record("resize", key("KeyK", { ctrlKey: true, altKey: true })), { error: "resize-arrow" });
});

test("conflicts: the later shortcut yields to the earlier one", () => {
  assert.deepEqual(conflicts({ open: "Ctrl+Alt+Space", hide: "alt+ctrl+Space", resize: "", find: "" }), { open: null, hide: "open", resize: null, find: null });
  // One arrow of the resize shortcut taken is enough.
  assert.deepEqual(conflicts({ open: "Ctrl+Alt+ArrowLeft", hide: "", resize: "Ctrl+Alt+Arrows", find: "" }), { open: null, hide: null, resize: "open", find: null });
  // Find on screen comes last.
  assert.deepEqual(conflicts({ open: "", hide: "Ctrl+Alt+KeyF", resize: "", find: "Ctrl+Alt+KeyF" }), { open: null, hide: null, resize: null, find: "hide" });
  // Invalid or unset ones collide with nothing.
  assert.deepEqual(conflicts({ open: "", hide: "", resize: "", find: "" }), { open: null, hide: null, resize: null, find: null });
  assert.deepEqual(conflicts({ open: "KeyK", hide: "KeyK", resize: "", find: "" }), { open: null, hide: null, resize: null, find: null });
  // The launcher's Alt+N keys, while on, come first.
  assert.deepEqual(conflicts({ open: "Alt+Digit2", hide: "Alt+Digit5", resize: "", find: "" }, launcherKeys(3)), { open: "launcher", hide: null, resize: null, find: null });
  assert.deepEqual(launcherKeys(9), ["Alt+Digit1", "Alt+Digit2", "Alt+Digit3", "Alt+Digit4", "Alt+Digit5", "Alt+Digit6"]);
});

test("Ctrl+Alt with a character key warns about AltGr", () => {
  assert.equal(altGrRisk("open", "Ctrl+Alt+KeyQ"), true);
  assert.equal(altGrRisk("hide", "Ctrl+Alt+Digit2"), true);
  assert.equal(altGrRisk("open", "Ctrl+Alt+Space"), false);
  assert.equal(altGrRisk("open", "Ctrl+Alt+F5"), false);
  assert.equal(altGrRisk("open", "Ctrl+Alt+Shift+KeyQ"), false);
  assert.equal(altGrRisk("open", "Ctrl+Alt+Win+KeyQ"), false);
  assert.equal(altGrRisk("resize", "Ctrl+Alt+Arrows"), false);
  assert.equal(altGrRisk("open", ""), false);
});

test("labels", () => {
  assert.deepEqual(keycaps("Ctrl+Alt+Space"), ["Ctrl", "Alt", "Space"]);
  assert.deepEqual(keycaps("Ctrl+Alt+Arrows", "Arrows"), ["Ctrl", "Alt", "Arrows"]);
  assert.equal(label("Ctrl+Shift+Digit1"), "Ctrl+Shift+1");
  assert.equal(label("Win+Backquote"), "Win+`");
  assert.deepEqual(keycaps(""), []);
});
