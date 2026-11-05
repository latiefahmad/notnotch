import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, tokenize } from "./highlight.ts";

const kinds = (text: string, lang: Parameters<typeof tokenize>[1]) => tokenize(text, lang).filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`);

test("tokens join back to the exact text in every language", () => {
  const samples = ["const a = \"x\"; // hi\n", "fn main() { let x = 0x1F; }", "def f(s='it\\'s'):\n    return 1.5e3  # end", "/* open", "\"unclosed\n", "", "plain text"];
  for (const lang of LANGUAGES) for (const s of samples) assert.equal(tokenize(s, lang).map((t) => t.text).join(""), s, `${lang}: ${s}`);
});

test("javascript and typescript", () => {
  assert.deepEqual(kinds("const a = 'x'; // c", "javascript"), ["keyword:const", "string:'x'", "comment:// c"]);
  assert.deepEqual(kinds("let n: number = 42", "typescript"), ["keyword:let", "keyword:number", "number:42"]);
  assert.deepEqual(kinds("let n: number", "javascript"), ["keyword:let"]);
  // Keywords inside strings and comments are not keywords; case matters.
  assert.deepEqual(kinds("\"return\" /* if */ Return", "javascript"), ["string:\"return\"", "comment:/* if */"]);
});

test("rust lifetimes are not strings", () => {
  assert.deepEqual(kinds("fn f<'a>(x: &'a str) -> char { 'z' }", "rust"), ["keyword:fn", "string:'z'"]);
});

test("python comments and triple quotes", () => {
  assert.deepEqual(kinds("x = \"\"\"doc\nmore\"\"\"  # note", "python"), ["string:\"\"\"doc\nmore\"\"\"", "comment:# note"]);
  assert.deepEqual(kinds("if x is None: pass", "python"), ["keyword:if", "keyword:is", "keyword:None", "keyword:pass"]);
});

test("plain text is one run", () => {
  assert.deepEqual(tokenize("const x // y", "plain"), [{ kind: "plain", text: "const x // y" }]);
});
