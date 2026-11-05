import { createStore } from "../lib/store";

/**
 * Which tool is open? Global so tools can link to each other
 * (e.g. Portfolio without a key → "Connect in settings").
 * `section` scrolls the settings to a section.
 */
export const nav = createStore<{ tabId: string; section: string | null }>({ tabId: "media", section: null });

export function navigate(tabId: string, section: string | null = null) {
  nav.set({ tabId, section });
}

/*
 * A click on a closed-notch notice names the tool the notch should open on. It wins over the live activity
 * (a running timer, a call), like the tray entry, but only for the open that follows right away.
 */
let openTarget: { tabId: string; at: number } | null = null;

export function openOn(tabId: string) {
  openTarget = { tabId, at: Date.now() };
  navigate(tabId);
}

/** The tool asked for by `openOn` within the last second, once. */
export function takeOpenTarget(): string | null {
  const t = openTarget;
  openTarget = null;
  return t && Date.now() - t.at < 1000 ? t.tabId : null;
}
