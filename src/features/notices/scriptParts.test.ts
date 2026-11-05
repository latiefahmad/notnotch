import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SCRIPT_PARTS, applyPart, livePart, nextExpiry, type PartMessage } from "./scriptParts.ts";

const m = (id: string, o: Partial<PartMessage> = {}): PartMessage => ({ id, source: "CI", text: id, clear: false, ...o });

test("set, update in place, clear", () => {
  let list = applyPart([], m("a"), 0);
  list = applyPart(list, m("b"), 1);
  list = applyPart(list, m("a", { text: "again", progress: 50 }), 2);
  assert.deepEqual(list.map((p) => [p.id, p.text, p.progress]), [["a", "again", 50], ["b", "b", null]]);
  list = applyPart(list, m("a", { clear: true }), 3);
  assert.deepEqual(list.map((p) => p.id), ["b"]);
  assert.deepEqual(applyPart(list, m("missing", { clear: true }), 4).map((p) => p.id), ["b"]);
});

test("count cap drops the one set longest ago", () => {
  let list = applyPart([], m("a"), 0);
  for (let i = 1; i < MAX_SCRIPT_PARTS; i++) list = applyPart(list, m(`p${i}`), i);
  // Touching "a" makes p1 the oldest.
  list = applyPart(list, m("a"), 10);
  list = applyPart(list, m("new"), 11);
  assert.equal(list.length, MAX_SCRIPT_PARTS);
  assert.ok(!list.some((p) => p.id === "p1"));
  assert.ok(list.some((p) => p.id === "a") && list.some((p) => p.id === "new"));
});

test("ttl", () => {
  const list = applyPart(applyPart([], m("short", { ttl: 5 }), 1000), m("long", { ttl: 60 }), 1000);
  assert.equal(nextExpiry(list), 6000);
  assert.deepEqual(list.filter(livePart(6000)).map((p) => p.id), ["long"]);
  // Expired parts go with the next message.
  assert.deepEqual(applyPart(list, m("x"), 7000).map((p) => p.id), ["long", "x"]);
  assert.equal(nextExpiry([]), null);
  assert.equal(applyPart([], m("forever"), 0)[0].expires, null);
});
