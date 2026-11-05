// Which favourite gets which Alt+number shortcut, and how each one stands. Pure.

import type { Favorite } from "./apps.ts";

export const MAX_SHORTCUTS = 6;

export const shortcutLabel = (slot: number) => `Alt+${slot + 1}`;

/** Alt+N rests while a game or other fullscreen app runs, or gaming mode is always on: games use those keys. */
export const hotkeysPaused = (gamingMode: "off" | "fullscreen" | "on", fullscreen: boolean) => fullscreen || gamingMode === "on";

/** The app ids to register, slot = index. Empty when off, so no key is taken from other apps. */
export function shortcutIds(favorites: Favorite[], enabled: boolean): string[] {
  return enabled ? favorites.slice(0, MAX_SHORTCUTS).map((f) => f.id) : [];
}

export interface SlotStatus {
  /** "Alt+1" … or null (off, or beyond the sixth favourite). */
  label: string | null;
  /** Windows refused the key: another app has registered it. */
  taken: boolean;
}

/**
 * Per favourite, in order. `registered` is Rust's answer for the ids last sent (one boolean per slot);
 * it only counts while it was given for exactly these ids, otherwise the keys show as not yet known (not taken).
 */
export function slotStatus(favorites: Favorite[], enabled: boolean, registered: { ids: string[]; ok: boolean[] } | null): SlotStatus[] {
  const ids = shortcutIds(favorites, enabled);
  const current = registered !== null && registered.ids.length === ids.length && registered.ids.every((id, i) => id === ids[i]);
  return favorites.map((_, i) => (i < ids.length ? { label: shortcutLabel(i), taken: current && registered!.ok[i] === false } : { label: null, taken: false }));
}
