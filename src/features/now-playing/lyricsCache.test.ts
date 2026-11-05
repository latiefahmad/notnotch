import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_PREFIX, NONE_TTL, createLyricsCache, type KeyValue } from "./lyricsCache.ts";

function store(limit = Infinity): KeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem(k, v) {
      if (!map.has(k) && map.size >= limit) throw new Error("full");
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

const found = (at = 0) => ({ lrc: "[00:01.00]a", instrumental: false, at });
const none = (at: number) => ({ lrc: null, instrumental: false, at });

test("memory and disk", () => {
  const disk = store();
  createLyricsCache(disk).set("k", found());
  // A new session reads it back from disk.
  assert.deepEqual(createLyricsCache(disk).get("k"), found());
  assert.equal(createLyricsCache(disk).get("other"), undefined);
  assert.deepEqual(createLyricsCache(null).get("k"), undefined);
});

test("least recently used goes first", () => {
  const disk = store();
  const cache = createLyricsCache(disk, 3);
  cache.set("a", found());
  cache.set("b", found());
  cache.set("c", found());
  createLyricsCache(disk, 3).get("a"); // a is used again
  cache.set("d", found());
  assert.equal(disk.map.has(CACHE_PREFIX + "b"), false);
  for (const k of ["a", "c", "d"]) assert.equal(disk.map.has(CACHE_PREFIX + k), true);
  assert.deepEqual(JSON.parse(disk.map.get(CACHE_PREFIX + "index")!), ["c", "a", "d"]);
});

test("no lyrics expires, found lyrics stay", () => {
  const cache = createLyricsCache(store());
  cache.set("none", none(1000));
  cache.set("yes", found(1000));
  assert.ok(cache.get("none", 1000 + NONE_TTL - 1));
  assert.equal(cache.get("none", 1000 + NONE_TTL + 1), undefined);
  assert.ok(cache.get("yes", 1000 + NONE_TTL * 100));
});

test("broken or full storage", () => {
  const disk = store();
  disk.map.set(CACHE_PREFIX + "x", "{not json");
  disk.map.set(CACHE_PREFIX + "index", "42");
  const cache = createLyricsCache(disk);
  assert.equal(cache.get("x"), undefined);
  cache.set("y", found());
  assert.deepEqual(JSON.parse(disk.map.get(CACHE_PREFIX + "index")!), ["y"]);

  // Full: the older half makes room.
  const small = store(5);
  const c = createLyricsCache(small, 8);
  for (const k of ["a", "b", "c", "d", "e", "f"]) c.set(k, found());
  assert.ok(small.map.has(CACHE_PREFIX + "f"));
  assert.equal(small.map.has(CACHE_PREFIX + "a"), false);
  assert.deepEqual(c.get("a"), found()); // still in memory
});
