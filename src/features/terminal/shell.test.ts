import { test } from "node:test";
import assert from "node:assert/strict";
import { commandLine, launchPlan, resolveShell, shellArgs, startDirectory, type ShellInfo } from "./shell.ts";

const info: ShellInfo = {
  pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  cmd: "C:\\Windows\\System32\\cmd.exe",
  home: "C:\\Users\\andre",
  buildNumber: 26300,
};

test("pwsh when installed, Windows PowerShell otherwise", () => {
  assert.deepEqual(resolveShell("pwsh", info), { shell: "pwsh", exe: info.pwsh });
  assert.deepEqual(resolveShell("pwsh", { ...info, pwsh: null }), { shell: "powershell", exe: info.powershell });
  assert.deepEqual(resolveShell("powershell", info), { shell: "powershell", exe: info.powershell });
  assert.deepEqual(resolveShell("cmd", { ...info, pwsh: null }), { shell: "cmd", exe: info.cmd });
});

test("PowerShell starts without banner, cmd without args", () => {
  assert.deepEqual(shellArgs("pwsh"), ["-NoLogo"]);
  assert.deepEqual(shellArgs("powershell"), ["-NoLogo"]);
  assert.deepEqual(shellArgs("cmd"), []);
});

test("command line quotes paths with spaces only", () => {
  assert.equal(commandLine(info.pwsh!, ["-NoLogo"]), '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo');
  assert.equal(commandLine(info.cmd, []), "C:\\Windows\\System32\\cmd.exe");
});

test("start directory: home, tilde, quotes, custom", () => {
  assert.equal(startDirectory("", info.home), info.home);
  assert.equal(startDirectory("   ", info.home), info.home);
  assert.equal(startDirectory("~", info.home), info.home);
  assert.equal(startDirectory("~\\Documents\\GitHub", info.home), "C:\\Users\\andre\\Documents\\GitHub");
  assert.equal(startDirectory("~/code", "C:\\Users\\andre\\"), "C:\\Users\\andre\\code");
  assert.equal(startDirectory('"D:\\Work Projects"', info.home), "D:\\Work Projects");
  assert.equal(startDirectory("D:\\src", info.home), "D:\\src");
});

test("launch plan puts it together", () => {
  assert.deepEqual(launchPlan({ shell: "pwsh", startDir: "" }, { ...info, pwsh: null }), {
    shell: "powershell",
    commandLine: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo",
    cwd: info.home,
  });
});
