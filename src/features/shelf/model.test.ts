import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ITEMS, MAX_TEXT, addFiles, addText, dragPayload, keyOf, normalizeItems, removeKeys, type ShelfItem } from "./model.ts";

const file = (path: string) => ({ path, name: path.split("\\").pop()!, kind: "other" as const, ext: "", size: 1 });

test("old saved items stay, broken ones go", () => {
  const saved = [{ ...file("C:\\a.txt"), addedAt: 1 }, { type: "text", id: "t1", text: "hi", addedAt: 2 }, null, { foo: 1 }, { type: "text", id: 3 }];
  const items = normalizeItems(saved);
  assert.deepEqual(items.map(keyOf), ["C:\\a.txt", "t1"]);
  assert.deepEqual(normalizeItems("nope"), []);
});

test("files: new ones in front, known ones keep their place", () => {
  let list: ShelfItem[] = addFiles([], [file("C:\\a"), file("C:\\b")], 1);
  assert.deepEqual(list.map(keyOf), ["C:\\a", "C:\\b"]);
  const same = addFiles(list, [file("C:\\b")], 2);
  assert.equal(same, list); // dropped back from a drag out: nothing changes
  list = addFiles(list, [file("C:\\c"), file("C:\\a"), file("C:\\c")], 3);
  assert.deepEqual(list.map(keyOf), ["C:\\c", "C:\\a", "C:\\b"]);
});

test("cap", () => {
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => file(`C:\\${i}`));
  assert.equal(addFiles([], many, 1).length, MAX_ITEMS);
});

test("text cards", () => {
  let list: ShelfItem[] = addText([], "  hello\r\nworld  ", 1, "t1");
  assert.deepEqual(list, [{ type: "text", id: "t1", text: "hello\nworld", addedAt: 1 }]);
  assert.equal(addText(list, "   ", 2, "t2"), list);
  assert.equal(addText(list, "hello\nworld", 2, "t2"), list);
  list = addText(list, "x".repeat(MAX_TEXT + 10), 3, "t3");
  assert.equal((list[0] as { text: string }).text.length, MAX_TEXT);
});

test("remove and drag payload", () => {
  let list: ShelfItem[] = addFiles([], [file("C:\\a"), file("C:\\b")], 1);
  list = addText(list, "one", 2, "t1");
  list = addText(list, "two", 3, "t2");
  assert.deepEqual(dragPayload(list, ["C:\\a", "t1"]), { paths: ["C:\\a"], text: null });
  // Display order: newest text first.
  assert.deepEqual(dragPayload(list, ["t1", "t2"]), { paths: [], text: "two\n\none" });
  assert.deepEqual(dragPayload(list, []), { paths: [], text: null });
  assert.deepEqual(removeKeys(list, ["t2", "C:\\b"]).map(keyOf), ["t1", "C:\\a"]);
});
