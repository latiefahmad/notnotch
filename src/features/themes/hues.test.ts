import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, over, parseColor } from "./color.ts";
import { BUILT_IN_THEMES, GRAPHIC, HUE_PALETTE, legacyIconColors, resolveTheme } from "./themes.ts";

// The modules that use hues touch localStorage or React on import, so they are read from the source.
const read = (path: string) => readFileSync(join(import.meta.dirname, path), "utf8");
const HUES = Object.keys(HUE_PALETTE);
const used = (src: string) => [...src.matchAll(/hue: (?:\w+ \? )?"(\w+)"(?: : "(\w+)")?/g)].flatMap((m) => m.slice(1).filter(Boolean));

test("every hue reads at 3:1 on every built-in theme: panel, cards, Hardware rows and the active dock pill", () => {
  for (const theme of BUILT_IN_THEMES) {
    const r = resolveTheme(theme);
    const bg = r.colors.background;
    const grounds = [bg, r.colors.elevated, over(parseColor(r.vars["--color-fill-1"])!, bg), over(parseColor(r.vars["--color-fill-3"])!, bg)];
    for (const hue of HUES) {
      const c = parseColor(r.vars[`--hue-${hue}`]);
      assert.ok(c, `${theme.id} ${hue}`);
      for (const g of grounds) assert.ok(contrast(c, g) >= GRAPHIC - 0.01, `${theme.id} ${hue} ${contrast(c, g).toFixed(2)}`);
    }
  }
});

test("a mid-grey custom background still gets readable hues", () => {
  const r = resolveTheme({ id: "grey", name: "Grey", colors: { background: "#8a8a8a" } });
  for (const hue of HUES) assert.ok(contrast(parseColor(r.vars[`--hue-${hue}`])!, r.colors.background) >= GRAPHIC - 0.01, hue);
});

test("every built-in tool has a hue of the palette", () => {
  const tabs = read("../../notch/tabs.ts");
  const list = tabs.slice(tabs.indexOf("export const tabs"), tabs.indexOf("satisfies NotchTab[]"));
  const ids = [...list.matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
  const hues = [...list.matchAll(/hue: "(\w+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 20);
  assert.equal(hues.length, ids.length);
  for (const h of hues) assert.ok(HUES.includes(h), h);
});

test("settings pages, weather and Hardware use hues of the palette", () => {
  const pages = used(read("../settings/SettingsView.tsx"));
  const weather = used(read("../weather/store.ts"));
  const hardware = [...read("../system/SystemView.tsx").matchAll(/hue="(\w+)"|useHue\("(\w+)"\)/g)].map((m) => m[1] ?? m[2]);
  assert.ok(pages.length >= 10 && weather.length >= 8 && hardware.length >= 8);
  for (const h of [...pages, ...weather, ...hardware]) assert.ok(HUES.includes(h), h);
});

test("the old Hardware switch carries over only when it was really on", () => {
  assert.equal(legacyIconColors(undefined), false);
  assert.equal(legacyIconColors({}), false);
  assert.equal(legacyIconColors({ iconColors: "true" }), false);
  assert.equal(legacyIconColors({ iconColors: true, colors: "calm" }), true);
});
