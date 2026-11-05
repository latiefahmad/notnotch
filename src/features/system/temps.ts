// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/Temperatures.cs.
// Temperatures as Windows reports them without a driver or administrator rights: the CPU from the ACPI thermal zones
// (defined by the firmware, possibly the board's rather than the processor's), the GPU as Task Manager reads it, SSDs
// as they report themselves. A value no working sensor gives is no reading: the tool hides it rather than show a zero.

import type { Level } from "./levels.ts";

/** Outside this range (°C) a reading is a missing or broken sensor: zones report 0 K without data, some drives 0 or -273 °C. */
export const LOWEST = 1, HIGHEST = 125;
/** A laptop CPU runs in the high eighties under load and throttles near 100; GPUs aim for the low eighties; SSDs stay well under 70. */
export const LIMITS = { cpu: [85, 95], gpu: [80, 90], disk: [60, 70] } as const;

export const plausible = (c: number | null | undefined): number | null => (c != null && Number.isFinite(c) && c >= LOWEST && c <= HIGHEST ? c : null);
export const fromKelvin = (k: number) => plausible(k - 273.15);

export function level(celsius: number, warning: number, critical: number): Level {
  return celsius >= critical ? 2 : celsius >= warning ? 1 : 0;
}
export const tempLevel = (kind: "cpu" | "gpu", c: number) => level(c, LIMITS[kind][0], LIMITS[kind][1]);

/** A drive by its own thresholds where it gives plausible ones in order; one alone sets the other 5 or 10 degrees apart. */
export function diskLevel(c: number, warning: number | null, critical: number | null): Level {
  let w = plausible(warning), k = plausible(critical);
  if (w !== null && k !== null && k < w) w = k = null;
  return level(c, w ?? (k !== null ? k - 5 : LIMITS.disk[0]), k ?? (w !== null ? w + 10 : LIMITS.disk[1]));
}

/** A zone named for the processor wins; otherwise the hottest, as the CPU is usually what heats a zone most. */
export function pickZone(zones: Map<string, number>): { celsius: number; zone: string } | null {
  const cpu = (z: string) => /CPU|PROC/i.test(z);
  let best: { celsius: number; zone: string } | null = null;
  for (const [zone, celsius] of zones) {
    if (!best) best = { celsius, zone };
    else if (cpu(zone) !== cpu(best.zone) ? cpu(zone) : celsius !== best.celsius ? celsius > best.celsius : zone < best.zone) best = { celsius, zone };
  }
  return best;
}

/**
 * The frozen-sensor guard. Many desktop boards report a zone that never moves (27.8 °C, 300 K): a value the firmware
 * fills in, not a sensor. A zone counts only once its value has changed since it was first read, so a fixed one never
 * shows; one that then stays the same for `STEADY_S` seconds is left out again until it changes.
 */
export class SteadyZones {
  static readonly STEADY_S = 600;
  private zones = new Map<string, { value: number; since: number; moved: boolean }>();

  /** The CPU temperature from raw zones (zone, kelvin) at `now` seconds. */
  choose(raw: [string, number][], now: number): { celsius: number; zone: string } | null {
    const current = new Map<string, number>();
    for (const [zone, k] of raw) {
      const c = fromKelvin(k);
      if (c !== null) current.set(zone, c);
    }
    for (const zone of [...this.zones.keys()]) if (!current.has(zone)) this.zones.delete(zone);
    const moving = new Map<string, number>();
    for (const [zone, c] of current) {
      let known = this.zones.get(zone);
      if (!known) this.zones.set(zone, (known = { value: c, since: now, moved: false }));
      else if (known.value !== c) this.zones.set(zone, (known = { value: c, since: now, moved: true }));
      if (known.moved && now - known.since < SteadyZones.STEADY_S) moving.set(zone, c);
    }
    return pickZone(moving);
  }
}

/** "62°" for the closed row, "62 °C" for the tool. */
export const degrees = (c: number) => String(Math.round(c));
