import { test } from "node:test";
import assert from "node:assert/strict";
import { COALESCE_MS, original, record, startHistory, undo } from "./history.ts";

test("undo steps back and stops at the start", () => {
  let h = startHistory("a");
  h = record(h, "b", 1000, "x");
  h = record(h, "c", 1000 + COALESCE_MS, "x");
  assert.equal(h.present, "c");
  h = undo(h);
  assert.equal(h.present, "b");
  h = undo(h);
  assert.equal(h.present, "a");
  assert.equal(undo(h), h);
});

test("quick changes to the same key are one step", () => {
  let h = startHistory(0);
  for (let i = 1; i <= 10; i++) h = record(h, i, 1000 + i * 50, "accent");
  assert.equal(h.present, 10);
  assert.deepEqual(h.past, [0]);
  assert.equal(original(h), 0);
  h = record(h, 11, 5000, "accent");
  assert.deepEqual(h.past, [0, 10]);
  // After an undo the next change is a step of its own.
  h = undo(h);
  h = record(h, 12, 5010, "accent");
  assert.deepEqual(h.past, [0, 10]);
});

test("a quick change to another key is its own step", () => {
  let h = startHistory(0);
  h = record(h, 1, 1000, "accent");
  h = record(h, 2, 1100, "warning");
  h = record(h, 3, 1150, "warning");
  assert.deepEqual(h.past, [0, 1]);
  assert.equal(undo(h).present, 1);
});
