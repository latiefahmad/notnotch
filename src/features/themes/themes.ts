// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/PanelThemes.cs, PanelThemes.Build.cs,
// PanelThemes.Derive.cs and Themes/*.json (the palettes of One Dark Pro, GitHub, Dracula and Night Owl, all MIT, see docs/themes.md).

import { BLACK, WHITE, contrast, ensureContrast, formatColor, isDark, mix, over, parseColor, toHex, withAlpha, type ContrastNeed, type Rgba } from "./color.ts";

/**
 * Panel themes. A theme names a few colours (THEME_KEYS); the rest of NotNotch's tokens follow from
 * them. Readability never depends on the theme: every colour with a minimum is held to it on the
 * backgrounds it is drawn on, and a colour that misses is moved along its own hue just far enough.
 */
export const THEME_KEYS = ["background", "foreground", "secondary", "tertiary", "accent", "link", "warning", "critical", "success", "elevated"] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];
/** The colours the settings editor offers. */
export const EDITOR_KEYS = ["background", "foreground", "accent", "warning", "critical"] as const satisfies readonly ThemeKey[];

export interface ThemeFile {
  format: 1;
  id: string;
  name: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  colors: Partial<Record<ThemeKey, string>>;
  /** "black" (default): the closed notch stays black and keeps the dark text. "background": it takes the theme. */
  closedNotch?: "black" | "background";
}

export interface ThemeSettings {
  /** The chosen theme (the day theme's place is `schedule.day` while the schedule is on). */
  id: string;
  custom: ThemeFile[];
  /** Day and night: two themes switched by the local clock. */
  schedule: { on: boolean; day: string; night: string; dayStart: string; nightStart: string };
  /** Tool bar, settings pages, weather and closed-row readings with icons in colours of their own (hues.ts). */
  iconColors: boolean;
  /** The open panel takes a soft glow of the cover colour while a song shows (themes.css, [data-ambience]). */
  coverTint: boolean;
  /** The whole app's font (FONTS), set as --font-sans; the terminal and the timer looks keep their monospace. */
  font: FontId;
}

/** Inter ships with NotNotch, the others with Windows itself (not Office); the second name is a Mac font of the same kind. Fonts whose digits differ in width
 *  take Inter's digits first ("NotNotch Digits", global.css). */
export const FONTS = {
  inter: '"Inter Variable", "Segoe UI Variable Text", system-ui, sans-serif',
  segoe: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  bahnschrift: 'Bahnschrift, "DIN Alternate", system-ui, sans-serif',
  franklin: '"Franklin Gothic Medium", "Avenir Next Condensed", "Arial Narrow", system-ui, sans-serif',
  impact: 'Impact, "Arial Black", system-ui, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  sitka: '"Sitka Text", "Iowan Old Style", Georgia, serif',
  palatino: '"Palatino Linotype", Palatino, Georgia, serif',
  cascadia: '"Cascadia Code", Consolas, "SF Mono", Menlo, ui-monospace, monospace',
  courier: '"Courier New", Courier, monospace',
  comic: '"Comic Sans MS", "Segoe UI", sans-serif',
  inkfree: '"NotNotch Digits", "Ink Free", "Marker Felt", cursive',
  print: '"Segoe Print", "Chalkboard SE", cursive',
  script: '"Segoe Script", "Snell Roundhand", cursive',
  mvboli: '"NotNotch Digits", "MV Boli", Noteworthy, cursive',
  gabriola: '"NotNotch Digits", Gabriola, "Apple Chancery", cursive',
} as const;
export type FontId = keyof typeof FONTS;
/** Names in the menu: font names, never translated. */
export const FONT_NAMES: Record<FontId, string> = {
  inter: "Inter", segoe: "Segoe UI", bahnschrift: "Bahnschrift", franklin: "Franklin Gothic", impact: "Impact", georgia: "Georgia",
  sitka: "Sitka", palatino: "Palatino", cascadia: "Cascadia", courier: "Courier New", comic: "Comic Sans MS", inkfree: "Ink Free",
  print: "Segoe Print", script: "Segoe Script", mvboli: "MV Boli", gabriola: "Gabriola",
};

export const TEXT = 4.5, STRONG_TEXT = 7, GRAPHIC = 3;
/** Tertiary text (hints, inactive icons): NotNotch's own dark tertiary, white at 34 %, is 2.9:1 on black. */
export const TERTIARY = 2.8;
export const MAX_FILE_BYTES = 64 * 1024;
export const DEFAULT_THEME = "dark";

/** Defaults of a dark and a light surface: what a file leaves out, and the alphas of the derived tokens. */
const MODES = {
  dark: {
    foreground: "rgb(255 255 255 / 0.96)",
    accent: "#0a84ff",
    warning: "#ff9f0a",
    critical: "#ff453a",
    success: "#30d158",
    yellow: "#ffd60a",
    alpha: { secondary: 0.58, tertiary: 0.34, label4: 0.18, fill1: 0.06, fill2: 0.1, fill3: 0.16, separator: 0.08 },
  },
  light: {
    foreground: "#1d1d1f",
    accent: "#0066cc",
    warning: "#9c6a00",
    critical: "#d1343b",
    success: "#248a3d",
    yellow: "#8a6d00",
    alpha: { secondary: 0.68, tertiary: 0.56, label4: 0.3, fill1: 0.04, fill2: 0.07, fill3: 0.12, separator: 0.1 },
  },
};

const builtIn = (id: string, name: string, colors: ThemeFile["colors"], extra: Partial<ThemeFile> = {}): ThemeFile => ({ format: 1, id, name, colors, ...extra });

/** Dark first (NotNotch's own look, equal to tokens.css), then Light, then the ported editor themes. */
export const BUILT_IN_THEMES: readonly ThemeFile[] = [
  builtIn("dark", "Dark", {
    background: "#000000",
    foreground: "rgb(255 255 255 / 0.96)",
    secondary: "rgb(255 255 255 / 0.58)",
    tertiary: "rgb(255 255 255 / 0.34)",
    accent: "#0a84ff",
    link: "#419cff",
    warning: "#ff9f0a",
    critical: "#ff453a",
    success: "#30d158",
    elevated: "#1c1c1e",
  }),
  builtIn("light", "Light", {
    background: "#fafafc",
    foreground: "#1d1d1f",
    accent: "#0066cc",
    warning: "#9c6a00",
    critical: "#d1343b",
    success: "#248a3d",
    elevated: "#ffffff",
  }),
  builtIn(
    "one-dark-pro",
    "One Dark Pro",
    { background: "#21252b", foreground: "#d7dae0", secondary: "#abb2bf", tertiary: "#8e939b", accent: "#61afef", warning: "#e5c07b", critical: "#e06c75", success: "#98c379", elevated: "#282c34" },
    { author: "Binaryify", license: "MIT", homepage: "https://github.com/Binaryify/OneDark-Pro" },
  ),
  builtIn(
    "github-dark",
    "GitHub Dark",
    { background: "#0d1117", foreground: "#e6edf3", secondary: "#9198a1", tertiary: "#7a838e", accent: "#4493f8", warning: "#d29922", critical: "#f85149", success: "#3fb950", elevated: "#161b22" },
    { author: "GitHub (Primer)", license: "MIT", homepage: "https://github.com/primer/github-vscode-theme" },
  ),
  builtIn(
    "github-light",
    "GitHub Light",
    { background: "#ffffff", foreground: "#1f2328", secondary: "#59636e", tertiary: "#6d7785", accent: "#0969da", warning: "#9a6700", critical: "#d1242f", success: "#1a7f37", elevated: "#ffffff" },
    { author: "GitHub (Primer)", license: "MIT", homepage: "https://github.com/primer/github-vscode-theme" },
  ),
  builtIn(
    "dracula",
    "Dracula",
    { background: "#21222c", foreground: "#f8f8f2", secondary: "#bdbfd0", tertiary: "#858fbb", accent: "#bd93f9", warning: "#f1fa8c", critical: "#ff5555", success: "#50fa7b", elevated: "#282a36" },
    { author: "Dracula Theme", license: "MIT", homepage: "https://github.com/dracula/visual-studio-code" },
  ),
  builtIn(
    "night-owl",
    "Night Owl",
    { background: "#011627", foreground: "#d6deeb", secondary: "#a1b3c8", tertiary: "#6e8da7", accent: "#82aaff", warning: "#ecc48d", critical: "#ef5350", success: "#addb67", elevated: "#0b253a" },
    { author: "Sarah Drasner", license: "MIT", homepage: "https://github.com/sdras/night-owl-vscode-theme" },
  ),
  builtIn(
    "catppuccin-mocha",
    "Catppuccin Mocha",
    { background: "#181825", foreground: "#cdd6f4", secondary: "#bac2de", tertiary: "#7f849c", accent: "#cba6f7", link: "#89b4fa", warning: "#f9e2af", critical: "#f38ba8", success: "#a6e3a1", elevated: "#1e1e2e" },
    { author: "Catppuccin", license: "MIT", homepage: "https://github.com/catppuccin/catppuccin" },
  ),
  builtIn(
    "catppuccin-latte",
    "Catppuccin Latte",
    { background: "#e6e9ef", foreground: "#484b64", secondary: "#5c5f77", tertiary: "#6c6f85", accent: "#8839ef", link: "#1e66f5", warning: "#935d13", critical: "#d00f39", success: "#3d9829", elevated: "#eff1f5" },
    { author: "Catppuccin", license: "MIT", homepage: "https://github.com/catppuccin/catppuccin" },
  ),
  builtIn(
    "nord",
    "Nord",
    { background: "#2e3440", foreground: "#eceff4", secondary: "#d8dee9", tertiary: "#7b88a1", accent: "#88c0d0", link: "#81a1c1", warning: "#ebcb8b", critical: "#cf888f", success: "#a3be8c", elevated: "#3b4252" },
    { author: "Sven Greb", license: "MIT", homepage: "https://github.com/nordtheme/nord" },
  ),
  builtIn(
    "rose-pine",
    "Rosé Pine",
    { background: "#191724", foreground: "#e0def4", secondary: "#9390ad", tertiary: "#6e6a86", accent: "#ebbcba", link: "#c4a7e7", warning: "#f6c177", critical: "#eb6f92", success: "#9ccfd8", elevated: "#1f1d2e" },
    { author: "Rosé Pine", license: "MIT", homepage: "https://github.com/rose-pine/rose-pine-theme" },
  ),
  builtIn(
    "rose-pine-dawn",
    "Rosé Pine Dawn",
    { background: "#faf4ed", foreground: "#534f74", secondary: "#6a6683", tertiary: "#918c9f", accent: "#d2726e", link: "#286983", warning: "#9f6310", critical: "#ad546e", success: "#56949f", elevated: "#fffaf3" },
    { author: "Rosé Pine", license: "MIT", homepage: "https://github.com/rose-pine/rose-pine-theme" },
  ),
  builtIn(
    "gruvbox-dark",
    "Gruvbox Dark",
    { background: "#282828", foreground: "#ebdbb2", secondary: "#d5c4a1", tertiary: "#a89984", accent: "#fe8019", link: "#83a598", warning: "#fabd2f", critical: "#fb533f", success: "#b8bb26", elevated: "#32302f" },
    { author: "Pavel Pertsev", license: "MIT", homepage: "https://github.com/gruvbox-community/gruvbox" },
  ),
  builtIn(
    "solarized-light",
    "Solarized Light",
    { background: "#fdf6e3", foreground: "#3f4e53", secondary: "#586c73", tertiary: "#7d8d8d", accent: "#268bd2", link: "#6c71c4", warning: "#8f6c00", critical: "#da2925", success: "#859800", elevated: "#eee8d5" },
    { author: "Ethan Schoonover", license: "MIT", homepage: "https://github.com/altercation/solarized" },
  ),
  builtIn(
    "everforest",
    "Everforest",
    { background: "#2d353b", foreground: "#dacfb7", secondary: "#a7b2a9", tertiary: "#859289", accent: "#a7c080", link: "#7fbbb3", warning: "#dbbc7f", critical: "#e67e80", success: "#83c092", elevated: "#343f44" },
    { author: "sainnhe", license: "MIT", homepage: "https://github.com/sainnhe/everforest" },
  ),
];

export const isBuiltIn = (id: string) => BUILT_IN_THEMES.some((t) => t.id === id);

/** The theme an id names, among the built-ins and the custom themes; a missing one (a deleted file) falls back to Dark. */
export function findTheme(id: string, custom: readonly ThemeFile[]): ThemeFile {
  return BUILT_IN_THEMES.find((t) => t.id === id) ?? custom.find((t) => t.id === id) ?? BUILT_IN_THEMES[0];
}

/** A colour that missed its minimum and was moved. `met` is false when no lightness could reach it. */
export interface Adjustment {
  key: ThemeKey | "yellow";
  from: string;
  to: string;
  ratio: number;
  minimum: number;
  met: boolean;
}

export interface ResolvedTheme {
  id: string;
  dark: boolean;
  /** CSS custom properties to set on the document. */
  vars: Record<string, string>;
  /** Final colours of the theme keys, as drawn. */
  colors: Record<ThemeKey, Rgba>;
  adjustments: Adjustment[];
  closedNotch: boolean;
}

/** From a theme file to NotNotch's tokens. */
export function resolveTheme(file: ThemeFile): ResolvedTheme {
  const written = (k: ThemeKey) => parseColor(file.colors[k]);
  const bg = over(written("background") ?? BLACK, BLACK);
  const dark = isDark(bg);
  const mode = dark ? MODES.dark : MODES.light;
  const ink = written("foreground") ?? parseColor(mode.foreground)!;
  const elevated = over(written("elevated") ?? (dark ? mix(bg, over(ink, bg), 0.11) : mix(bg, WHITE, 0.8)), bg);

  const needs = (minimum: number, ...backgrounds: Rgba[]): ContrastNeed[] => backgrounds.map((background) => ({ background, minimum }));
  const adjustments: Adjustment[] = [];
  const ensure = (key: Adjustment["key"], c: Rgba, list: ContrastNeed[]): Rgba => {
    const after = ensureContrast(c, list);
    if (after === c) return c;
    const worst = list.reduce((a, b) => (contrast(c, a.background) / a.minimum <= contrast(c, b.background) / b.minimum ? a : b));
    const met = list.every((n) => contrast(after, n.background) >= n.minimum);
    adjustments.push({ key, from: formatColor(c), to: formatColor(after), ratio: contrast(c, worst.background), minimum: worst.minimum, met });
    return after;
  };
  const pick = (k: ThemeKey, fallback: string | Rgba) => written(k) ?? (typeof fallback === "string" ? parseColor(fallback)! : fallback);

  // The foreground first (its fill-3 check uses the written ink), then every tint from the foreground as drawn.
  const foreground = ensure("foreground", ink, [...needs(STRONG_TEXT, bg, elevated), ...needs(TEXT, over(withAlpha(ink, mode.alpha.fill3), bg))]);
  const tint = (a: number) => withAlpha(foreground, a);
  const fill = [tint(mode.alpha.fill1), tint(mode.alpha.fill2), tint(mode.alpha.fill3)];
  const [fill1, fill2] = fill.map((f) => over(f, bg));
  const accent = ensure("accent", pick("accent", mode.accent), needs(GRAPHIC, bg, elevated));

  const colors: Record<ThemeKey, Rgba> = {
    background: bg,
    elevated,
    foreground,
    secondary: ensure("secondary", pick("secondary", tint(mode.alpha.secondary)), needs(TEXT, bg, elevated, fill1, fill2)),
    tertiary: ensure("tertiary", pick("tertiary", tint(mode.alpha.tertiary)), needs(TERTIARY, bg, elevated, fill1)),
    accent,
    link: ensure("link", pick("link", accent), needs(GRAPHIC, bg, elevated)),
    warning: ensure("warning", pick("warning", mode.warning), needs(TEXT, bg)),
    critical: ensure("critical", pick("critical", mode.critical), needs(TEXT, bg)),
    success: ensure("success", pick("success", mode.success), needs(GRAPHIC, bg)),
  };
  const yellow = ensure("yellow", parseColor(mode.yellow)!, needs(GRAPHIC, bg));
  // Ink on label-coloured fills and on scrims (Tailwind's `black`): whichever of black and white reads better on the foreground.
  const label = over(colors.foreground, bg);
  const onLabel = contrast(WHITE, label) > contrast(BLACK, label) ? WHITE : BLACK;
  const closedNotch = file.closedNotch === "background";

  const vars: Record<string, string> = {
    "--color-notch": formatColor(bg),
    "--color-label": formatColor(colors.foreground),
    "--color-label-2": formatColor(colors.secondary),
    "--color-label-3": formatColor(colors.tertiary),
    "--color-label-4": formatColor(tint(mode.alpha.label4)),
    "--color-fill-1": formatColor(fill[0]),
    "--color-fill-2": formatColor(fill[1]),
    "--color-fill-3": formatColor(fill[2]),
    "--color-separator": formatColor(tint(mode.alpha.separator)),
    "--color-elevated": formatColor(elevated),
    "--color-green": formatColor(colors.success),
    "--color-red": formatColor(colors.critical),
    "--color-orange": formatColor(colors.warning),
    "--color-yellow": formatColor(yellow),
    "--color-link": formatColor(colors.link),
    "--color-black": formatColor(onLabel),
    "--theme-accent": formatColor(colors.accent),
    "--notch-closed": closedNotch ? formatColor(bg) : "#000000",
  };
  // Coloured icons sit on the panel, the elevated cards, the Hardware rows and the active dock pill.
  const hueGrounds = needs(GRAPHIC, bg, elevated, fill1, over(fill[2], bg));
  for (const [hue, [onDark, onLight]] of Object.entries(HUE_PALETTE)) {
    vars[`--hue-${hue}`] = formatColor(ensureContrast(parseColor(dark ? onDark : onLight)!, hueGrounds));
  }
  return { id: file.id, dark, vars, colors, adjustments, closedNotch };
}

/** Coloured icons (Settings, Themes; hues.ts): a bright shade for dark themes and a darker one for light themes, then held to 3:1 like every other colour. */
export const HUE_PALETTE = {
  red: ["#f87171", "#dc2626"],
  orange: ["#fb923c", "#ea580c"],
  amber: ["#fbbf24", "#d97706"],
  yellow: ["#facc15", "#ca8a04"],
  lime: ["#a3e635", "#65a30d"],
  green: ["#4ade80", "#16a34a"],
  emerald: ["#34d399", "#059669"],
  teal: ["#2dd4bf", "#0d9488"],
  cyan: ["#22d3ee", "#0891b2"],
  sky: ["#38bdf8", "#0284c7"],
  blue: ["#60a5fa", "#2563eb"],
  indigo: ["#818cf8", "#4f46e5"],
  violet: ["#a78bfa", "#7c3aed"],
  purple: ["#c084fc", "#9333ea"],
  pink: ["#f472b6", "#db2777"],
  rose: ["#fb7185", "#e11d48"],
  slate: ["#a8b3c4", "#64748b"],
} as const;
export type Hue = keyof typeof HUE_PALETTE;

/** Before 0.3.3 a Hardware switch coloured only the closed-row readings; saved settings that had it on keep coloured icons. */
export const legacyIconColors = (system: unknown) => typeof system === "object" && system !== null && (system as { iconColors?: unknown }).iconColors === true;

/** The cover colour as the open panel draws it: held to 3:1 on the background, unchanged where it already passes. */
export function readableAccent(raw: string, theme: ResolvedTheme): string {
  const c = parseColor(raw);
  if (!c) return raw;
  const after = ensureContrast(c, [{ background: theme.colors.background, minimum: GRAPHIC }]);
  return after === c ? raw : formatColor(after);
}

// ---------- Editing ----------

/** `#rrggbb`, or `#rrggbbaa` for a translucent colour. */
export function hexWithAlpha(c: Rgba): string {
  return c.a >= 1 ? toHex(c) : toHex(c) + Math.round(c.a * 255).toString(16).padStart(2, "0");
}

/**
 * The file after one of the editor's colours changes. A new background or foreground drops the
 * written secondary, tertiary and pop-up colours, so they follow from the new pair again; a
 * background that turns a dark theme light (or back) also brings a foreground that reads on it,
 * unless the written one already does. A translucent colour keeps its opacity.
 */
export function setThemeColor(file: ThemeFile, key: ThemeKey, value: Rgba): ThemeFile {
  const previous = parseColor(file.colors[key]);
  const next = key === "background" ? withAlpha(value, 1) : withAlpha(value, previous?.a ?? 1);
  const colors: ThemeFile["colors"] = { ...file.colors, [key]: hexWithAlpha(next) };
  if (key === "background" || key === "foreground") {
    delete colors.secondary;
    delete colors.tertiary;
    delete colors.elevated;
  }
  // Links follow a new accent.
  if (key === "accent") delete colors.link;
  if (key === "background") {
    const before = over(parseColor(file.colors.background) ?? BLACK, BLACK);
    const nowDark = isDark(next);
    const fg = parseColor(file.colors.foreground);
    if (nowDark !== isDark(before) && (!fg || contrast(fg, next) < TEXT)) colors.foreground = nowDark ? MODES.dark.foreground : MODES.light.foreground;
  }
  return { ...file, colors };
}

// ---------- Ids, files and validation ----------

export function normalizeId(id: unknown): string {
  const text = String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return text.slice(0, 64).replace(/[-.]+$/, "");
}

/** `base`, or `base-2`, `base-3` … if that id is taken. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const id = normalizeId(base) || "theme";
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return `${id}-${n}`;
}

/** A problem with a file, as a German key for t() and its placeholders. */
export interface ThemeProblem {
  key: string;
  vars?: Record<string, string | number>;
}

export type ThemeCheck = { theme: ThemeFile; problems: [] } | { theme: null; problems: ThemeProblem[] };

const OPTIONAL_TEXT = ["description", "author", "license", "homepage"] as const;

/** Checks a parsed theme object and returns a clean copy (unknown top-level fields are dropped). */
export function validateTheme(input: unknown): ThemeCheck {
  const problems: ThemeProblem[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { theme: null, problems: [{ key: "Keine Theme-Datei: ein JSON-Objekt erwartet" }] };
  const o = input as Record<string, unknown>;
  if (o.format !== undefined && o.format !== 1) {
    problems.push(typeof o.format === "number" && o.format > 1 ? { key: "Format {n} ist neuer als diese Version von NotNotch", vars: { n: o.format } } : { key: "Unbekanntes Format" });
  }
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 60) : "";
  const id = normalizeId(o.id ?? name);
  if (!id) problems.push({ key: "Name oder ID fehlt" });
  const colors: ThemeFile["colors"] = {};
  if (typeof o.colors !== "object" || o.colors === null || Array.isArray(o.colors)) problems.push({ key: "„colors“ fehlt oder ist kein Objekt" });
  else
    for (const [key, value] of Object.entries(o.colors)) {
      if (!(THEME_KEYS as readonly string[]).includes(key)) problems.push({ key: "Unbekannte Farbe „{key}“", vars: { key } });
      else if (!parseColor(value)) problems.push({ key: "„{key}“ ist keine Farbe: {value}", vars: { key, value: String(value).slice(0, 40) } });
      else colors[key as ThemeKey] = String(value).trim();
    }
  if (o.closedNotch !== undefined && o.closedNotch !== "black" && o.closedNotch !== "background") problems.push({ key: "„closedNotch“ muss „black“ oder „background“ sein" });
  if (problems.length) return { theme: null, problems };
  const theme: ThemeFile = { format: 1, id, name: name || id, colors };
  for (const k of OPTIONAL_TEXT) if (typeof o[k] === "string" && o[k]) theme[k] = (o[k] as string).slice(0, 200);
  if (o.closedNotch === "background") theme.closedNotch = "background";
  return { theme, problems: [] };
}

/** A theme file's text: size, JSON, then validateTheme. */
export function parseThemeText(text: string): ThemeCheck {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) return { theme: null, problems: [{ key: "Datei größer als 64 KB" }] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { theme: null, problems: [{ key: "Kein gültiges JSON: {error}", vars: { error: e instanceof Error ? e.message : String(e) } }] };
  }
  return validateTheme(value);
}

/** The file as NotNotch writes it on export. */
export function themeToText(theme: ThemeFile): string {
  const { format, id, name, description, author, license, homepage, colors, closedNotch } = theme;
  const ordered: Partial<Record<ThemeKey, string>> = {};
  for (const k of THEME_KEYS) if (colors[k]) ordered[k] = colors[k];
  return JSON.stringify({ format, id, name, description, author, license, homepage, colors: ordered, closedNotch }, null, 2) + "\n";
}

export interface ImportResult {
  added: ThemeFile[];
  /** Files that are already there: equal to a custom theme, or an export of a built-in one. */
  unchanged: number;
  failed: { file: string; problems: ThemeProblem[] }[];
}

/** Same colours (compared as colours, so `#FFF` equals `#ffffff`). */
export function sameColors(a: ThemeFile, b: ThemeFile): boolean {
  const same = (x: Rgba | null, y: Rgba | null) => (x && y ? x.r === y.r && x.g === y.g && x.b === y.b && Math.abs(x.a - y.a) < 0.002 : x === y);
  return THEME_KEYS.every((k) => same(parseColor(a.colors[k]), parseColor(b.colors[k]))) && (a.closedNotch ?? "black") === (b.closedNotch ?? "black");
}

/**
 * Adds the valid files to the custom themes and never replaces one: the folder may hold an old
 * export of a theme edited since. A file equal to a theme that is already there is skipped; one
 * that shares a custom theme's id but differs comes in under a new id (`id-2`). A file with a
 * built-in id is skipped when it is that theme's export, refused when its colours differ.
 */
export function importThemes(custom: readonly ThemeFile[], files: { file: string; text?: string | null; error?: string | null }[]): ImportResult & { custom: ThemeFile[] } {
  const next = [...custom];
  const result: ImportResult = { added: [], unchanged: 0, failed: [] };
  for (const f of files) {
    const check: ThemeCheck = f.error || f.text == null ? { theme: null, problems: [{ key: f.error ?? "Datei nicht lesbar" }] } : parseThemeText(f.text);
    if (!check.theme) {
      result.failed.push({ file: f.file, problems: check.problems });
      continue;
    }
    const theme = check.theme;
    const builtIn = BUILT_IN_THEMES.find((t) => t.id === theme.id);
    if (builtIn) {
      if (sameColors(builtIn, theme)) result.unchanged++;
      else result.failed.push({ file: f.file, problems: [{ key: "Die ID „{id}“ gehört zu einem eingebauten Theme", vars: { id: theme.id } }] });
      continue;
    }
    if (next.some((t) => t.name === theme.name && sameColors(t, theme))) {
      result.unchanged++;
      continue;
    }
    const taken = new Set([...BUILT_IN_THEMES, ...next].map((t) => t.id));
    const added = taken.has(theme.id) ? { ...theme, id: uniqueId(theme.id, taken) } : theme;
    next.push(added);
    result.added.push(added);
  }
  return { ...result, custom: next };
}

// ---------- Settings ----------

export const THEME_DEFAULTS: ThemeSettings = {
  id: DEFAULT_THEME,
  custom: [],
  schedule: { on: false, day: "light", night: "dark", dayStart: "07:00", nightStart: "19:00" },
  iconColors: false,
  coverTint: false,
  font: "inter",
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Saved settings from any version: invalid custom themes and duplicate ids dropped, times checked.
 * `legacyIconColors`: the Hardware switch that coloured only the closed-row readings before 0.3.3, kept if it was on.
 */
export function normalizeThemeSettings(raw: unknown, legacyIconColors = false): ThemeSettings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ThemeSettings>;
  const custom: ThemeFile[] = [];
  for (const t of Array.isArray(s.custom) ? s.custom : []) {
    const check = validateTheme(t);
    if (check.theme && !isBuiltIn(check.theme.id) && !custom.some((c) => c.id === check.theme!.id)) custom.push(check.theme);
  }
  const d = THEME_DEFAULTS.schedule;
  const sc = (typeof s.schedule === "object" && s.schedule !== null ? s.schedule : {}) as Partial<ThemeSettings["schedule"]>;
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);
  const time = (v: unknown, fallback: string) => (typeof v === "string" && TIME.test(v) ? v : fallback);
  return {
    id: text(s.id, THEME_DEFAULTS.id),
    custom,
    schedule: {
      on: sc.on === true,
      day: text(sc.day, d.day),
      night: text(sc.night, d.night),
      dayStart: time(sc.dayStart, d.dayStart),
      nightStart: time(sc.nightStart, d.nightStart),
    },
    iconColors: typeof s.iconColors === "boolean" ? s.iconColors : legacyIconColors,
    coverTint: s.coverTint === true,
    font: typeof s.font === "string" && Object.hasOwn(FONTS, s.font) ? s.font : THEME_DEFAULTS.font,
  };
}
