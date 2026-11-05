import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTES, quoteIndex } from "./quotes.ts";

test("same quote all day, next one tomorrow, Next wraps", () => {
  const morning = new Date(2026, 9, 31, 0, 1).getTime(), night = new Date(2026, 9, 31, 23, 59).getTime(), tomorrow = new Date(2026, 10, 1, 8).getTime();
  assert.equal(quoteIndex(morning, 0), quoteIndex(night, 0));
  assert.equal(quoteIndex(tomorrow, 0), (quoteIndex(night, 0) + 1) % QUOTES.length);
  assert.equal(quoteIndex(morning, QUOTES.length), quoteIndex(morning, 0));
  assert.equal(quoteIndex(morning, -1), (quoteIndex(morning, 0) + QUOTES.length - 1) % QUOTES.length);
});

test("every quote is short and attributed, without long dashes", () => {
  const dashes = new RegExp("[\\u2013\\u2014]");
  for (const q of QUOTES) {
    assert.ok(q.text.length <= 100, q.text);
    assert.ok(q.author && q.source);
    assert.ok(!dashes.test(q.text + q.author + q.source));
  }
});
