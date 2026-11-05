/*
 * The pure part of the translation (no dictionaries, no DOM), so tests can run it:
 * the languages, which one the setting asks for, the Intl locale, the lookup with its
 * fallbacks and the patterns for Rust's German error texts.
 */

/** The interface languages, in the order the setting lists them. */
export const LANGUAGES = ["en", "id"] as const;
export type Language = (typeof LANGUAGES)[number];
export type LanguageSetting = "system" | Language;
export type Dict = Record<string, string>;

/** Each language in its own name, as the setting shows it. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  id: "Bahasa Indonesia",
};

/** The Intl locale when the system's own locale is not the language's region. */
const LOCALES: Record<Language, string> = {
  en: "en-GB",
  id: "id-ID",
};

export const isLanguage = (v: unknown): v is Language => (LANGUAGES as readonly unknown[]).includes(v);

/** The interface language for a BCP 47 tag ("id-ID" → id), or null. */
export function languageOf(tag: string): Language | null {
  let loc: Intl.Locale;
  try {
    loc = new Intl.Locale(tag).maximize();
  } catch {
    return null;
  }
  return isLanguage(loc.language) ? loc.language : null;
}

/** The setting as a language: one of its own; "system" (the old default) and anything unknown are English. */
export function resolveLanguage(setting: unknown): Language {
  return isLanguage(setting) ? setting : "en";
}

/** The Intl locale: the system's own when it is the same language (en-US keeps its formats), otherwise the language's default. */
export function localeFor(lang: Language, systemTag: string | undefined): string {
  return systemTag && languageOf(systemTag) === lang ? systemTag : LOCALES[lang];
}

/** One entry: the language's text, else the fallback's (English), else the German id. Empty entries count as missing. */
export function translate(id: string, vars: Record<string, string | number> | undefined, dict: Dict, fallback: Dict | null): string {
  const s = dict[id] || fallback?.[id] || id;
  // One pass, so a value that contains "{x}" is never replaced again.
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/**
 * Rust's error texts (AI chat, files, sign-ins) arrive in German. Fixed ones are dictionary ids
 * themselves; these carry a detail and map to an id with named placeholders.
 */
const backendPatterns: [RegExp, string][] = [
  [/^Unbekannter Anbieter: (.*)$/s, "Unbekannter Anbieter: {name}"],
  [/^Schlüssel abgelehnt \((\d+)\): (.*)$/s, "Schlüssel abgelehnt ({code}): {text}"],
  [/^Nicht gefunden \(404\): Base-URL oder Modell prüfen\. (.*)$/s, "Nicht gefunden (404): Base-URL oder Modell prüfen. {text}"],
  [/^Fehler (\d+): (.*)$/s, "Fehler {code}: {text}"],
  [/^Keine Verbindung: (.*)$/s, "Keine Verbindung: {text}"],
];

export function backendText(msg: string, t: (id: string, vars?: Record<string, string>) => string): string {
  for (const [re, id] of backendPatterns) {
    const m = re.exec(msg);
    if (!m) continue;
    const names = [...id.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    return t(id, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
  }
  return t(msg);
}