// Water reminder rules: today's total, the hourly chart and when the next reminder is due. Pure, every function takes `now`.

/** `prev` is the reminder base before this drink, so undoing it puts the next reminder back where it was. */
export interface Drink { at: number; ml: number; prev?: number | null }
export interface WaterConfig {
  /** Reminders on or off; logging works either way. */
  remind: boolean;
  bottleMl: number;
  goalMl: number;
  /** Reminder hours as minutes after local midnight; `from > to` runs past midnight. */
  from: number;
  to: number;
  everyMin: number;
}

export const WATER_DEFAULTS: WaterConfig = { remind: false, bottleMl: 500, goalMl: 2000, from: 9 * 60, to: 21 * 60, everyMin: 60 };
export const LIMITS = { bottle: [100, 2000], goal: [500, 6000], every: [15, 240] } as const;
/** Days of log kept. */
export const KEEP_DAYS = 7;

const clampInt = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : fallback;
const minutes = (v: unknown, fallback: number) => clampInt(v, [0, 24 * 60 - 1], fallback);

/** A saved config (or nothing) → a valid one. */
export function normalizeWater(saved: unknown): WaterConfig {
  const s = (typeof saved === "object" && saved !== null ? saved : {}) as Record<string, unknown>, d = WATER_DEFAULTS;
  return {
    remind: typeof s.remind === "boolean" ? s.remind : d.remind,
    bottleMl: clampInt(s.bottleMl, LIMITS.bottle, d.bottleMl),
    goalMl: clampInt(s.goalMl, LIMITS.goal, d.goalMl),
    from: minutes(s.from, d.from),
    to: minutes(s.to, d.to),
    everyMin: clampInt(s.everyMin, LIMITS.every, d.everyMin),
  };
}

/** Local midnight of `t`'s day, plus `days` days (calendar arithmetic, DST safe). */
export function dayStart(t: number, days = 0): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** Local time `min` minutes into the day `days` after `t`'s day, as wall-clock time. */
function wallClock(t: number, days: number, min: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, Math.floor(min / 60), min % 60).getTime();
}

export function todayTotal(log: Drink[], now: number): number {
  const from = dayStart(now), to = dayStart(now, 1);
  return log.reduce((sum, d) => (d.at >= from && d.at < to ? sum + d.ml : sum), 0);
}

/** 0..1 of the goal (capped). */
export const progress = (total: number, goal: number) => (goal > 0 ? Math.min(1, total / goal) : 0);

/** Log entries older than KEEP_DAYS calendar days dropped. */
export const prune = (log: Drink[], now: number) => log.filter((d) => d.at >= dayStart(now, -(KEEP_DAYS - 1)));

/**
 * Millilitres per local hour of `now`'s day, for the hours `fromHour..toHour` inclusive (the reminder window;
 * a window past midnight or a drink outside it widens the range to the whole day).
 */
export function hourly(log: Drink[], now: number, cfg: Pick<WaterConfig, "from" | "to">): { hour: number; ml: number }[] {
  const start = dayStart(now), end = dayStart(now, 1);
  const byHour = new Map<number, number>();
  for (const d of log) if (d.at >= start && d.at < end) byHour.set(new Date(d.at).getHours(), (byHour.get(new Date(d.at).getHours()) ?? 0) + d.ml);
  let lo = Math.floor(cfg.from / 60), hi = Math.floor(cfg.to / 60);
  if (cfg.from > cfg.to) [lo, hi] = [0, 23];
  for (const h of byHour.keys()) [lo, hi] = [Math.min(lo, h), Math.max(hi, h)];
  return Array.from({ length: hi - lo + 1 }, (_, i) => ({ hour: lo + i, ml: byHour.get(lo + i) ?? 0 }));
}

/** The reminder windows around `t`: yesterday's (it may run past midnight), today's and tomorrow's, as [start, end]. */
function windows(t: number, cfg: WaterConfig): [number, number][] {
  const span = cfg.from > cfg.to ? 1 : 0;
  return [-1, 0, 1, 2].map((d) => [wallClock(t, d, cfg.from), wallClock(t, d + span, cfg.to)]);
}

/**
 * When the next reminder is due: `everyMin` after the last drink or dismissed reminder, counted from the start of
 * the window if that was earlier, never outside the window. The result may be in the past (overdue → show now).
 * A window belongs to the day it starts on: once that day's goal is reached the whole window is done, including
 * a tail past midnight, where today's total has already started again at zero. null when reminders are off.
 */
export function nextWaterAlert(now: number, last: number | null, cfg: WaterConfig, log: Drink[]): number | null {
  if (!cfg.remind) return null;
  const every = cfg.everyMin * 60_000;
  for (const [start, end] of windows(now, cfg)) {
    if (end <= now || todayTotal(log, start) >= cfg.goalMl) continue;
    const next = Math.max(last ?? -Infinity, start) + every;
    if (next <= end) return next;
  }
  return null;
}

/** Takes back today's last drink and puts the reminder base back to what it was before it. Older days stay. */
export function undoLast(log: Drink[], lastAt: number | null, now: number): { log: Drink[]; lastAt: number | null } {
  const last = log[log.length - 1];
  if (!last || last.at < dayStart(now) || last.at >= dayStart(now, 1)) return { log, lastAt };
  return { log: log.slice(0, -1), lastAt: last.prev !== undefined ? last.prev : lastAt };
}

/** "09:00" ⇄ minutes after midnight. */
export const formatMinutes = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
