import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLine, queryWords } from "./match.ts";

const hits = (line: string, query: string) => matchLine(line, queryWords(query))?.map((s) => (s.hit ? `[${s.text}]` : s.text)).join("") ?? null;

test("every word must appear, in any order, ignoring case and accents", () => {
  assert.equal(hits("Café crème 3,50 €", "CREME cafe"), "[Café] [crème] 3,50 €");
  assert.equal(hits("Café crème", "café thé"), null);
  assert.equal(hits("Anything", "   "), null);
});

test("each occurrence is highlighted, overlaps merge", () => {
  assert.equal(hits("abab ab", "ab"), "[abab] [ab]");
  assert.equal(hits("Invoice number", "voice invoice"), "[Invoice] number");
});

test("highlights keep the original text around characters that fold to two", () => {
  // İ folds to i, the ligature ﬁ to two letters; the slices stay on the original string.
  assert.equal(hits("İstanbul Çeşme", "istanbul cesme"), "[İstanbul] [Çeşme]");
  assert.equal(hits("ﬁle", "fi"), "[ﬁ]le");
});
