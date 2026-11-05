import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSED_DEFAULTS, PART_IDS } from "../../notch/row/parts.ts";
import { PRESETS, applyPreset, matchPreset, type PresetFields } from "./presets.ts";

// store.ts touches localStorage on import, so its tool ids are read from the source.
const storeSrc = readFileSync(join(import.meta.dirname, "../../settings/store.ts"), "utf8");
const TOOL_IDS = [...storeSrc.match(/TOOL_IDS = \[([\s\S]*?)\]/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
const DEFAULT_OFF = ["system", "discord", "trading", "vault", "water", "scratchpad", "terminal", "github", "notices", "recorder", "camera"];

const fresh = (): PresetFields => ({
  tools: TOOL_IDS.map((id) => ({ id, enabled: !DEFAULT_OFF.includes(id) })),
  closed: CLOSED_DEFAULTS,
  music: { lyricsOpen: false, titleLyrics: false, notchLyrics: false, pinned: null },
});
const enabled = (s: PresetFields) => s.tools.filter((t) => t.enabled).map((t) => t.id);
const partsOn = (s: PresetFields) => PART_IDS.filter((k) => s.closed.parts[k]);

test("presets name only known tools and parts", () => {
  assert.ok(TOOL_IDS.length > 10);
  for (const p of Object.values(PRESETS)) {
    for (const id of p.tools) assert.ok(TOOL_IDS.includes(id), id);
    for (const id of p.parts) assert.ok(PART_IDS.includes(id), id);
    assert.ok(p.tools.length > 0);
  }
});

test("each preset switches exactly its tools and parts", () => {
  const base = fresh();
  const music = applyPreset(base, "music", base);
  assert.deepEqual(enabled(music), ["overview", "media", "timer"]);
  assert.deepEqual(partsOn(music), ["timer", "title", "equalizer", "downloads"]);
  assert.equal(music.music.titleLyrics, true);
  const prod = applyPreset(base, "productivity", base);
  assert.deepEqual(enabled(prod), ["overview", "timer", "todos", "notes", "clipboard", "shelf", "convert", "weather"]);
  assert.deepEqual(partsOn(prod), ["timer", "equalizer", "downloads"]);
  assert.equal(prod.music.titleLyrics, false);
  const ai = applyPreset(base, "ai", base);
  assert.deepEqual(enabled(ai), ["overview", "ask", "usage", "terminal"]);
  assert.deepEqual(partsOn(ai), ["rings", "equalizer", "downloads"]);
});

test("order and other options survive, custom undoes a preset", () => {
  const base = fresh();
  const reordered = { ...base, tools: [...base.tools].reverse(), closed: { ...base.closed, clockSeconds: true }, music: { ...base.music, pinned: "spotify" } };
  const music = applyPreset(reordered, "music", base);
  assert.deepEqual(music.tools.map((t) => t.id), reordered.tools.map((t) => t.id));
  assert.equal(music.closed.clockSeconds, true);
  assert.deepEqual(music.closed.order, base.closed.order);
  assert.equal(music.music.pinned, "spotify");
  const back = applyPreset(applyPreset(music, "ai", base), "custom", base);
  assert.deepEqual(enabled(back).sort(), enabled(base).sort());
  assert.deepEqual(back.closed.parts, base.closed.parts);
  assert.equal(back.music.titleLyrics, false);
});

test("matchPreset finds the applied preset, defaults are custom", () => {
  const base = fresh();
  assert.equal(matchPreset(base), "custom");
  for (const id of ["music", "productivity", "ai"] as const) assert.equal(matchPreset(applyPreset(base, id, base)), id);
  const music = applyPreset(base, "music", base);
  assert.equal(matchPreset({ ...music, music: { ...music.music, titleLyrics: false } }), "custom");
  assert.equal(matchPreset({ ...music, tools: music.tools.map((t) => (t.id === "notes" ? { ...t, enabled: true } : t)) }), "custom");
});
