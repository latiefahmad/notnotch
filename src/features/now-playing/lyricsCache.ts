// Lyrics cache: in memory, and on disk through a localStorage-like store, least recently used out first.
// Pure apart from the store it is given, so the rules are tested with a Map.

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `lrc` = the synced text; null with `instrumental` false = no source has it. Translation and romanisation as LRC. */
export interface CacheEntry {
  lrc: string | null;
  instrumental: boolean;
  translation?: string | null;
  roman?: string | null;
  /** When it was fetched (ms). */
  at: number;
}

export const CACHE_PREFIX = "notnotch:lyrics:";
const INDEX = `${CACHE_PREFIX}index`;
/** About 2 to 5 KB per song, up to 15 with word stamps and a translation. */
export const CACHE_MAX = 200;
/** A song without lyrics is asked again after this; the sources keep growing. Found lyrics never expire. */
export const NONE_TTL = 3 * 24 * 3600 * 1000;

const isEntry = (v: unknown): v is CacheEntry =>
  !!v && typeof v === "object" && ((v as CacheEntry).lrc === null || typeof (v as CacheEntry).lrc === "string") &&
  typeof (v as CacheEntry).instrumental === "boolean" && typeof (v as CacheEntry).at === "number";

export function createLyricsCache(disk: KeyValue | null, max = CACHE_MAX) {
  const memory = new Map<string, CacheEntry>();
  const safe = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const readIndex = (): string[] => {
    const v = safe(() => JSON.parse(disk?.getItem(INDEX) ?? "[]") as unknown, []);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  };
  /** Moves `key` to the newest end and drops the oldest beyond `max`. */
  const touch = (key: string, keep = max) => {
    if (!disk) return;
    const index = readIndex().filter((k) => k !== key);
    index.push(key);
    for (const old of index.splice(0, Math.max(0, index.length - keep))) safe(() => disk.removeItem(CACHE_PREFIX + old), undefined);
    safe(() => disk.setItem(INDEX, JSON.stringify(index)), undefined);
  };
  const forget = (key: string) => {
    memory.delete(key);
    safe(() => disk?.removeItem(CACHE_PREFIX + key), undefined);
  };
  const fresh = (e: CacheEntry, now: number) => e.lrc !== null || e.instrumental || !!e.translation || now - e.at < NONE_TTL;

  return {
    get(key: string, now = Date.now()): CacheEntry | undefined {
      let entry = memory.get(key);
      if (!entry && disk) {
        const v = safe(() => JSON.parse(disk.getItem(CACHE_PREFIX + key) ?? "null") as unknown, null);
        if (isEntry(v)) {
          entry = v;
          memory.set(key, v);
          touch(key);
        }
      }
      if (entry && !fresh(entry, now)) {
        forget(key);
        return undefined;
      }
      return entry;
    },
    set(key: string, entry: CacheEntry) {
      // A long session plays many songs; the disk keeps them, the memory starts over.
      if (memory.size >= max) memory.clear();
      memory.set(key, entry);
      if (!disk) return;
      const json = JSON.stringify(entry);
      try {
        disk.setItem(CACHE_PREFIX + key, json);
      } catch {
        // Storage full: make room by dropping the older half, then try once more.
        touch(key, Math.floor(max / 2));
        if (!safe(() => (disk.setItem(CACHE_PREFIX + key, json), true), false)) return;
      }
      touch(key);
    },
  };
}
