import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranslation, translationLrc, translationPrompt } from "./translate.ts";
import { withExtra } from "./lrc.ts";

test("the prompt numbers the lines and skips empty ones", () => {
  const p = translationPrompt(["夜に", "", " 駆ける "], "Italian");
  assert.match(p, /into Italian/);
  assert.ok(p.endsWith("1\t夜に\n3\t駆ける"));
});

test("a reply is read by number and becomes LRC on the lines' stamps", () => {
  const reply = "Here you go:\n1\tAt night\n3: Running\n9\tout of range\n2\t\n";
  const out = parseTranslation(reply, 3);
  assert.deepEqual(out, ["At night", null, "Running"]);
  const lines = [{ time: 1.43, text: "夜に" }, { time: 5, text: "" }, { time: 61.5, text: "駆ける" }];
  const lrc = translationLrc(lines, out);
  assert.equal(lrc, "[00:01.43]At night\n[01:01.50]Running\n");
  assert.deepEqual(withExtra(lines, lrc, "translation").map((l) => l.translation), ["At night", undefined, "Running"]);
  assert.equal(translationLrc(lines, [null, null, null]), null);
});
