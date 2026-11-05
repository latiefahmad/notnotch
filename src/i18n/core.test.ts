import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { backendText, LANGUAGE_NAMES, LANGUAGES, languageOf, localeFor, resolveLanguage, translate, type Dict } from "./core.ts";

test("an explicit language wins, everything else is English", () => {
  assert.equal(resolveLanguage("id"), "id");
  assert.equal(resolveLanguage("en"), "en");
  assert.equal(resolveLanguage("system"), "en", "the old default setting is English now");
  assert.equal(resolveLanguage("de"), "en", "no longer selectable");
  assert.equal(resolveLanguage("xx"), "en");
  assert.equal(resolveLanguage(undefined), "en");
  assert.equal(resolveLanguage("not a tag!"), "en");
  // The locale still follows the system's region for the same language.
  assert.equal(languageOf("id-ID"), "id");
  assert.equal(languageOf("en-US"), "en");
  assert.equal(languageOf("de-DE"), null, "German is no longer selectable");
  assert.equal(languageOf(""), null);
});

test("every language resolves to itself and has its own name and a dictionary file", () => {
  const files = new Set(readdirSync(new URL(".", import.meta.url)));
  for (const l of LANGUAGES) {
    assert.equal(languageOf(l), l);
    assert.ok(LANGUAGE_NAMES[l]);
    assert.ok(files.has(`${l}.json`), `${l}.json`);
  }
});

test("the locale keeps the system's region for the same language", () => {
  assert.equal(localeFor("en", "en-US"), "en-US");
  assert.equal(localeFor("en", "de-DE"), "en-GB");
  assert.equal(localeFor("id", "en-US"), "id-ID");
  assert.equal(localeFor("id", undefined), "id-ID");
  for (const l of LANGUAGES) assert.doesNotThrow(() => new Intl.NumberFormat(localeFor(l, "")));
});