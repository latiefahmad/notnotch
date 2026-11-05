// Synced lyrics, the pure part: LRC parsing (enhanced LRC with word stamps too), the line at a time, the LRCLIB query and
// which record to take.
// Parts of the query cleanup and the search fallback follow L4-Notchbar PR #13 by mhmmdazizy.

export interface LyricWord {
  /** Seconds from the start of the song. */
  time: number;
  /** With its trailing space, if any: the words joined are the line. */
  text: string;
}

export interface LyricLine {
  /** Seconds from the start of the song. */
  time: number;
  /** Empty for an instrumental gap. */
  text: string;
  /** Only when the source times each word (enhanced LRC). */
  words?: LyricWord[];
  /** From the source or the Ask provider, only when it differs from the text. */
  translation?: string;
  /** Latin letters for Japanese, Chinese and Korean, from the source or made offline. */
  roman?: string;
}

export type Lyrics = { kind: "synced"; lines: LyricLine[] } | { kind: "instrumental" } | { kind: "none" };

/** Lines show this much before their stamp, so they appear as they are sung rather than after. */
export const LEAD = 0.25;

const STAMP = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
const OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
/** Word stamps of enhanced LRC (`<00:12.34>`), each before its word; one at the end may close the last word. */
const WORD_STAMP = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;

const seconds = (min: string, sec: string) => Number(min) * 60 + Number(sec.replace(":", "."));

/** Words of a line with word stamps, null without any. Text before the first stamp joins the first word. */
function wordsOf(rest: string): LyricWord[] | null {
  // Split keeps the two groups: [before, min, sec, word, min, sec, word, ...].
  const parts = rest.split(WORD_STAMP);
  const words: LyricWord[] = [];
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const text = parts[i + 2];
    if (text.trim()) words.push({ time: seconds(parts[i], parts[i + 1]), text });
    else if (text && words.length) words[words.length - 1].text += text;
  }
  if (words.length && parts[0].trim()) words[0].text = parts[0] + words[0].text;
  return words.length ? words : null;
}

/**
 * Lines of an LRC text, sorted by time. A line may carry several stamps (a repeated chorus); `[offset:ms]` moves every
 * line (positive = earlier, as in the format); tags like `[ar:…]` and lines without a stamp are skipped.
 */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    let rest = raw.trim();
    const off = OFFSET.exec(rest);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    const stamps: number[] = [];
    for (let m = STAMP.exec(rest); m; m = STAMP.exec(rest)) {
      stamps.push(seconds(m[1], m[2]));
      rest = rest.slice(m[0].length).trimStart();
    }
    const words = stamps.length ? wordsOf(rest) : null;
    const text = (words ? words.map((w) => w.text).join("") : rest.replace(WORD_STAMP, "")).replace(/\s+/g, " ").trim();
    // Word stamps are absolute: a repeated line moves its words along with its line stamp.
    for (const time of stamps) lines.push(words ? { time, text, words: words.map((w) => ({ time: w.time - stamps[0] + time, text: w.text })) } : { time, text });
  }
  const at = (t: number) => Math.max(0, t - offset);
  return lines
    .map((l) => (l.words ? { ...l, time: at(l.time), words: l.words.map((w) => ({ ...w, time: at(w.time) })) } : { ...l, time: at(l.time) }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Puts the lines of `extra` (a translation or romanisation as LRC, from the same source) on the lyric line with the same
 * stamp, within 0.1 s; lines equal to the lyric are left out.
 */
export function withExtra(lines: LyricLine[], extra: string | null | undefined, field: "translation" | "roman"): LyricLine[] {
  if (!extra) return lines;
  const byTime = new Map<number, string>();
  for (const l of parseLrc(extra)) if (l.text) byTime.set(Math.round(l.time * 10), l.text);
  if (!byTime.size) return lines;
  return lines.map((l) => {
    const k = Math.round(l.time * 10);
    const v = byTime.get(k) ?? byTime.get(k - 1) ?? byTime.get(k + 1);
    return v && l.text && v !== l.text ? { ...l, [field]: v } : l;
  });
}

/** Index of the line (or word) sung at `t` seconds: the last one that started; -1 before the first. */
export function lineAt(lines: { time: number }[], t: number): number {
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Seconds from `t` until the line after `index` starts; Infinity after the last one. */
export function untilNext(lines: { time: number }[], index: number, t: number): number {
  const next = lines[index + 1];
  return next ? Math.max(0, next.time - t) : Infinity;
}

const NOISE = /\s*[([](?:official|lyrics?|audio|video|music|visuali[sz]er|hd|hq|4k|mv|m\/v)\b[^)\]]*[)\]]/gi;
const NOT_AN_ARTIST = /^(?:google chrome|chrome|microsoft edge|edge|brave|firefox|opera|vivaldi|youtube)$/i;

/**
 * Title and artist for the query. Browser players often report a video title ("Artist - Song (Official Video)") with
 * the channel or no artist: the extras go, and the title is split when the artist is missing or not a person.
 */
export function searchTerms(title: string, artist: string): { title: string; artist: string } {
  let t = title.replace(NOISE, "").trim() || title.trim();
  let a = artist.trim();
  const channel = /\s+-\s+topic$/i.test(a) || /vevo$/i.test(a);
  a = a.replace(/\s+-\s+topic$/i, "").replace(/vevo$/i, "").trim();
  const dash = t.indexOf(" - ");
  if (dash > 0 && (!a || NOT_AN_ARTIST.test(a) || channel)) {
    a = t.slice(0, dash).trim();
    t = t.slice(dash + 3).trim();
  }
  return { title: t, artist: a };
}

/** Longest session that is looked up; longer ones are mixes, podcasts or streams. */
export const MAX_LOOKUP_SECONDS = 20 * 60;

/** Only songs with a known length up to MAX_LOOKUP_SECONDS are sent to LRCLIB. */
export const lookupAllowed = (duration: number) => duration > 0 && duration <= MAX_LOOKUP_SECONDS;

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Cache key of a song: the cleaned query and the length in whole seconds (0 = unknown). */
export function cacheKey(title: string, artist: string, duration: number): string {
  const q = searchTerms(title, artist);
  return `${norm(q.artist)}\n${norm(q.title)}\n${duration > 0 ? Math.round(duration) : 0}`;
}

export interface LrclibRecord {
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
}

/** A search result may be another recording; beyond this its lines would drift. */
export const MAX_DRIFT = 5;

/** Best search result: synced, and with a known length the closest one within MAX_DRIFT. */
export function pickRecord(records: unknown, duration: number): LrclibRecord | null {
  if (!Array.isArray(records)) return null;
  const synced = records.filter((r): r is LrclibRecord => !!r && typeof r === "object" && typeof r.syncedLyrics === "string" && r.syncedLyrics.trim() !== "");
  if (duration <= 0) return synced[0] ?? null;
  let best: LrclibRecord | null = null, gap = Infinity;
  for (const r of synced) {
    const d = typeof r.duration === "number" ? Math.abs(r.duration - duration) : Infinity;
    if (d <= MAX_DRIFT && d < gap) {
      best = r;
      gap = d;
    }
  }
  return best;
}

/** What a source found: synced lyrics as LRC, or instrumental; translation and romanisation as LRC with the same stamps. */
export interface Found {
  lrc: string | null;
  instrumental: boolean;
  translation?: string | null;
  roman?: string | null;
}

export const foundOf = (record: LrclibRecord | null): Found => ({ lrc: record?.syncedLyrics ?? null, instrumental: !!record?.instrumental });

/** What a source's answer means for the notch. */
export function lyricsOf(found: Found | null): Lyrics {
  if (found?.instrumental) return { kind: "instrumental" };
  const lines = typeof found?.lrc === "string" ? parseLrc(found.lrc) : [];
  if (!lines.some((l) => l.text)) return { kind: "none" };
  return { kind: "synced", lines: withExtra(withExtra(lines, found!.translation, "translation"), found!.roman, "roman") };
}
