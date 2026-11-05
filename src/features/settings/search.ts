/*
 * Settings search: matching and ranking over the rows read from the rendered pages
 * (SettingsView). Each text comes in the interface language and in English, so
 * "theme" also finds "Themen" in German.
 */

export type SearchText = { label: string; hint: string; group: string };
export type SearchEntry = SearchText & { en: SearchText };

/** Lower case without accents (only Latin, Greek and Cyrillic combining marks: Devanagari vowel signs stay), ß as ss. */
export const fold = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

/** Entries where every word of the query is in the label, hint or group; more words in the label rank higher, ties keep their order. */
export function searchSettings<T extends SearchEntry>(entries: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries
    .map((e) => {
      const label = fold(`${e.label} ${e.en.label}`);
      const all = `${label} ${fold(`${e.hint} ${e.group} ${e.en.hint} ${e.en.group}`)}`;
      const ok = words.every((w) => all.includes(w));
      return { e, ok, score: words.filter((w) => label.includes(w)).length };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score) // Array.prototype.sort is stable.
    .map((x) => x.e);
}
