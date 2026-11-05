/*
 * Which shell the terminal starts, with which command line and in which folder.
 * Pure: the paths come from Rust (terminal_info), which also decides the binary.
 */

export type ShellId = "pwsh" | "powershell" | "cmd";

/** Shell paths found on this PC; `pwsh` is null when PowerShell 7 is not installed. */
export interface ShellInfo {
  pwsh: string | null;
  powershell: string;
  cmd: string;
  home: string;
  /** Windows build number, 0 when unknown. */
  buildNumber: number;
}

export interface TerminalPrefs {
  shell: ShellId;
  /** Empty = the user's home; `~` stands for the home too. */
  startDir: string;
}

export interface LaunchPlan {
  shell: ShellId;
  commandLine: string;
  cwd: string;
}

/** PowerShell 7 falls back to Windows PowerShell when it is not installed. */
export function resolveShell(choice: ShellId, info: ShellInfo): { shell: ShellId; exe: string } {
  if (choice === "pwsh" && info.pwsh) return { shell: "pwsh", exe: info.pwsh };
  if (choice === "cmd") return { shell: "cmd", exe: info.cmd };
  return { shell: "powershell", exe: info.powershell };
}

/** No banner: the notch has little room. */
export function shellArgs(shell: ShellId): string[] {
  return shell === "cmd" ? [] : ["-NoLogo"];
}

/**
 * Windows command line. shortcut: only quotes parts with spaces; paths cannot contain `"`
 * and the args are fixed, so no escaping is needed. Upgrade if user args are ever allowed.
 */
export function commandLine(exe: string, args: string[]): string {
  return [exe, ...args].map((a) => (/\s/.test(a) || a === "" ? `"${a}"` : a)).join(" ");
}

/** Start folder: home when empty, `~` expanded, surrounding quotes (pasted from Explorer) removed. */
export function startDirectory(setting: string, home: string): string {
  const dir = setting.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!dir || dir === "~") return home;
  if (/^~[\\/]/.test(dir)) return home.replace(/[\\/]+$/, "") + "\\" + dir.slice(2);
  return dir;
}

export function launchPlan(prefs: TerminalPrefs, info: ShellInfo): LaunchPlan {
  const { shell, exe } = resolveShell(prefs.shell, info);
  return { shell, commandLine: commandLine(exe, shellArgs(shell)), cwd: startDirectory(prefs.startDir, info.home) };
}
