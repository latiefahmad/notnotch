// Reminder times for to-dos. Pure: every function takes `now`, so day boundaries and DST can be tested.

export const SNOOZE_MS = 10 * 60_000;
/** The scheduler never sleeps longer than this: after standby or a clock change it looks again within a minute. */
export const MAX_WAIT_MS = 60_000;

export interface Alertable { done: boolean; alertAt: number | null }

/**
 * Local time `h:m` on the day `dayOffset` days after `now`'s day. Built from calendar fields, never by adding
 * 24 h in milliseconds, so it stays on the wall-clock time across DST changes. A time that does not exist
 * (the hour skipped in spring) moves forward by that hour, as Date does.
 */
export function dueAt(now: number, dayOffset: number, h: number, m: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m, 0, 0).getTime();
}

/** Whole local days from `now`'s day to `at`'s day (0 = today, 1 = tomorrow, -1 = yesterday). */
export function dayDiff(now: number, at: number): number {
  const a = new Date(now), b = new Date(at);
  // Noon on both days: a 23 or 25 hour day still rounds to one.
  const noon = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
  return Math.round((noon(b) - noon(a)) / 86_400_000);
}

/** "9", "930", "9:30", "09.30", "21:05", "9pm", "12am" → hours and minutes; anything else → null. */
export function parseTime(input: string): { h: number; m: number } | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/.exec(s);
  if (!match) return null;
  let h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  const period = match[3];
  if (m > 59) return null;
  if (period) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (period === "pm" ? 12 : 0);
  }
  return h > 23 ? null : { h, m };
}

/** Today if the time is still ahead, otherwise tomorrow (like an alarm clock). */
export function defaultDay(now: number, h: number, m: number): 0 | 1 {
  return dueAt(now, 0, h, m) > now ? 0 : 1;
}

/** Tasks whose reminder is due, the one that has waited longest first. */
export function dueReminders<T extends Alertable>(tasks: T[], now: number): T[] {
  return tasks.filter((t) => !t.done && t.alertAt !== null && t.alertAt <= now).sort((a, b) => a.alertAt! - b.alertAt!);
}

/** The next future reminder, or null when nothing is pending. */
export function nextAlert(tasks: Alertable[], now: number): number | null {
  let next: number | null = null;
  for (const t of tasks) if (!t.done && t.alertAt !== null && t.alertAt > now && (next === null || t.alertAt < next)) next = t.alertAt;
  return next;
}

/** How long the scheduler sleeps before looking again, or null when it can stop. */
export function wait(next: number | null, now: number): number | null {
  return next === null ? null : Math.min(MAX_WAIT_MS, Math.max(0, next - now));
}

export const snoozeAt = (now: number) => now + SNOOZE_MS;
