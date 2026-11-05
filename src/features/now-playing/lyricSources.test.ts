import { test } from "node:test";
import assert from "node:assert/strict";
import { LYRIC_SOURCE_DEFAULTS, enabledSources, firstFound, normalizeSources, type LyricSourceId } from "./lyricSources.ts";
import type { Found } from "./lrc.ts";

test("saved source lists are made whole", () => {
  assert.deepEqual(enabledSources(LYRIC_SOURCE_DEFAULTS), ["lrclib"]);
  assert.deepEqual(normalizeSources(undefined), LYRIC_SOURCE_DEFAULTS);
  assert.deepEqual(normalizeSources([{ id: "netease", on: true }, { id: "gone", on: true }, { id: "netease", on: false }, { id: "lrclib" }, null]), [
    { id: "netease", on: true },
    { id: "lrclib", on: true },
    { id: "kugou", on: false },
  ]);
});

const synced: Found = { lrc: "[00:01.00]a", instrumental: false };

/** Sources answering from a table; records who was asked. */
function sources(answers: Partial<Record<LyricSourceId, Found | null | "fail">>) {
  const asked: LyricSourceId[] = [];
  const ask = async (id: LyricSourceId) => {
    asked.push(id);
    const a = answers[id];
    if (a === "fail") throw new Error("unavailable");
    return a ?? null;
  };
  return { asked, ask };
}

test("sources are asked in order until one has the song", async () => {
  let s = sources({ lrclib: null, kugou: synced, netease: synced });
  assert.deepEqual(await firstFound(["lrclib", "kugou", "netease"], s.ask), { found: synced, source: "kugou" });
  assert.deepEqual(s.asked, ["lrclib", "kugou"]);

  // The user's order counts; an empty LRC is no answer; instrumental is one.
  s = sources({ lrclib: synced, netease: { lrc: "[00:01.00]", instrumental: false }, kugou: { lrc: null, instrumental: true } });
  assert.deepEqual(await firstFound(["netease", "kugou", "lrclib"], s.ask), { found: { lrc: null, instrumental: true }, source: "kugou" });
  assert.deepEqual(s.asked, ["netease", "kugou"]);
});

test("a failing source is skipped, and a miss after a failure is not final", async () => {
  let s = sources({ lrclib: "fail", kugou: synced });
  assert.deepEqual(await firstFound(["lrclib", "kugou"], s.ask), { found: synced, source: "kugou" });
  s = sources({ lrclib: "fail", kugou: null });
  assert.equal(await firstFound(["lrclib", "kugou"], s.ask), null);
  s = sources({});
  assert.deepEqual(await firstFound(["lrclib", "kugou", "netease"], s.ask), { found: { lrc: null, instrumental: false }, source: null });
  assert.deepEqual(s.asked, ["lrclib", "kugou", "netease"]);
});
