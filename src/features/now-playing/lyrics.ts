import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { livePosition, media, type NowPlaying } from "../../platform/media";
import { isNative } from "../../platform/native";
import { settings } from "../../settings/store";
import { streamChat } from "../ask/providers";
import { LEAD, cacheKey, foundOf, lineAt, lookupAllowed, lyricsOf, pickRecord, searchTerms, untilNext, withExtra, type Found, type LrclibRecord, type LyricLine, type Lyrics } from "./lrc";
import { createLyricsCache, type CacheEntry } from "./lyricsCache";
import { enabledSources, firstFound, type LyricSourceId } from "./lyricSources";
import { parseTranslation, translationLrc, translationPrompt } from "./translate";

/*
 * Synced lyrics from the sources the user turned on, in their order (lyricSources.ts): LRCLIB (lrclib.net, free, no key)
 * from the webview, Kugou and NetEase from Rust (src-tauri/src/lyrics.rs). Only title, artist and length are sent, and only
 * while a lyrics surface is on (the panel in Now Playing or a lyric mode of the closed notch) and only for sessions with a
 * known length up to 20 minutes. Answers are cached in memory and on disk.
 */

const API = "https://lrclib.net/api";
/** LRCLIB asks clients to name themselves; browsers may not set User-Agent. */
const CLIENT = "NotNotch (https://github.com/latiefahmad/notnotch)";

const cache = createLyricsCache(
  (() => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  })(),
);
const pending = new Map<string, Promise<Lyrics | null>>();
/** After a 429, nothing is asked until then. */
let blockedUntil = 0;
/** Cleared if a request only goes through without the custom header (a refused CORS preflight). */
let identify = true;

class Unavailable extends Error {}

async function ask(path: "get" | "search", params: Record<string, string>): Promise<unknown> {
  if (Date.now() < blockedUntil) throw new Unavailable();
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const send = (named: boolean) => fetch(url, { headers: named ? { "Lrclib-Client": CLIENT } : {}, signal: AbortSignal.timeout(8000) });
  let r: Response;
  try {
    r = await send(identify);
  } catch (e) {
    // fetch reports a refused preflight as a TypeError, like being offline; one try without the header tells them apart.
    if (!(e instanceof TypeError) || !identify) throw e;
    r = await send(false);
    identify = false;
  }
  if (r.status === 404) return null;
  if (r.status === 429) {
    // Retry-After is not CORS-safelisted, so the page usually can't read it and the 60 s default applies.
    const wait = Number(r.headers.get("Retry-After"));
    blockedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60) * 1000;
    throw new Unavailable();
  }
  if (!r.ok) throw new Unavailable();
  return r.json();
}

/** LRCLIB: the exact match first (it allows 2 s of difference), then a search. */
async function fromLrclib(title: string, artist: string, duration: number): Promise<Found> {
  // The exact match needs an artist; without one only the search can help.
  if (!artist) return foundOf(pickRecord(await ask("search", { track_name: title }), duration));
  const base: Record<string, string> = { track_name: title, artist_name: artist };
  const exact = (await ask("get", { ...base, duration: String(Math.round(duration)) })) as LrclibRecord | null;
  return foundOf(exact?.instrumental || exact?.syncedLyrics ? exact : pickRecord(await ask("search", base), duration));
}

function fromSource(id: LyricSourceId, title: string, artist: string, duration: number): Promise<Found | null> {
  const q = searchTerms(title, artist);
  if (id === "lrclib") return fromLrclib(q.title, q.artist, duration);
  // The other sources are asked from Rust; the browser preview has none.
  return isNative ? invoke<Found | null>("lyrics_fetch", { source: id, title: q.title, artist: q.artist, duration }) : Promise.resolve(null);
}

/** Cache key of a song for these sources; LRCLIB alone keeps the key of the versions before more sources. */
const songKey = (np: NowPlaying, order: LyricSourceId[]) => {
  const key = cacheKey(np.title, np.artist, np.duration);
  return order.join(",") === "lrclib" ? key : `${key}\n${order.join(",")}`;
};

const fromEntry = (e: CacheEntry): Lyrics => lyricsOf(e);

/** Lyrics of a song; null when a source could not be reached and none had it (not cached, asked again next time). */
function lyricsFor(key: string, np: NowPlaying, order: LyricSourceId[]): Promise<Lyrics | null> {
  const known = cache.get(key);
  if (known) return Promise.resolve(fromEntry(known));
  let p = pending.get(key);
  if (!p) {
    p = firstFound(order, (id) => fromSource(id, np.title, np.artist, np.duration))
      .then((r) => {
        if (!r) return null;
        const e: CacheEntry = { ...r.found, at: Date.now() };
        cache.set(key, e);
        return fromEntry(e);
      })
      .catch(() => null)
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

export type LyricsState = Lyrics | { kind: "loading" } | { kind: "offline" } | { kind: "skipped" } | { kind: "nosource" };

/** An unreachable source is asked once more, when the network is back or after this. */
const OFFLINE_RETRY_MS = 60_000;

/** Lyrics surfaces on screen; while there is one, Rust refreshes the position every few seconds. */
let shown = 0;

/** Lyrics of the shown song while `enabled`; nothing is fetched otherwise. */
export function useLyrics(np: NowPlaying | null, enabled: boolean): LyricsState | null {
  const order = enabledSources(settings.use().music.lyricSources);
  // Browser players report no artist for some videos; the title alone still finds many songs.
  const wanted = !!np && enabled && np.title.trim() !== "";
  // Streams, podcasts and other long or open-ended sessions are not looked up, so their titles stay on the PC.
  const allowed = wanted && lookupAllowed(np.duration) && order.length > 0;
  const key = allowed ? songKey(np, order) : null;
  const [state, setState] = useState<{ key: string; value: LyricsState } | null>(null);
  useEffect(() => {
    if (!key || !np) return;
    let alive = true, retried = false, timer = 0;
    const again = () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", again);
      if (alive) load();
    };
    const load = () =>
      void lyricsFor(key, np, order).then((l) => {
        if (!alive) return;
        setState({ key, value: l ?? { kind: "offline" } });
        if (l || retried) return;
        retried = true;
        window.addEventListener("online", again);
        timer = window.setTimeout(again, OFFLINE_RETRY_MS);
      });
    setState({ key, value: { kind: "loading" } });
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener("online", again);
    };
  }, [key]);
  useEffect(() => {
    if (!key) return;
    if (++shown === 1) media.lyricsShown(true);
    return () => {
      if (--shown === 0) media.lyricsShown(false);
    };
  }, [!!key]);
  if (wanted && !order.length) return { kind: "nosource" };
  if (wanted && !allowed) return { kind: "skipped" };
  return key && state?.key === key ? state.value : key ? { kind: "loading" } : null;
}

/** The synced lines, if the state has them. */
export const linesOf = (l: LyricsState | null): LyricLine[] | null => (l?.kind === "synced" ? l.lines : null);

/**
 * Index of the line (or word, given a line's words) being sung, -1 before the first. Wakes once per line with a timeout,
 * never polls; paused it stays.
 */
export function useLyricIndex(lines: { time: number }[] | null | undefined, np: NowPlaying | null): number {
  const [index, setIndex] = useState(-1);
  useEffect(() => {
    if (!lines?.length || !np) return setIndex(-1);
    let id = 0;
    const step = () => {
      const t = livePosition(np) + LEAD;
      const i = lineAt(lines, t);
      setIndex(i);
      const wait = untilNext(lines, i, t);
      if (np.isPlaying && wait !== Infinity) id = window.setTimeout(step, wait * 1000 + 20);
    };
    step();
    return () => window.clearTimeout(id);
  }, [lines, np]);
  return index;
}

/** Text of the current line; null before the first line, in a gap, or without lyrics. */
export function useLyricLine(np: NowPlaying | null, enabled: boolean): string | null {
  const lines = linesOf(useLyrics(np, enabled));
  const i = useLyricIndex(lines, np);
  return (lines && i >= 0 && lines[i].text) || null;
}

const CJK = /[ぁ-ゖァ-ヺ㐀-䶿一-鿿가-힣]/;

/** The lines with romanisation (from the source, else made in Rust for Japanese, Chinese and Korean) while `on`. */
export function useRomanized(lines: LyricLine[] | null, on: boolean): LyricLine[] | null {
  const [made, setMade] = useState<{ from: LyricLine[]; lines: LyricLine[] } | null>(null);
  useEffect(() => {
    if (!on || !lines || !isNative || !lines.some((l) => !l.roman && CJK.test(l.text))) return;
    let alive = true;
    void invoke<string[]>("lyrics_romanize", { lines: lines.map((l) => l.text) })
      .then((r) => alive && setMade({ from: lines, lines: lines.map((l, i) => (l.roman || !r[i] || r[i] === l.text ? l : { ...l, roman: r[i] })) }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lines, on]);
  return made?.from === lines ? made.lines : lines;
}

/** Longest lyrics sent for a translation; longer texts are left alone to keep the request small. */
const MAX_TRANSLATE_CHARS = 6000;

/** The user's language, in English, for the prompt. */
function targetLanguage(): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(navigator.language) ?? "English";
  } catch {
    return "English";
  }
}

/**
 * The lines with a translation from the Ask provider while `on`, for songs whose source has none. One request per song
 * and language; the answer is kept in the lyrics cache.
 */
export function useAskTranslation(np: NowPlaying | null, lines: LyricLine[] | null, on: boolean): LyricLine[] | null {
  const ask = settings.use().ask;
  const [made, setMade] = useState<{ from: LyricLine[]; lines: LyricLine[] } | null>(null);
  useEffect(() => {
    if (!on || !np || !lines || lines.some((l) => l.translation)) return;
    const texts = lines.map((l) => l.text);
    if (!texts.some(Boolean) || texts.join("\n").length > MAX_TRANSLATE_CHARS) return;
    const language = targetLanguage();
    const key = `ask:${language}\n${cacheKey(np.title, np.artist, np.duration)}`;
    const known = cache.get(key);
    if (known) return setMade({ from: lines, lines: withExtra(lines, known.translation, "translation") });
    const abort = new AbortController();
    let reply = "";
    streamChat(ask.provider, ask.configs[ask.provider], [{ role: "user", content: translationPrompt(texts, language) }], (d) => (reply += d), abort.signal)
      .then(() => {
        if (abort.signal.aborted) return;
        const translation = translationLrc(lines, parseTranslation(reply, texts.length));
        if (!translation) return;
        cache.set(key, { lrc: null, instrumental: false, translation, at: Date.now() });
        setMade({ from: lines, lines: withExtra(lines, translation, "translation") });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [lines, on, ask.provider]);
  return made?.from === lines ? made.lines : lines;
}
