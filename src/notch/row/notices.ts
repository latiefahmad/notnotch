// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/TrackNotice.cs (track gate) and MainWindow.xaml.cs (DetectThresholds).
// Rules for the closed notch's notices: when a quota crosses a level, when a new track may show its title, and which notice wins the row. Pure, so the row only has to ask.
import type { UsageProvider } from "../../platform/services";

export const QUOTA = { warning: 70, critical: 90, showMs: 5000 } as const;
export const TRACK = { armMs: 5000, showMs: 4000 } as const;

export function quotaLevel(used: number): 0 | 1 | 2 { return used >= QUOTA.critical ? 2 : used >= QUOTA.warning ? 1 : 0; }

export interface QuotaRise { provider: string; kind: string; used: number; resetsAt: number | null }
export interface QuotaTracker { seeded: boolean; levels: Map<string, number> }
export function newQuotaTracker(): QuotaTracker { return { seeded: false, levels: new Map() }; }

export function detectRise(tracker: QuotaTracker, providers: UsageProvider[]): QuotaRise | null {
  let risen: QuotaRise | null = null;
  for (const p of providers) {
    if (p.error || !p.windows.length) continue;
    for (const w of p.windows) {
      const key = `${p.id}:${w.kind}`, level = quotaLevel(w.usedPercent), prev = tracker.levels.get(key);
      tracker.levels.set(key, level); // always stored, so a rise is only ever reported once per level step
      if (tracker.seeded && prev !== undefined && level > prev && level > 0 && (!risen || w.usedPercent > risen.used)) risen = { provider: p.id, kind: w.kind, used: w.usedPercent, resetsAt: w.resetsAt };
    }
  }
  tracker.seeded = true; // the first pass only records levels, so opening the app at 95% does not alert
  return risen;
}

// A track change shows its title only if playback starts within armMs of being armed (a song started by hand later does not).
export interface TrackGate { until: number | null }
export function armTrack(gate: TrackGate, now: number, live: boolean): void { gate.until = live ? now + TRACK.armMs : null; }
export function observeTrack(gate: TrackGate, playing: boolean, now: number): boolean {
  if (gate.until === null || !playing) return false;
  const until = gate.until;
  gate.until = null;
  return now <= until;
}

/** A saved screenshot or recording shows this long. */
export const SAVED = { showMs: 4000 } as const;

// A running recording outranks everything: its stop button must stay reachable. A capture the user just took comes right after the timer, a finished download after it.
// Transient notices (status, live notice, quota, track) rank above the persistent ones (an event about to start, reminder, water): they would expire unseen, while a reminder comes back after them.
// A question from notnotch-notify ask comes right after the timer: a coding agent waits on it.
// A new version or what it changed waits the longest: it is news, never urgent.
export type NoticeKind = "recording" | "timer" | "ask" | "saved" | "download" | "status" | "notice" | "quota" | "track" | "calendar" | "reminder" | "water" | "whatsnew";
const ORDER: NoticeKind[] = ["recording", "timer", "ask", "saved", "download", "status", "notice", "quota", "track", "calendar", "reminder", "water", "whatsnew"];
export function topNotice(active: Record<NoticeKind, boolean>): NoticeKind | null { return ORDER.find((k) => active[k]) ?? null; }
