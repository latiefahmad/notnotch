// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/BatteryModel.cs.
// The machine's own battery (all of its batteries together, as Windows' aggregate report gives them).

import type { Level } from "./levels.ts";

export interface BatteryRaw {
  /** Windows.System.Power.BatteryStatus: 0 not present, 1 discharging, 2 idle, 3 charging. */
  status: number;
  /** Positive while charging, negative while discharging. */
  rateMw: number | null;
  remainingMwh: number | null;
  fullMwh: number | null;
  designMwh: number | null;
  ac: boolean | null;
  percent: number | null;
  lifeSecs: number | null;
  saver: boolean;
}

/** plugged: on mains, not charging and below full (a charge limit some laptops keep to spare the cell). */
export type BatteryState = "discharging" | "charging" | "full" | "plugged";

export interface BatterySample {
  percent: number;
  state: BatteryState;
  /** Size of the charge or discharge rate; null when idle or unknown. */
  watts: number | null;
  /** Minutes; only while discharging / charging and when it can be told. */
  left: number | null;
  toFull: number | null;
  /** Full-charge capacity against design capacity, 0..1. */
  health: number | null;
  saver: boolean;
}

/** A rate under this is rounding noise of an idle battery; a time from it would run to days. */
export const RATE_FLOOR_MW = 500;
/** Times past 48 h are not worth saying. */
export const LONGEST_MIN = 48 * 60;
/** At or above this on mains the battery is full (laptops stop charging a little short of 100). */
export const FULL_PERCENT = 97;
/** Low (critical) at or under this, elevated within ten points above. */
export const LOW_PERCENT = 15;

const cap = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 0 && v < 1e9;
const bounded = (min: number) => (min > 0 && min <= LONGEST_MIN ? min : null);

export function buildBattery(raw: BatteryRaw | null): BatterySample | null {
  if (!raw || (raw.status === 0 && raw.percent === null)) return null;
  const percent = cap(raw.remainingMwh) && cap(raw.fullMwh) && raw.fullMwh > 0 ? (raw.remainingMwh / raw.fullMwh) * 100 : raw.percent;
  if (percent === null || !Number.isFinite(percent)) return null;
  const share = Math.min(100, Math.max(0, percent));
  const rate = raw.rateMw !== null && Number.isFinite(raw.rateMw) ? raw.rateMw : null;
  const moving = rate !== null && Math.abs(rate) >= RATE_FLOOR_MW;

  // The battery's own status first, then the sign of the rate, then mains alone.
  let state: BatteryState;
  if (raw.status === 3 || (raw.status !== 1 && moving && rate! > 0)) state = "charging";
  else if (raw.status === 1 || (moving && rate! < 0) || raw.ac === false) state = "discharging";
  else state = share >= FULL_PERCENT ? "full" : "plugged";
  // Mains that says it is there outweighs a battery claiming to discharge by a hair: it is held at its threshold.
  if (state === "discharging" && raw.ac === true && !moving) state = share >= FULL_PERCENT ? "full" : "plugged";

  let left: number | null = null, toFull: number | null = null;
  if (state === "discharging") {
    if (raw.lifeSecs !== null && raw.lifeSecs > 0) left = bounded(raw.lifeSecs / 60);
    else if (cap(raw.remainingMwh) && moving && rate! < 0) left = bounded((raw.remainingMwh / -rate!) * 60);
  } else if (state === "charging" && cap(raw.remainingMwh) && cap(raw.fullMwh) && moving && rate! > 0) {
    toFull = bounded((Math.max(0, raw.fullMwh - raw.remainingMwh) / rate!) * 60);
  }
  const health = cap(raw.fullMwh) && cap(raw.designMwh) && raw.designMwh > 0 ? Math.min(1, raw.fullMwh / raw.designMwh) : null;
  return { percent: share, state, watts: moving ? Math.abs(rate!) / 1000 : null, left, toFull, health, saver: raw.saver };
}

/** What the battery supplies to the whole machine: only while discharging (on mains it covers just a shortfall). */
export const discharge = (b: BatterySample | null, ac: boolean | null) => (b?.state === "discharging" && b.watts !== null && ac !== true ? b.watts : null);

/** Low only while discharging; a battery on mains is never low. */
export function batteryLevel(b: BatterySample | null): Level {
  if (!b || b.state !== "discharging") return 0;
  const p = Math.round(b.percent);
  return p <= LOW_PERCENT ? 2 : p <= LOW_PERCENT + 10 ? 1 : 0;
}

/** A worn battery: under 80 % of its design capacity is elevated, under 60 % critical. */
export const healthLevel = (health: number | null): Level => (health === null ? 0 : health < 0.6 ? 2 : health < 0.8 ? 1 : 0);
