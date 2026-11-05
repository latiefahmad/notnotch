import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, hostname, userInfo } from "node:os";
import { diagnosticsText, errorCode, type Diagnostics } from "./diagnostics.ts";

const base: Diagnostics = {
  version: "1.0.0",
  build: "portable",
  os: "Windows 11 Home",
  osBuild: "26100",
  arch: "x86_64",
  machine: "aarch64",
  scales: [1.5, 1],
  panelScale: 100,
  tools: ["overview", "now-playing", "timer"],
  closedStyle: "notch",
  edge: "top",
  anchor: "auto",
  errors: [
    ["update", "check-failed"],
    ["github", "token-rejected"],
    ["fps", null],
  ],
};

test("diagnostics list the build, Windows, monitors and settings", () => {
  const text = diagnosticsText(base);
  assert.match(text, /^NotNotch diagnostics\n/);
  assert.match(text, /App: 1\.0\.0 \(portable, x86_64\)/);
  assert.match(text, /Windows: Windows 11 Home, build 26100, PC aarch64/);
  assert.match(text, /Monitors: 2 \(150 %, 100 %\)/);
  assert.match(text, /Tools: overview, now-playing, timer/);
  assert.match(text, /Closed: notch, edge top \(auto\)/);
  assert.match(text, /Errors: update check-failed; github token-rejected\n$/);
  assert.match(diagnosticsText({ ...base, errors: [], scales: [], tools: [], os: null }), /Errors: none/);
});

test("diagnostics never carry the user name, the PC name or a path", () => {
  const user = userInfo().username;
  const home = homedir();
  const pc = hostname();
  // Errors that would leak if they were copied as they are: a message with the profile path, the user name, a share.
  const text = diagnosticsText({
    ...base,
    errors: [
      ["discord", `Could not open ${home}\\AppData\\Roaming\\discord`],
      ["github", user.toLowerCase()],
      ["fps", `\\\\${pc}\\share`],
      ["update", "C:\\Users\\Someone\\file.txt"],
    ],
  });
  for (const secret of [user, home, pc, "Someone", "\\Users\\", "AppData"]) assert.ok(!text.includes(secret), `${secret} leaked:\n${text}`);
  assert.match(text, /Errors: discord other; github other; fps other; update other\n$/);
  assert.doesNotMatch(text, /[A-Za-z]:\\/);
});

test("only code-like errors are kept", () => {
  assert.equal(errorCode("rate-limited"), "rate-limited");
  assert.equal(errorCode("andrea"), "other");
  assert.equal(errorCode("Token abgelehnt"), "other");
  assert.equal(errorCode("no such file: C:\\x"), "other");
  assert.equal(errorCode(""), null);
  assert.equal(errorCode(null), null);
});
