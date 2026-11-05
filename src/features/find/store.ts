import { createStore } from "../../lib/store";
import { capture, type FoundLine } from "../../platform/services";

export type FindState = { phase: "idle" | "reading" | "ready" | "error"; lines: FoundLine[]; error: string | null };

/** What the screens said, in memory only and only while the Find page is open (FindView clears it). */
export const found = createStore<FindState>({ phase: "idle", lines: [], error: null });

let run = 0;

/** Reads every screen again; an older read that finishes late is ignored. */
export function scanScreens() {
  const id = ++run;
  found.set({ phase: "reading", lines: [], error: null });
  capture
    .findScan()
    .then((lines) => id === run && found.set({ phase: "ready", lines, error: null }))
    .catch((e) => id === run && found.set({ phase: "error", lines: [], error: String(e) }));
}

export function forgetScreens() {
  run++;
  found.set({ phase: "idle", lines: [], error: null });
}
