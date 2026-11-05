import { createStore } from "../lib/store";
import { display, type MonitorInfo } from "../platform/services";
import { settings } from "../settings/store";
import { followTarget } from "./follow";

/** The monitor the notch sits on (the chosen one, else the primary, as display.rs picks it; with "follow" or "all" the one it moved to); null until loaded. */
export const monitor = createStore<MonitorInfo | null>(null);
/** Every monitor, read with `monitor`: "all" places a copy on each of the others. */
export const monitors = createStore<MonitorInfo[]>([]);
/** The notch is open, peeking, dragged or recording, so "follow" and "all" leave it where it is (Notch.tsx). */
export const notchBusy = createStore(false);
/** With "follow" or "all": the monitor the notch moved to; null = the chosen one (or the primary) until it moves. */
const moved = createStore<string | null>(null);
/** The monitor Rust last reported for the pointer (mirror.rs). */
let cursor: string | null = null;

/** The monitor the notch should be on. */
function wantedMonitor(): string | null {
  const d = settings.get().display;
  return d.monitorMode === "chosen" ? d.monitor : (moved.get() ?? d.monitor);
}

/** The monitor Rust places the notch on: with "follow" or "all" only one whose size is loaded, so the line and window top sent with it fit it. */
export function placedMonitor(): string | null {
  const d = settings.get().display;
  return d.monitorMode === "chosen" ? d.monitor : (monitor.get()?.name ?? d.monitor);
}

/** Size and work area of that monitor in CSS px; before it loads, the screen with a 48 px taskbar at the bottom. */
export function monitorMetrics(): { width: number; height: number; workTop: number; workHeight: number; workLeft: number; workWidth: number } {
  const m = monitor.get();
  if (m) return { width: m.width, height: m.height, workTop: m.workTop, workHeight: m.workHeight, workLeft: m.workLeft, workWidth: m.workWidth };
  const height = window.screen.height;
  return { width: window.screen.width, height, workTop: 0, workHeight: height - 48, workLeft: 0, workWidth: window.screen.width };
}

let loaded: string | null | undefined;

/** Reads the monitors again; also when a drag starts, since resolution or taskbar may have changed since. */
export function reloadMonitor() {
  const name = (loaded = wantedMonitor());
  void display.monitors().then((all) => {
    // A newer choice is already loading.
    if (wantedMonitor() !== name) return;
    // The notch's monitor first: main.tsx places it as soon as either changes.
    monitor.set(all.find((m) => m.name === name) ?? all.find((m) => m.primary) ?? null);
    monitors.set(all);
    follow();
  });
}

/** Moves the notch to the pointer's monitor when the mode and the notch allow it (follow.ts). */
function follow() {
  const all = monitors.get(), present = all.map((m) => m.name);
  // Where it is headed, not where it is yet, so a move still loading is not asked for again.
  const placed = wantedMonitor() ?? all.find((m) => m.primary)?.name ?? null;
  const target = followTarget(settings.get().display.monitorMode, cursor, placed, notchBusy.get(), present);
  if (target) moved.set(target);
}

/** Loads the monitor at start and whenever the choice, the mode or the monitor the notch moved to changes; follows the pointer with "follow" and "all". */
export function startMonitorWatch() {
  const load = () => {
    // Back on a chosen monitor, a later "follow" starts there again.
    if (settings.get().display.monitorMode === "chosen" && moved.get() !== null) return moved.set(null);
    if (wantedMonitor() !== loaded) reloadMonitor();
    else follow();
  };
  load();
  settings.subscribe(load);
  moved.subscribe(load);
  notchBusy.subscribe(follow);
  display.onCursorMonitor((name) => {
    cursor = name;
    follow();
  });
  void display.cursorMonitor().then((name) => {
    cursor ??= name;
    follow();
  });
  display.onMonitors(reloadMonitor);
}
