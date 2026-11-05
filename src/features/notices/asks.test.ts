import { test } from "node:test";
import assert from "node:assert/strict";
import { addAsk, optionLabel, removeAsk, type Ask } from "./asks.ts";

const a = (id: number): Ask => ({ id, appId: "cli:agent", appName: "Agent", title: "Run?", body: "", options: ["allow", "deny"], at: id });

test("queue keeps the oldest first and drops answered ones", () => {
  let list = addAsk([], a(2));
  list = addAsk(list, a(1));
  list = addAsk(list, a(3));
  assert.deepEqual(list.map((x) => x.id), [1, 2, 3]);
  // The same id again replaces, never doubles.
  assert.equal(addAsk(list, a(2)).length, 3);
  list = removeAsk(list, 1);
  assert.deepEqual(list.map((x) => x.id), [2, 3]);
  assert.deepEqual(removeAsk(list, 9).map((x) => x.id), [2, 3]);
});

test("labels", () => {
  const tr = (de: string) => `[${de}]`;
  assert.equal(optionLabel("allow", tr), "[Erlauben]");
  assert.equal(optionLabel("always", tr), "[Immer erlauben]");
  assert.equal(optionLabel("deny", tr), "[Ablehnen]");
  assert.equal(optionLabel("retry-2", tr), "retry-2");
});
