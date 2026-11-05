// App list for the launcher: AI detection, merging the two sources, search. Pure, so it can be tested without the app.

/** One launchable entry from Rust. `id` is what Rust opens: `shell:AppsFolder\<app id>` or an exe path. */
export interface LauncherApp {
  id: string;
  name: string;
  /** "start" = Start menu (AppsFolder, includes Store apps), "apppaths" = App Paths registry. */
  source: "start" | "apppaths";
}

/** A pinned app; the name is kept so the tile shows before the list has loaded. */
export interface Favorite {
  id: string;
  name: string;
}

/** Known AI apps, matched on the display name. `key` keeps one entry per app. */
const AI_APPS: { key: string; match: RegExp }[] = [
  { key: "claude", match: /^claude\b/i },
  { key: "chatgpt", match: /^chatgpt\b/i },
  { key: "copilot", match: /^(microsoft )?copilot$/i },
  { key: "cursor", match: /^cursor\b/i },
  { key: "codex", match: /^(openai )?codex\b/i },
  { key: "perplexity", match: /^perplexity\b/i },
  { key: "comet", match: /^comet$/i },
  { key: "gemini", match: /^(google )?gemini\b/i },
  { key: "antigravity", match: /^(google )?antigravity\b/i },
  { key: "windsurf", match: /^windsurf\b/i },
  { key: "grok", match: /^grok\b/i },
  { key: "deepseek", match: /^deepseek\b/i },
  { key: "lechat", match: /^(mistral )?le chat\b/i },
  { key: "poe", match: /^poe$/i },
  { key: "lmstudio", match: /^lm studio\b/i },
  { key: "ollama", match: /^ollama\b/i },
  { key: "jan", match: /^jan$/i },
  { key: "msty", match: /^msty\b/i },
];

/** Start menu clutter: uninstallers, readme and help links. */
const JUNK = /\b(uninstall|uninstaller|readme|release notes|help|documentation|website)\b/i;

/** The AI app this entry is, or null. */
export function aiKey(app: { name: string }): string | null {
  const name = app.name.trim();
  if (JUNK.test(name)) return null;
  return AI_APPS.find((a) => a.match.test(name))?.key ?? null;
}

const norm = (name: string) => name.trim().toLowerCase();

/**
 * Start entries (without clutter, sorted by name), plus App Paths entries that are AI apps
 * missing from the Start menu. Other App Paths entries are not offered: the Start menu is the list people know.
 */
export function mergeApps(apps: LauncherApp[]): LauncherApp[] {
  const start = apps.filter((a) => a.source === "start" && a.name.trim() && !JUNK.test(a.name));
  const seen = new Set(start.map((a) => norm(a.name)));
  const startAi = new Set(start.map(aiKey).filter(Boolean));
  const extra = apps.filter((a) => {
    if (a.source !== "apppaths") return false;
    const key = aiKey(a);
    if (!key || startAi.has(key) || seen.has(norm(a.name))) return false;
    startAi.add(key);
    return true;
  });
  const out: LauncherApp[] = [];
  const ids = new Set<string>();
  for (const a of [...start, ...extra]) if (!ids.has(a.id)) ids.add(a.id), out.push(a);
  return out.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** Detected AI apps, one per app (the first in the merged list wins). */
export function detectAi(apps: LauncherApp[]): LauncherApp[] {
  const keys = new Set<string>();
  return apps.filter((a) => {
    const k = aiKey(a);
    if (!k || keys.has(k)) return false;
    keys.add(k);
    return true;
  });
}

/** Matches on every word of the query; AI apps first, then by name start, then the rest. */
export function searchApps(apps: LauncherApp[], query: string, limit = 60): LauncherApp[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const hits = apps.filter((a) => words.every((w) => norm(a.name).includes(w)));
  const rank = (a: LauncherApp) => (aiKey(a) ? 0 : 2) + (words.length && !norm(a.name).startsWith(words[0]) ? 1 : 0);
  return hits
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .slice(0, limit)
    .map((x) => x.a);
}

/** Saved favourites repaired: entries without a string id and name dropped, duplicates removed; anything else = never seeded (null). */
export function normalizeFavorites(saved: unknown): Favorite[] | null {
  if (!Array.isArray(saved)) return null;
  const ids = new Set<string>();
  const out: Favorite[] = [];
  for (const f of saved) {
    if (typeof f?.id !== "string" || typeof f?.name !== "string" || !f.id || ids.has(f.id)) continue;
    ids.add(f.id);
    out.push({ id: f.id, name: f.name });
  }
  return out;
}

/** Moves the favourite at `index` by `delta` places (the keyboard way to reorder); out of range = unchanged. */
export function moveFavorite(favorites: Favorite[], index: number, delta: number): Favorite[] {
  const to = index + delta;
  if (index < 0 || index >= favorites.length || to < 0 || to >= favorites.length) return favorites;
  const next = [...favorites];
  const [f] = next.splice(index, 1);
  next.splice(to, 0, f);
  return next;
}

/** Pins or unpins; a new pin goes to the end. */
export function toggleFavorite(favorites: Favorite[], app: LauncherApp): Favorite[] {
  return favorites.some((f) => f.id === app.id) ? favorites.filter((f) => f.id !== app.id) : [...favorites, { id: app.id, name: app.name }];
}
