import { createStore } from "../../lib/store";
import { closeTimerWindow, onTimerWindow, openTimerWindow } from "../../platform/services";
import { isTimerWindow } from "./store";

/*
 * Detached timer: a small always-on-top window (timer.html) with the running timer.
 * Rust reports open/closed, so the button in the notch stays right when the window
 * closes itself. The window saves its position under POS_KEY on every move.
 */
export const detached = createStore(false);

export const POS_KEY = "notch:timer-window";

if (!isTimerWindow) onTimerWindow((open) => detached.set(open));

/** Saved position (physical px) or null. Read fresh: the other window writes it. */
function savedPos(): { x: number; y: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "null") as { x?: unknown; y?: unknown } | null;
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x as number, y: p.y as number } : null;
  } catch {
    return null;
  }
}

export function toggleDetached() {
  if (detached.get()) void closeTimerWindow();
  else void openTimerWindow(savedPos());
}
