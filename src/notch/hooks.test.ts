import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A store hook after ||, && or ? runs on some renders only and shifts React's hook order: a finished timer once
// skipped two of them in the notch, and the whole interface went blank.
const CONDITIONAL_HOOK = /(\|\||&&|\?\?|\?)\s*!?\(?[\w.]+\.use\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !e.name.includes(".test.") ? [path] : [];
  });
}

test("store hooks are never called inside a conditional expression", () => {
  const offenders = sources(join(import.meta.dirname, "..")).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => (CONDITIONAL_HOOK.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
      .filter((hit): hit is string => hit !== null),
  );
  assert.deepEqual(offenders, []);
});

test("the check catches the pattern that broke the notch", () => {
  assert.ok(CONDITIONAL_HOOK.test(`const urgent = timer.use().finished || dueTasks.use().length > 0;`));
  assert.ok(!CONDITIONAL_HOOK.test(`const tasksDue = dueTasks.use().length > 0;`));
});
