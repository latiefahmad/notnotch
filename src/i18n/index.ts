import { en } from "./en";
import { createStore, type Store } from "../lib/store";
import { backendText, localeFor, resolveLanguage, translate, type Dict, type Language, type LanguageSetting } from "./core";

export { LANGUAGES, LANGUAGE_NAMES, type Language, type LanguageSetting } from "./core";

/*
 * Translation: the German text lives directly in the code as an internal id; `en.json`
 * holds the English text and `<code>.json` the other languages (German needs entries only
 * where the id is not the text to show). A missing entry falls back to English, then to the id.
 * Placeholders: t("vor {n} Min.", { n: 5 }).
 */

// Every language but English is a chunk of its own, loaded when chosen.
const loaders = import.meta.glob<Dict>(["./*.json", "!./en.json"], { import: "default" });

let dict: Dict = en;
let fallback: Dict | null = null;

/** The language in use. The roots re-render on a change (`language.use()`), so t() runs again everywhere. */
export const language = createStore<Language>("en");

export function lang(): Language {
  return language.get();
}

export function t(de: string, vars?: Record<string, string | number>): string {
  return translate(de, vars, dict, fallback);
}

let reverse: { from: Dict; ids: Map<string, string> } | null = null;

/** The English text of something t() showed in the current language, or "" when it is no entry (texts with placeholders). */
export function english(shown: string): string {
  if (language.get() === "en") return shown;
  if (reverse?.from !== dict) reverse = { from: dict, ids: new Map(Object.entries(dict).map(([id, s]) => [s, id])) };
  return en[reverse.ids.get(shown) ?? shown] ?? "";
}

/** Locale for Intl (numbers, dates, weekdays). */
export function locale(): string {
  return localeFor(language.get(), navigator.language);
}

/** Error texts from Rust arrive in German; translated like any other id. */
export function tBackend(msg: string): string {
  return backendText(msg, t);
}

let ticket = 0;

/** Loads the language the setting asks for, then switches `lang`, `dir` and every t() over to it. */
export async function applyLanguage(setting: LanguageSetting): Promise<void> {
  const next = resolveLanguage(setting);
  const mine = ++ticket;
  let loaded: Dict = en;
  if (next !== "en") {
    try {
      loaded = (await loaders[`./${next}.json`]?.()) ?? {};
    } catch {
      loaded = {}; // A chunk that fails to load leaves the English fallback.
    }
  }
  if (mine !== ticket) return; // A later choice won meanwhile.
  dict = loaded;
  fallback = next === "en" ? null : en;
  document.documentElement.lang = next;
  document.documentElement.dir = "ltr";
  language.set(next);
}

/** Follows the saved setting: now (resolves once the dictionary is in) and on every change of it. */
export function startLanguage(settings: Pick<Store<{ lang: LanguageSetting }>, "get" | "subscribe">): Promise<void> {
  let last = settings.get().lang;
  settings.subscribe(() => {
    if (settings.get().lang === last) return;
    last = settings.get().lang;
    void applyLanguage(last);
  });
  return applyLanguage(last);
}
