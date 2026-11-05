import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount } from "./parse.ts";

test("plain numbers and either decimal mark", () => {
  assert.equal(parseAmount("100"), 100);
  assert.equal(parseAmount("12.5"), 12.5);
  assert.equal(parseAmount("1,5"), 1.5);
  assert.equal(parseAmount("0,500"), 0.5);
  assert.equal(parseAmount("-40"), -40);
  assert.equal(parseAmount("12."), 12);
});

test("thousands separators", () => {
  assert.equal(parseAmount("1,000"), 1000);
  assert.equal(parseAmount("1,000.50"), 1000.5);
  assert.equal(parseAmount("1.234,5"), 1234.5);
  assert.equal(parseAmount("1.234.567"), 1234567);
  assert.equal(parseAmount("1,234,567"), 1234567);
  assert.equal(parseAmount("1 000"), 1000);
});

test("nothing to read gives null", () => {
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("  "), null);
  assert.equal(parseAmount("-"), null);
  assert.equal(parseAmount("1,2,3.4.5"), null);
});
