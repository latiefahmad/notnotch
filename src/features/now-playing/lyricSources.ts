// Lyrics sources, the pure part: which ones exist, the order the user set, and the fallback through them.
import { lyricsOf, type Found } from "./lrc.ts";

export type LyricSourceId = "lrclib" | "kugou" | "netease";

export interface LyricSource {
  id: LyricSourceId;
  name: string;
  host: string;
  /** False for an unofficial API: it can change or stop without notice. */
  official: boolean;
}

/** In the default order. LRCLIB is open and documented; the other two are unofficial APIs without an account, off by default. */
export const LYRIC_SOURCES: LyricSource[] = [
  { id: "lrclib", name: "LRCLIB", host: "lrclib.net", official: true },
  { id: "kugou", name: "Kugou", host: "lyrics.kugou.com", official: false },
  { id: "netease", name: "NetEase Cloud Music", host: "music.163.com", official: false },
];

export interface LyricSourceSetting {
  id: LyricSourceId;
  on: boolean;
}

export const LYRIC_SOURCE_DEFAULTS: LyricSourceSetting[] = LYRIC_SOURCES.map((s) => ({ id: s.id, on: s.id === "lrclib" }));

/** A saved list made whole: unknown and repeated ids out, missing sources added at the end with their default. */
export function normalizeSources(saved: unknown): LyricSourceSetting[] {
  const out: LyricSourceSetting[] = [];
  for (const s of Array.isArray(saved) ? saved : []) {
    const d = LYRIC_SOURCE_DEFAULTS.find((x) => x.id === s?.id);
    if (d && !out.some((x) => x.id === d.id)) out.push({ id: d.id, on: typeof s.on === "boolean" ? s.on : d.on });
  }
  for (const d of LYRIC_SOURCE_DEFAULTS) if (!out.some((x) => x.id === d.id)) out.push({ ...d });
  return out;
}

/** The sources to ask, in order. */
export const enabledSources = (list: LyricSourceSetting[]): LyricSourceId[] => list.filter((s) => s.on).map((s) => s.id);

/**
 * Asks the sources in order until one has synced lyrics or knows the song is instrumental. A source that fails is skipped;
 * when one failed and none had the song, the answer is null, so the song is asked again later instead of being remembered
 * as having no lyrics.
 */
export async function firstFound(
  order: LyricSourceId[],
  ask: (id: LyricSourceId) => Promise<Found | null>,
): Promise<{ found: Found; source: LyricSourceId | null } | null> {
  let failed = false;
  for (const id of order) {
    try {
      const found = await ask(id);
      if (found && lyricsOf(found).kind !== "none") return { found, source: id };
    } catch {
      failed = true;
    }
  }
  return failed ? null : { found: { lrc: null, instrumental: false }, source: null };
}
