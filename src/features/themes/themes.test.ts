import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrast, over, parseColor } from "./color.ts";
import {
  BUILT_IN_THEMES,
  THEME_DEFAULTS,
  findTheme,
  importThemes,
  normalizeId,
  normalizeThemeSettings,
  parseThemeText,
  readableAccent,
  resolveTheme,
  setThemeColor,
  themeToText,
  uniqueId,
  validateTheme,
  type ThemeFile,
} from "./themes.ts";

const dark = BUILT_IN_THEMES[0];
const light = BUILT_IN_THEMES[1];

test("every built-in theme passes the readability rules as written", () => {
  for (const t of BUILT_IN_THEMES) assert.deepEqual(resolveTheme(t).adjustments, [], t.id);
  assert.deepEqual(
    BUILT_IN_THEMES.map((t) => t.id),
    [
      "dark",
      "light",
      "one-dark-pro",
      "github-dark",
      "github-light",
      "dracula",
      "night-owl",
      "catppuccin-mocha",
      "catppuccin-latte",
      "nord",
      "rose-pine",
      "rose-pine-dawn",
      "gruvbox-dark",
      "solarized-light",
      "everforest",
    ],
  );
});

test("built-in themes keep the closed notch black", () => {
  for (const t of BUILT_IN_THEMES) assert.equal(resolveTheme(t).vars["--notch-closed"], "#000000", t.id);
  assert.equal(resolveTheme({ ...light, id: "x", closedNotch: "background" }).vars["--notch-closed"], "#fafafc");
});

test("Dark resolves to exactly the tokens in tokens.css", () => {
  const css = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  const vars = resolveTheme(dark).vars;
  const tokens = [...css.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)].filter(([, name]) => name !== "--color-accent");
  assert.ok(tokens.length >= 15);
  for (const [, name, value] of tokens) {
    const want = parseColor(value)!;
    const got = parseColor(vars[name]);
    assert.ok(got, `${name} missing`);
    assert.deepEqual({ ...got, a: Math.round(got.a * 1000) }, { ...want, a: Math.round(want.a * 1000) }, name);
  }
});

test("light themes flip the ink on label fills", () => {
  assert.equal(resolveTheme(dark).vars["--color-black"], "#000000");
  assert.equal(resolveTheme(light).vars["--color-black"], "#ffffff");
  assert.equal(resolveTheme(light).dark, false);
});

test("a file of a few colours is a complete theme, and a weak colour is corrected", () => {
  const r = resolveTheme({ format: 1, id: "pale", name: "Pale", colors: { background: "#ffffff", warning: "#ffd60a" } });
  assert.equal(r.dark, false);
  assert.equal(r.vars["--color-label"], "#1d1d1f");
  const warn = parseColor(r.vars["--color-orange"])!;
  assert.ok(contrast(warn, parseColor("#ffffff")!) >= 4.5);
  assert.deepEqual(
    r.adjustments.map((a) => [a.key, a.from, a.met]),
    [["warning", "#ffd60a", true]],
  );
  // A translucent background is laid over black.
  assert.equal(resolveTheme({ format: 1, id: "t", name: "T", colors: { background: "#ffffff00" } }).vars["--color-notch"], "#000000");
});

test("fills, separator and label-4 follow the corrected foreground", () => {
  const r = resolveTheme({ format: 1, id: "dim", name: "Dim", colors: { background: "#000000", foreground: "#333333" } });
  const fg = parseColor(r.vars["--color-label"])!;
  assert.notEqual(fg.r, 0x33);
  for (const name of ["--color-fill-1", "--color-fill-3", "--color-separator", "--color-label-4"]) assert.equal(parseColor(r.vars[name])!.r, fg.r, name);
});

test("Dark keeps NotNotch's idle accent and its own link colour", () => {
  const v = resolveTheme(dark).vars;
  assert.equal(v["--theme-accent"], "#0a84ff");
  assert.equal(v["--color-link"], "#419cff");
  // Without a written link, links follow the accent.
  assert.equal(resolveTheme(light).vars["--color-link"], "#0066cc");
});

test("readable accent: unchanged on black, darkened on a light panel", () => {
  const onDark = resolveTheme(dark);
  assert.equal(readableAccent("hsl(60 90% 70%)", onDark), "hsl(60 90% 70%)");
  const fixed = readableAccent("hsl(60 90% 70%)", resolveTheme(light));
  assert.ok(contrast(parseColor(fixed)!, parseColor("#fafafc")!) >= 3);
  assert.equal(readableAccent("not a colour", onDark), "not a colour");
});

test("setThemeColor re-derives from a new background or foreground", () => {
  const odp = findTheme("one-dark-pro", []);
  const next = setThemeColor(odp, "background", parseColor("#101010")!);
  assert.equal(next.colors.background, "#101010");
  assert.equal(next.colors.secondary, undefined);
  assert.equal(next.colors.elevated, undefined);
  assert.equal(next.colors.foreground, odp.colors.foreground);
  // Dark to light with a light foreground: the foreground follows.
  const flipped = setThemeColor(odp, "background", parseColor("#f4f4f4")!);
  assert.equal(flipped.colors.foreground, "#1d1d1f");
  // A translucent foreground keeps its opacity; the accent leaves everything else alone.
  assert.equal(setThemeColor(dark, "foreground", parseColor("#ff0000")!).colors.foreground, "#ff0000f5");
  assert.equal(setThemeColor(dark, "accent", parseColor("#00ff00")!).colors.link, undefined);
  const accent = setThemeColor(odp, "accent", parseColor("#00ff00")!);
  assert.equal(accent.colors.secondary, odp.colors.secondary);
});

test("ids", () => {
  assert.equal(normalizeId("  Midnight Teal! "), "midnight-teal");
  assert.equal(normalizeId("..x.."), "x");
  assert.equal(normalizeId("a..b"), "a.b");
  assert.equal(normalizeId("a".repeat(80)).length, 64);
  assert.equal(normalizeId(undefined), "");
  assert.equal(uniqueId("Dark", new Set(["dark", "dark-2"])), "dark-3");
  assert.equal(uniqueId("", new Set()), "theme");
});

test("theme file validation", () => {
  const ok = validateTheme({ format: 1, name: "Midnight teal", colors: { background: "#04161A", accent: "#2DD4BF" }, extra: 1 });
  assert.ok(ok.theme);
  assert.equal(ok.theme.id, "midnight-teal");
  assert.equal("extra" in ok.theme, false);
  const keys = (x: unknown) => validateTheme(x).problems.map((p) => p.key);
  assert.deepEqual(keys([]), ["Keine Theme-Datei: ein JSON-Objekt erwartet"]);
  assert.deepEqual(keys({ name: "x" }), ["„colors“ fehlt oder ist kein Objekt"]);
  assert.deepEqual(keys({ name: "x", colors: { foregound: "#fff" } }), ["Unbekannte Farbe „{key}“"]);
  assert.deepEqual(keys({ name: "x", colors: { accent: "blue" } }), ["„{key}“ ist keine Farbe: {value}"]);
  assert.deepEqual(keys({ format: 2, name: "x", colors: {} }), ["Format {n} ist neuer als diese Version von NotNotch"]);
  assert.deepEqual(keys({ colors: {} }), ["Name oder ID fehlt"]);
  assert.deepEqual(keys({ name: "x", colors: {}, closedNotch: "white" }), ["„closedNotch“ muss „black“ oder „background“ sein"]);
  assert.equal(validateTheme({ name: "x", colors: {}, closedNotch: "background" }).theme?.closedNotch, "background");
});

test("theme file text: JSON, size, round trip", () => {
  assert.equal(parseThemeText("{").problems[0].key, "Kein gültiges JSON: {error}");
  assert.equal(parseThemeText(" ".repeat(70_000)).problems[0].key, "Datei größer als 64 KB");
  for (const t of BUILT_IN_THEMES) assert.deepEqual(parseThemeText(themeToText(t)).theme, t);
});

test("import adds, never replaces, and skips what is already there", () => {
  const mine: ThemeFile = { format: 1, id: "mine", name: "Mine", colors: { accent: "#ff0000" } };
  const r = importThemes(
    [mine],
    [
      { file: "a.json", text: JSON.stringify({ name: "New one", colors: {} }) },
      { file: "b.json", text: JSON.stringify({ id: "mine", name: "Mine", colors: { accent: "#00ff00" } }) },
      { file: "b2.json", text: JSON.stringify({ id: "mine", name: "Mine", colors: { accent: "#FF0000" } }) },
      { file: "c.json", text: JSON.stringify({ id: "dark", name: "Fake", colors: {} }) },
      { file: "dark.json", text: themeToText(BUILT_IN_THEMES[0]) },
      { file: "d.json", text: "nope" },
      { file: "e.json", error: "Datei größer als 64 KB" },
    ],
  );
  // The old export of "mine" with other colours comes in beside it; the equal one is skipped, as is Dark's own export.
  assert.deepEqual(r.added.map((t) => t.id), ["new-one", "mine-2"]);
  assert.equal(r.unchanged, 2);
  assert.deepEqual(r.failed.map((f) => f.file), ["c.json", "d.json", "e.json"]);
  assert.deepEqual(r.custom.map((t) => [t.id, t.colors.accent]), [["mine", "#ff0000"], ["new-one", undefined], ["mine-2", "#00ff00"]]);
  // Importing the same folder again adds nothing.
  assert.deepEqual(importThemes(r.custom, [{ file: "b.json", text: JSON.stringify({ id: "mine", name: "Mine", colors: { accent: "#00ff00" } }) }]).added, []);
});

test("settings normalisation", () => {
  assert.deepEqual(normalizeThemeSettings(undefined), THEME_DEFAULTS);
  const s = normalizeThemeSettings({
    id: "mine",
    custom: [{ id: "mine", name: "Mine", colors: {} }, { id: "mine", name: "Again", colors: {} }, { id: "dark", name: "X", colors: {} }, { bad: true }],
    schedule: { on: true, dayStart: "25:00", nightStart: "21:30" },
  });
  assert.deepEqual(s.custom.map((t) => t.name), ["Mine"]);
  assert.deepEqual(s.schedule, { on: true, day: "light", night: "dark", dayStart: "07:00", nightStart: "21:30" });
  assert.equal(findTheme("gone", s.custom).id, "dark");
});

test("coloured icons: off by default, the old Hardware switch carries over until the theme setting is saved", () => {
  assert.equal(normalizeThemeSettings({}).iconColors, false);
  assert.equal(normalizeThemeSettings({}, true).iconColors, true);
  assert.equal(normalizeThemeSettings({ iconColors: false }, true).iconColors, false);
  assert.equal(normalizeThemeSettings({ iconColors: "yes" }).iconColors, false);
});

test("cover tint: off by default, on only when saved as true", () => {
  assert.equal(normalizeThemeSettings({}).coverTint, false);
  assert.equal(normalizeThemeSettings({ coverTint: true }).coverTint, true);
  assert.equal(normalizeThemeSettings({ coverTint: "true" }).coverTint, false);
  assert.equal(normalizeThemeSettings({}).font, "inter");
  assert.equal(normalizeThemeSettings({ font: "georgia" }).font, "georgia");
  assert.equal(normalizeThemeSettings({ font: "Papyrus" }).font, "inter");
  assert.equal(normalizeThemeSettings({ font: "toString" }).font, "inter");
});

test("over keeps the pop-up colours opaque", () => {
  for (const t of BUILT_IN_THEMES) assert.equal(parseColor(resolveTheme(t).vars["--color-elevated"])!.a, 1);
  assert.equal(over(parseColor("#00000000")!, parseColor("#123456")!).r, 0x12);
});
