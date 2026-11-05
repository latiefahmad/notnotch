import { createStore } from "../../lib/store";
import { isMac } from "../../platform/native";
import { windowShell, type HotkeyState, type ScreenBehavior } from "../../platform/services";
import { settings, updateSettings, type Settings } from "../../settings/store";
import { conflicts, label, launcherKeys, normalize, type HotkeyKind } from "./hotkeys";
import type { WindowSettings } from "./model";

/** What the window rules call for right now (display.rs): the line is drawn here, hiding happens in Rust. */
export const screen = createStore<ScreenBehavior>("normal");

/** The closed look after the rules: a "line" rule turns any style into the idle line. */
export function effectiveIdleStyle(idle: Settings["display"]["idleStyle"], behavior = screen.get()): Settings["display"]["idleStyle"] {
  return behavior === "line" ? "line" : idle;
}

/** Each shortcut's state for the settings; "duplicate" = an earlier NotNotch shortcut has the combination. */
export const hotkeyStatus = createStore<Record<HotkeyKind, HotkeyState | "duplicate">>({ open: "active", hide: "unset", resize: "unset", find: "unset" });

export function updateBehavior(patch: Partial<WindowSettings> | ((b: WindowSettings) => Partial<WindowSettings>)) {
  updateSettings((s) => ({ behavior: { ...s.behavior, ...(typeof patch === "function" ? patch(s.behavior) : patch) } }));
}

let lastHotkeys = "";
let applying: Promise<unknown> = Promise.resolve();
/** While a shortcut is being recorded, none is registered: Windows would take the keys before the page sees them. */
let paused = false;

export function pauseHotkeys(on: boolean) {
  if (paused === on) return;
  paused = on;
  applyHotkeys();
}

/** The launcher's Alt+N keys while they are switched on and the tool is on (src/features/launcher/store.ts); a NotNotch shortcut on one of them yields. */
export function takenByLauncher(s: Settings = settings.get()): string[] {
  const on = s.launcher.hotkeys && s.tools.some((x) => x.id === "launcher" && x.enabled);
  return launcherKeys(on ? (s.launcher.favorites?.length ?? 0) : 0);
}

/** Registers the saved shortcuts in Rust; a duplicate is not sent, so it can't take the other one's place. */
function applyHotkeys() {
  const h = settings.get().behavior.hotkeys, launcher = takenByLauncher();
  const key = `${paused}|${h.open}|${h.hide}|${h.resize}|${h.find}|${launcher.join()}`;
  if (key === lastHotkeys) return;
  lastHotkeys = key;
  const clash = conflicts(h, launcher);
  const send = (k: HotkeyKind) => (paused || clash[k] ? "" : normalize(k, h[k]));
  // Find on screen reads the screens with Windows' OCR: no Mac version yet.
  const config = { open: send("open"), hide: send("hide"), resize: send("resize"), find: isMac ? "" : send("find"), openLabel: label(h.open) };
  const wasPaused = paused;
  // One registration at a time: Rust swaps the whole set.
  applying = applying
    .then(() => windowShell.applyHotkeys(config))
    .then((r) => {
      if (wasPaused) return;
      const status = (k: HotkeyKind) => (clash[k] ? "duplicate" : r[k]);
      hotkeyStatus.set({ open: status("open"), hide: status("hide"), resize: status("resize"), find: status("find") });
    })
    .catch(() => {});
}

/** Uncaught errors in the page go to crash.log (shell.rs); a few per session, so a loop can't flood it. */
function startCrashLog() {
  let left = 20;
  const log = (text: string) => left-- > 0 && windowShell.crashLog(text);
  window.addEventListener("error", (e) => {
    // Chromium reports a harmless ResizeObserver note as an error; the springs trigger it routinely.
    if (e.message?.startsWith("ResizeObserver loop")) return;
    log(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`);
  });
  // Only the first line: a rejected value can carry a whole response body.
  window.addEventListener("unhandledrejection", (e) => log(`unhandled rejection: ${String(e.reason).split("\n")[0]}`));
}

export function startWindowBehavior() {
  startCrashLog();
  void windowShell.screen().then((b) => screen.set(b));
  windowShell.onScreen((b) => screen.set(b));
  applyHotkeys();
  settings.subscribe(applyHotkeys);
}
