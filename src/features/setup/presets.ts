// First-run presets: which tools and closed-row parts each one switches on. Pure, so it is tested without the app around it.
import { PART_IDS, type ClosedSettings, type PartId } from "../../notch/row/parts.ts";
import type { Settings } from "../../settings/store";

export type PresetId = "music" | "productivity" | "ai" | "custom";
export type PresetFields = Pick<Settings, "tools" | "closed" | "music">;

/** Overview stays on in each: it is the start page. Every other tool and part not listed goes off. */
export const PRESETS: Record<Exclude<PresetId, "custom">, { tools: string[]; parts: PartId[] }> = {
  music: { tools: ["overview", "media", "timer"], parts: ["title", "equalizer", "timer", "downloads"] },
  productivity: { tools: ["overview", "timer", "todos", "notes", "clipboard", "shelf", "convert", "weather"], parts: ["timer", "equalizer", "downloads"] },
  ai: { tools: ["overview", "ask", "usage", "terminal"], parts: ["rings", "equalizer", "downloads"] },
};

/**
 * The fields `id` sets, on top of `cur`. Custom puts back `original` (what was there when the setup started:
 * the defaults on a fresh install), so picking a preset and then Custom undoes it. Order and other options stay.
 */
export function applyPreset(cur: PresetFields, id: PresetId, original: PresetFields): PresetFields {
  const p = id === "custom" ? null : PRESETS[id];
  return {
    tools: cur.tools.map((t) => ({ ...t, enabled: p ? p.tools.includes(t.id) : (original.tools.find((o) => o.id === t.id)?.enabled ?? t.enabled) })),
    closed: { ...cur.closed, parts: p ? (Object.fromEntries(PART_IDS.map((k) => [k, p.parts.includes(k)])) as ClosedSettings["parts"]) : original.closed.parts },
    // Music shows the lyric line in the title part.
    music: { ...cur.music, titleLyrics: id === "music" || original.music.titleLyrics },
  };
}

/** The preset the settings match exactly, else Custom (the card shown as picked when the setup opens again). */
export function matchPreset(s: PresetFields): PresetId {
  const on = (ids: string[], list: string[]) => ids.length === list.length && ids.every((id) => list.includes(id));
  const tools = s.tools.filter((t) => t.enabled).map((t) => t.id);
  const parts = PART_IDS.filter((k) => s.closed.parts[k]);
  for (const id of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
    const p = PRESETS[id];
    if (on(tools, p.tools) && on(parts, p.parts) && (id !== "music" || s.music.titleLyrics)) return id;
  }
  return "custom";
}
