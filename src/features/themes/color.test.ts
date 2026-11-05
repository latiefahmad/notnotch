import { test } from "node:test";
import assert from "node:assert/strict";
import { BLACK, WHITE, contrast, ensureContrast, formatColor, fromHsl, fromHsv, mix, over, parseColor, toHex, toHsl, toHsv } from "./color.ts";

const c = (s: string) => parseColor(s)!;

test("parse and format", () => {
  assert.deepEqual(parseColor("#fff"), WHITE);
  assert.deepEqual(parseColor("#0A84FF"), { r: 10, g: 132, b: 255, a: 1 });
  assert.equal(parseColor("#ffffff80")!.a, 128 / 255);
  assert.deepEqual(parseColor("rgb(255 255 255 / 0.96)"), { r: 255, g: 255, b: 255, a: 0.96 });
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assert.equal(toHex(parseColor("hsl(210 100% 60%)")!), "#3399ff");
  for (const bad of ["", "#12", "#ggg", "red", "rgb(300 0 0)", "rgb(0 0 0 / 2)", "rgb(1.2.3 0 0)", "hsl(1.2.3 50% 50%)", "hsl(0 120% 50%)", "hsl(0 50% 101%)", "hsl(0 50% 50% / 2)", 5, null])
    assert.equal(parseColor(bad), null, String(bad));
  assert.deepEqual(parseColor("hsl(0 100% 50% / 0.5)"), { r: 255, g: 0, b: 0, a: 0.5 });
  assert.equal(formatColor(c("#ABCDEF")), "#abcdef");
  assert.equal(formatColor({ r: 255, g: 255, b: 255, a: 0.1 }), "rgb(255 255 255 / 0.1)");
});

test("over and mix", () => {
  assert.deepEqual(over({ r: 255, g: 255, b: 255, a: 0.5 }, BLACK), { r: 128, g: 128, b: 128, a: 1 });
  assert.deepEqual(over(WHITE, BLACK), WHITE);
  assert.deepEqual(mix(BLACK, WHITE, 0.5), { r: 128, g: 128, b: 128, a: 1 });
  assert.deepEqual(mix(BLACK, WHITE, 3), WHITE);
});

test("WCAG contrast", () => {
  assert.equal(Math.round(contrast(WHITE, BLACK) * 100) / 100, 21);
  assert.equal(contrast(BLACK, BLACK), 1);
  // Known value: #767676 on white is the lightest gray that passes 4.5:1.
  assert.ok(contrast(c("#767676"), WHITE) >= 4.5 && contrast(c("#777777"), WHITE) < 4.5);
  // Translucent foreground is laid over the background first.
  assert.equal(contrast({ ...WHITE, a: 0 }, BLACK), 1);
});

test("HSL and HSV round trips", () => {
  for (const hex of ["#000000", "#ffffff", "#ff453a", "#30d158", "#0a84ff", "#7f7f7f", "#21252b"]) {
    const col = c(hex);
    assert.equal(toHex(fromHsl(...toHsl(col))), hex);
    assert.equal(toHex(fromHsv(...toHsv(col))), hex);
  }
  assert.deepEqual(toHsv(c("#ff0000")), [0, 1, 1]);
  assert.equal(toHex(fromHsv(120, 1, 1)), "#00ff00");
  assert.equal(toHex(fromHsv(-240, 1, 1)), "#00ff00");
});

test("ensureContrast leaves a passing colour alone", () => {
  const ok = c("#ff9f0a");
  assert.equal(ensureContrast(ok, [{ background: BLACK, minimum: 4.5 }]), ok);
  assert.equal(ensureContrast(ok, []), ok);
});

test("ensureContrast moves just far enough along the hue", () => {
  const yellow = c("#ffd60a");
  const fixed = ensureContrast(yellow, [{ background: WHITE, minimum: 4.5 }]);
  const r = contrast(fixed, WHITE);
  assert.ok(r >= 4.5 && r < 4.7, `ratio ${r}`);
  assert.ok(Math.abs(toHsl(fixed)[0] - toHsl(yellow)[0]) < 3, "hue kept");
  // A dark text on black goes lighter, not darker.
  const dim = ensureContrast(c("#333333"), [{ background: BLACK, minimum: 7 }]);
  assert.ok(contrast(dim, BLACK) >= 7 && toHsl(dim)[2] > 0.2);
  // Translucent text comes back opaque.
  assert.equal(ensureContrast({ r: 255, g: 255, b: 255, a: 0.2 }, [{ background: BLACK, minimum: 4.5 }]).a, 1);
});

test("ensureContrast takes the best worst case when nothing passes", () => {
  const needs = [
    { background: BLACK, minimum: 7 },
    { background: WHITE, minimum: 7 },
  ];
  const gray = c("#202020");
  const best = ensureContrast(gray, needs);
  const worst = (x: typeof gray) => Math.min(contrast(x, BLACK), contrast(x, WHITE));
  assert.ok(worst(best) > worst(gray));
  assert.ok(worst(best) > 4 && worst(best) < 5);
});
