import { test } from "node:test";
import assert from "node:assert/strict";
import { NONE, clickSelect, dragKeys, prune } from "./selection.ts";

const order = ["a", "b", "c", "d", "e"];
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };
const both = { toggle: true, range: true };

test("ctrl+click toggles and moves the anchor", () => {
  let s = clickSelect(NONE, order, "c", toggle);
  assert.deepEqual(s, { keys: ["c"], anchor: "c" });
  s = clickSelect(s, order, "a", toggle);
  assert.deepEqual(s, { keys: ["a", "c"], anchor: "a" }); // display order, not click order
  s = clickSelect(s, order, "c", toggle);
  assert.deepEqual(s, { keys: ["a"], anchor: "c" });
});

test("shift+click selects the range from the anchor, both directions", () => {
  let s = clickSelect(NONE, order, "b", toggle);
  s = clickSelect(s, order, "d", range);
  assert.deepEqual(s, { keys: ["b", "c", "d"], anchor: "b" });
  // Another shift+click replaces the range, the anchor stays.
  s = clickSelect(s, order, "a", range);
  assert.deepEqual(s, { keys: ["a", "b"], anchor: "b" });
});

test("shift+click without an anchor picks just that card", () => {
  assert.deepEqual(clickSelect(NONE, order, "c", range), { keys: ["c"], anchor: "c" });
  // Anchor that left the shelf counts as none.
  assert.deepEqual(clickSelect({ keys: [], anchor: "zz" }, order, "c", range), { keys: ["c"], anchor: "c" });
});

test("ctrl+shift+click adds the range", () => {
  let s = clickSelect(NONE, order, "e", toggle);
  s = clickSelect(s, order, "a", toggle);
  s = clickSelect(s, order, "b", both);
  assert.deepEqual(s, { keys: ["a", "b", "e"], anchor: "a" });
});

test("prune and drag keys", () => {
  const s = { keys: ["b", "d"], anchor: "d" };
  assert.deepEqual(prune(s, ["a", "b", "c"]), { keys: ["b"], anchor: null });
  assert.equal(prune(s, order), s);
  assert.deepEqual(dragKeys(s, "d"), ["b", "d"]);
  assert.deepEqual(dragKeys(s, "a"), ["a"]);
});
