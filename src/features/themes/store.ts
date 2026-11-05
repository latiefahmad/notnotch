import { useMemo } from "react";
import { createStore } from "../../lib/store";
import { themeFiles } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { activeThemeId, chooseTheme, nextChange } from "./daynight";
import { record, startHistory, undo, type History } from "./history";
import { setRowFamily } from "../../notch/row/measure";
import {
  BUILT_IN_THEMES,
  FONTS,
  THEME_DEFAULTS,
  findTheme,
  importThemes,
  isBuiltIn,
  readableAccent,
  resolveTheme,
  setThemeColor,
  themeToText,
  uniqueId,
  type ImportResult,
  type ResolvedTheme,
  type ThemeFile,
  type ThemeKey,
} from "./themes";
import type { Rgba } from "./color";
import "./themes.css";

/** The editor's unsaved changes, drawn live on the whole panel; kept until saved or discarded, lost on exit. */
export const draft = createStore<History<ThemeFile> | null>(null);

const DARK = resolveTheme(BUILT_IN_THEMES[0]);
/** The theme on screen now (the draft while editing). */
export const activeTheme = createStore<ResolvedTheme>(DARK);

/** The saved theme due now (day/night included). */
export function savedTheme(now = new Date()): ThemeFile {
  const themes = settings.get().themes;
  return findTheme(activeThemeId(themes, now), themes.custom);
}

let lastKey = "";
function apply() {
  const file = draft.get()?.present ?? savedTheme();
  const key = JSON.stringify(file);
  if (key === lastKey) return;
  lastKey = key;
  const resolved = resolveTheme(file);
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(resolved.vars)) root.setProperty(name, value);
  document.documentElement.dataset.theme = resolved.dark ? "dark" : "light";
  activeTheme.set(resolved);
}

let timer = 0;
let lastSchedule = "";
/** One timeout to the next day/night change, no polling. */
function scheduleNext() {
  const s = settings.get().themes.schedule;
  const key = JSON.stringify(s);
  if (key === lastSchedule) return;
  lastSchedule = key;
  window.clearTimeout(timer);
  if (!s.on) return;
  const wait = nextChange(s, new Date()).getTime() - Date.now();
  timer = window.setTimeout(refreshTheme, wait + 500);
}

/**
 * Checks the theme due now and sets the next timeout again. Runs on the timeout and whenever the
 * notch opens, which covers a PC that slept through the change and a daylight saving shift.
 */
export function refreshTheme() {
  lastSchedule = "";
  apply();
  scheduleNext();
}

let lastFont = "";
function applyFont() {
  const family = FONTS[settings.get().themes.font];
  if (family === lastFont) return;
  lastFont = family;
  document.documentElement.style.setProperty("--font-sans", family);
  setRowFamily(family);
}

export function startThemes() {
  apply();
  applyFont();
  scheduleNext();
  settings.subscribe(() => {
    apply();
    applyFont();
    scheduleNext();
  });
  draft.subscribe(apply);
}

/** Windows high contrast is on (forced colours): the system's colours replace every theme. */
const forcedQuery = typeof matchMedia === "function" ? matchMedia("(forced-colors: active)") : null;
export const forcedColors = createStore(forcedQuery?.matches ?? false);
forcedQuery?.addEventListener("change", (e) => forcedColors.set(e.matches));

/** The cover colour for the open panel: held to 3:1 on the theme's background; the theme accent when nothing plays. */
export function useThemedAccent(raw: string | undefined): string {
  const theme = activeTheme.use();
  return useMemo(() => (raw ? readableAccent(raw, theme) : theme.vars["--theme-accent"]), [raw, theme]);
}

/**
 * Tokens for the closed row: the Dark theme's, so the black notch keeps light text whatever the
 * theme, with the raw cover colour (tuned for black). Nothing when the theme colours the closed notch too.
 */
export function useClosedInk(raw: string | undefined): Record<string, string> | undefined {
  const theme = activeTheme.use();
  return useMemo(() => (theme.closedNotch ? undefined : { ...DARK.vars, "--accent": raw ?? DARK.vars["--theme-accent"] }), [raw, theme.closedNotch]);
}

// ---------- Choosing ----------

export const allThemes = (): ThemeFile[] => [...BUILT_IN_THEMES, ...settings.get().themes.custom];

export function pickTheme(id: string) {
  updateSettings((s) => ({ themes: chooseTheme(s.themes, id, new Date()) }));
}

export function deleteCustomTheme(id: string) {
  updateSettings((s) => {
    const t = s.themes;
    const gone = (v: string, fallback: string) => (v === id ? fallback : v);
    return {
      themes: {
        ...t,
        custom: t.custom.filter((c) => c.id !== id),
        id: gone(t.id, THEME_DEFAULTS.id),
        schedule: { ...t.schedule, day: gone(t.schedule.day, THEME_DEFAULTS.schedule.day), night: gone(t.schedule.night, THEME_DEFAULTS.schedule.night) },
      },
    };
  });
}

// ---------- Editing ----------

/** The name field under the editor; kept here so it survives the settings page being rebuilt. */
export const draftName = createStore("");

export function startEditing(name: string) {
  draftName.set(name);
  draft.set(startHistory(savedTheme()));
}

const edit = (key: string, change: (t: ThemeFile) => ThemeFile) => {
  const h = draft.get();
  if (h) draft.set(record(h, change(h.present), performance.now(), key));
};

export const editColor = (key: ThemeKey, value: Rgba) => edit(key, (t) => setThemeColor(t, key, value));
export const editClosedNotch = (on: boolean) => edit("closedNotch", (t) => ({ ...t, closedNotch: on ? "background" : undefined }));

export function undoEdit() {
  const h = draft.get();
  if (h) draft.set(undo(h));
}

export const discardEdits = () => draft.set(null);

/** Saves the draft as a new custom theme and switches to it. */
export function saveAsNew(name: string) {
  const h = draft.get();
  if (!h) return;
  const taken = new Set(allThemes().map((t) => t.id));
  const id = uniqueId(name, taken);
  const { colors, closedNotch } = h.present;
  const theme: ThemeFile = { format: 1, id, name: name.trim().slice(0, 60) || id, colors, ...(closedNotch ? { closedNotch } : {}) };
  updateSettings((s) => ({ themes: chooseTheme({ ...s.themes, custom: [...s.themes.custom, theme] }, id, new Date()) }));
  draft.set(null);
}

/** Writes the draft over the custom theme it started from. */
export function overwriteTheme() {
  const h = draft.get();
  if (!h || isBuiltIn(h.present.id)) return;
  const theme = h.present;
  updateSettings((s) => ({ themes: { ...s.themes, custom: s.themes.custom.map((c) => (c.id === theme.id ? theme : c)) } }));
  draft.set(null);
}

// ---------- Files ----------

/**
 * Writes the theme on screen into the themes folder: the draft while editing, else the saved theme
 * due now. A changed built-in leaves under the editor's name, so its file never carries a built-in
 * id. Returns the file's path ("" in the browser).
 */
export function exportTheme(): Promise<string> {
  const h = draft.get();
  let theme = h?.present ?? savedTheme();
  if (h && h.past.length > 0 && isBuiltIn(theme.id)) {
    const name = draftName.get().trim().slice(0, 60) || theme.name;
    theme = { format: 1, id: uniqueId(name, new Set(BUILT_IN_THEMES.map((t) => t.id))), name, colors: theme.colors, ...(theme.closedNotch ? { closedNotch: theme.closedNotch } : {}) };
  }
  return themeFiles.write(theme.id, themeToText(theme));
}

/** Reads the themes folder and copies every valid file into the custom themes. */
export async function importFromFolder(): Promise<ImportResult> {
  const files = await themeFiles.read();
  const result = importThemes(settings.get().themes.custom, files);
  updateSettings((s) => ({ themes: { ...s.themes, custom: result.custom } }));
  return result;
}

export const themesFolder = () => themeFiles.folder();
