import { test } from "node:test";
import assert from "node:assert/strict";
import { hotkeysPaused, shortcutIds, slotStatus } from "./shortcuts.ts";

const favs = Array.from({ length: 8 }, (_, i) => ({ id: `app${i}`, name: `App ${i}` }));

test("first six favourites get Alt+1 to Alt+6", () => {
  assert.deepEqual(shortcutIds(favs, true), ["app0", "app1", "app2", "app3", "app4", "app5"]);
  assert.deepEqual(shortcutIds(favs.slice(0, 2), true), ["app0", "app1"]);
  assert.deepEqual(shortcutIds(favs, false), []);
  assert.deepEqual(shortcutIds([], true), []);
});

test("keys rest in fullscreen and in gaming mode", () => {
  assert.equal(hotkeysPaused("off", false), false);
  assert.equal(hotkeysPaused("fullscreen", false), false);
  assert.equal(hotkeysPaused("off", true), true);
  assert.equal(hotkeysPaused("on", false), true);
});

test("status per favourite", () => {
  const ids = shortcutIds(favs, true);
  const s = slotStatus(favs, true, { ids, ok: [true, false, true, true, true, true] });
  assert.deepEqual(s.map((x) => x.label), ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+6", null, null]);
  assert.deepEqual(s.map((x) => x.taken), [false, true, false, false, false, false, false, false]);
});

test("an answer for other ids is not shown as taken", () => {
  const stale = { ids: ["app1", "app0"], ok: [false, false] };
  assert.ok(slotStatus(favs.slice(0, 2), true, stale).every((x) => !x.taken));
  assert.ok(slotStatus(favs.slice(0, 2), true, null).every((x) => !x.taken && x.label));
  assert.ok(slotStatus(favs.slice(0, 2), false, { ids: [], ok: [] }).every((x) => x.label === null && !x.taken));
});
