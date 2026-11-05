// Partly translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/SystemMonitor.cs
// (ReadingLevels, MemorySample.Level). How loaded a reading is, and the colour each scheme gives that level.

/** 0 normal, 1 elevated, 2 critical. */
export type Level = 0 | 1 | 2;

/** A share in percent: elevated from 70, critical from 90 (NotNotch's thresholds since 0.1). */
export const ofShare = (percent: number): Level => (percent >= 90 ? 2 : percent >= 70 ? 1 : 0);

/**
 * A rate in bytes per second against fixed rates (10 and 50 MB/s). A share of the link speed would hardly ever rise:
 * Windows reports the nominal speed of the link (1 Gb/s on a line that delivers far less).
 */
export const ofRate = (bytesPerSecond: number): Level => (bytesPerSecond >= 50e6 ? 2 : bytesPerSecond >= 10e6 ? 1 : 0);

/**
 * Windows reports no memory pressure level as macOS does; it is read from the share of physical memory in use and the
 * commit charge (memory promised to processes) against its limit (physical memory plus page file).
 */
export function memoryLevel(used: number, total: number, commit: number, limit: number): Level {
  const u = total > 0 ? (used / total) * 100 : 0, c = limit > 0 ? commit / limit : 0;
  return u >= 90 || c >= 0.9 ? 2 : u >= 70 || c >= 0.8 ? 1 : 0;
}

export type ColorScheme = "calm" | "traffic" | "accent";
export const COLOR_SCHEMES: ColorScheme[] = ["calm", "traffic", "accent"];

const COLORS: Record<ColorScheme, [string, string, string]> = {
  // Monochrome until it gets high, as before: the eye only goes where something is wrong.
  calm: ["var(--color-label)", "var(--color-orange)", "var(--color-red)"],
  traffic: ["var(--color-green)", "var(--color-yellow)", "var(--color-red)"],
  accent: ["var(--color-accent)", "var(--color-orange)", "var(--color-red)"],
};

export const schemeColor = (scheme: ColorScheme, level: Level) => (COLORS[scheme] ?? COLORS.calm)[level];

interface Adapter { key: string; name: string; memTotal: number; usage: number | null }
/** A saved choice: the adapter's name and which of the adapters with that name (two identical cards); name "" = automatic. */
export interface GpuChoice { name: string; index: number }

/** Automatic mode moves to another adapter only when it is busier by this many points, so it does not flip between two. */
export const AUTO_MARGIN = 10;

/**
 * The adapter to show: the chosen one (name and index among same-named adapters), else automatic: the busiest, staying
 * on `previous` (its key) unless another is clearly busier; with no load known, the one with most dedicated memory.
 */
export function pickGpu<T extends Adapter>(gpus: T[], choice: GpuChoice, previous: string | null = null): T | null {
  if (choice.name) {
    const same = gpus.filter((g) => g.name === choice.name);
    const hit = same[Math.min(Math.max(0, choice.index), same.length - 1)];
    if (hit) return hit;
  }
  const strongest = gpus.reduce<T | null>((best, g) => (!best || g.memTotal > best.memTotal ? g : best), null);
  const busiest = gpus.reduce<T | null>((best, g) => ((g.usage ?? 0) > (best?.usage ?? 0) ? g : best), null);
  const kept = gpus.find((g) => g.key === previous);
  if (kept && (!busiest || (busiest.usage ?? 0) <= (kept.usage ?? 0) + AUTO_MARGIN)) return kept;
  return busiest ?? kept ?? strongest;
}

/** Click on the GPU row: the next adapter after the one shown, round, saved with its index among same-named adapters. */
export function nextGpu<T extends Adapter>(gpus: T[], shown: T | null): GpuChoice | null {
  if (!shown || gpus.length < 2) return null;
  const next = gpus[(gpus.findIndex((g) => g.key === shown.key) + 1) % gpus.length];
  return { name: next.name, index: gpus.filter((g) => g.name === next.name).indexOf(next) };
}
