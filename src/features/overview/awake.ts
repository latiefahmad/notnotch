// Keep awake: how long it lasts and how much is left. Pure, so it can be tested without the app around it.

/** The timed choices in minutes; null is "until turned off". */
export const AWAKE_MINUTES = [30, 60, 120] as const;

/** null = off. `endsAt` (Date.now()) is null while it lasts until turned off. */
export type Awake = { minutes: number | null; endsAt: number | null } | null;

export const awakeStart = (minutes: number | null, now: number): Awake => ({ minutes, endsAt: minutes === null ? null : now + minutes * 60_000 });

/** Milliseconds left, or null when off or until turned off. */
export const awakeLeft = (a: Awake, now: number): number | null => (a?.endsAt == null ? null : Math.max(0, a.endsAt - now));

/** A timed keep awake whose time is up counts as off. */
export const awakeOn = (a: Awake, now: number): boolean => !!a && (a.endsAt === null || a.endsAt > now);

/** "1:05:00", "29:59"; seconds round up, so it never shows 0:00 while still on. */
export function formatLeft(ms: number): string {
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
