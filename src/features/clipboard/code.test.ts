import { test } from "node:test";
import assert from "node:assert/strict";
import { isCode } from "./code.ts";

const code = [
  "npm run tauri dev",
  "git commit -m \"Fix the build\"",
  "const x = 1;",
  "items.filter((x) => x.done)",
  "SELECT id, name FROM users WHERE active = 1",
  "x = foo(bar)",
  "<div className=\"row\">",
  "{\"name\": \"notnotch\", \"version\": \"0.2.0\"}",
  "[1, 2, 3]",
  "const sessions = clips\n  .filter((clip) => clip.kind === \"code\")\n  .map((clip) => clip.content);\nconsole.log(sessions);",
  "def add(a, b):\n    # sum\n    return a + b",
  "fn main() {\n    println!(\"hi\");\n}",
  "use std::fs;\n\npub struct Notch {\n    width: u32,\n}",
  "for (let i = 0; i < n; i++) {\n  total += i;\n}",
  "body {\n  margin: 0;\n  color: red;\n}",
  "#include <stdio.h>\nint main(void) { return 0; }",
];

const prose = [
  "Ship the smallest useful version, then learn from real behavior.",
  "Call me (maybe) tomorrow",
  "if you want, call me",
  "Revise the report",
  "Hi Dina,\n\nThanks for the update. I'll send the report tomorrow.\n\nBest,\nAndrea",
  "- milk\n- eggs\n- bread",
  "# Shopping\n\nRemember the milk.\n\n## Later\n\nCall the bank about the card.",
  "https://github.com/microsoft/windows-rs",
  "10 Downing Street\nLondon\nSW1A 2AA",
  "git is a version control system.",
  "Go to the shop and make dinner",
  "ok",
  "{}",
  "London -> Paris, 2 hours by train",
  "For example: the first one",
  "Meeting notes:\n  if the budget is approved we start in May\n  return the forms by Friday",
  "Total = 5 apples",
  "I <3 this",
];

test("code is detected", () => {
  for (const s of code) assert.equal(isCode(s), true, s);
});

test("prose, lists, addresses and links are not code", () => {
  for (const s of prose) assert.equal(isCode(s), false, s);
});
