// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/SystemMonitor.cs (MonitorMetrics.Rate).
// Rates from cumulative counters. A counter that went backwards (an adapter went away, the machine slept) or no time
// passing gives no rate rather than a wrong one.

/** Bytes per second between two readings of a cumulative counter; null when no time passed or it went backwards. */
export function rate(previous: number, current: number, seconds: number): number | null {
  return seconds > 0 && current >= previous ? (current - previous) / seconds : null;
}

export interface NetSample { at: number; net: [number, number] | null }

/** Download and upload in bytes per second between two samples (`at` in ms, `net` = [received, sent] totals). */
export function netRates(prev: NetSample | null, cur: NetSample): { down: number; up: number } | null {
  if (!prev?.net || !cur.net) return null;
  const s = (cur.at - prev.at) / 1000;
  const down = rate(prev.net[0], cur.net[0], s), up = rate(prev.net[1], cur.net[1], s);
  return down === null || up === null ? null : { down, up };
}
