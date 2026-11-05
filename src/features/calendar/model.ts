// Calendar rules: the saved settings repaired, the agenda by day, the next event and the notice before it. Pure, every function takes `now`.

export interface CalendarEventLike {
  id: string;
  start: number;
  end: number;
  allDay: boolean;
}

/** An ICS link (the link itself is the secret `calendar.<id>`, `host` only labels it) or a CalDAV account (password in the secret). */
export interface CalendarSource {
  id: string;
  kind: "ics" | "caldav";
  name: string;
  /** `#rrggbb`: the ICS calendar's colour, and the fallback for CalDAV calendars without one. */
  color: string;
  /** CalDAV: server or calendar URL. */
  url: string;
  /** CalDAV: user name. */
  user: string;
  /** ICS: the link's host, shown in the settings. */
  host: string;
}

export interface CalendarSettings {
  sources: CalendarSource[];
  /** A notice in the closed notch before the next event. */
  notice: boolean;
  noticeMin: 5 | 10;
  /** The "Next event" part shows an event starting within this many minutes. */
  horizonMin: number;
}

export const HORIZONS = [30, 60, 120, 240, 480] as const;
export const PALETTE = ["#419cff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#ffd60a", "#64d2ff", "#ff375f"] as const;
export const CALENDAR_DEFAULTS: CalendarSettings = { sources: [], notice: true, noticeMin: 10, horizonMin: 60 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Valid sources kept (ids as Rust accepts them, no duplicates), the rest from the defaults. */
export function normalizeCalendar(saved: unknown): CalendarSettings {
  const s = isObj(saved) ? saved : {};
  const seen = new Set<string>();
  const sources = (Array.isArray(s.sources) ? s.sources : []).flatMap((x): CalendarSource[] => {
    if (!isObj(x) || (x.kind !== "ics" && x.kind !== "caldav")) return [];
    const id = str(x.id);
    if (!/^[a-z0-9]{1,24}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    const color = /^#[0-9a-f]{6}$/i.test(str(x.color)) ? str(x.color) : PALETTE[seen.size % PALETTE.length];
    return [{ id, kind: x.kind, name: str(x.name), color, url: str(x.url), user: str(x.user), host: str(x.host) }];
  });
  return {
    sources,
    notice: typeof s.notice === "boolean" ? s.notice : CALENDAR_DEFAULTS.notice,
    noticeMin: s.noticeMin === 5 ? 5 : 10,
    horizonMin: HORIZONS.includes(s.horizonMin as (typeof HORIZONS)[number]) ? (s.horizonMin as number) : CALENDAR_DEFAULTS.horizonMin,
  };
}

/** A fresh source id: lowercase letters and digits, not one in use. */
export function newSourceId(taken: string[], random: () => number = Math.random): string {
  for (;;) {
    const id = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
    if (!taken.includes(id)) return id;
  }
}

/** The first colour of the palette no source uses yet. */
export function nextColor(sources: { color: string }[]): string {
  return PALETTE.find((c) => !sources.some((s) => s.color.toLowerCase() === c)) ?? PALETTE[sources.length % PALETTE.length];
}

/** The host of an ICS link (webcal included), for its label; "" when it is not a link. */
export function linkHost(link: string): string {
  try {
    return new URL(link.trim().replace(/^webcals?:\/\//i, "https://")).host;
  } catch {
    return "";
  }
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight `n` days after `day` (a local midnight), DST-safe. */
export function addDays(day: number, n: number): number {
  const d = new Date(day);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * Today and the next `days - 1` days, each with the events that touch it: all-day ones first, then by start.
 * Past events of today stay (dimmed by the view); a multi-day event shows on each of its days.
 */
export function agenda<T extends CalendarEventLike>(events: T[], now: number, days: number): { day: number; events: T[] }[] {
  const today = startOfDay(now);
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(today, i);
    const list = eventsOn(events, day)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.end - b.end);
    return { day, events: list };
  });
}

/** The events that touch the day starting at local midnight `day` (a zero-length event counts on its own day). */
export function eventsOn<T extends CalendarEventLike>(events: T[], day: number): T[] {
  const next = addDays(day, 1);
  return events.filter((e) => e.start < next && (e.end > day || (e.end === e.start && e.start >= day)));
}

/**
 * The month around `month` (any time in it) as 6 weeks of 7 days, starting on `firstWeekday` (0 Sunday, 1 Monday ...).
 * Each day lists the calendars with events on it, in order of first appearance, for the dots under the number.
 */
export function monthGrid<T extends CalendarEventLike & { calendar: string }>(
  events: T[],
  month: number,
  firstWeekday: number,
): { day: number; inMonth: boolean; calendars: string[] }[] {
  const first = new Date(month);
  first.setDate(1);
  first.setHours(0, 0, 0, 0);
  const start = addDays(first.getTime(), -((first.getDay() - firstWeekday + 7) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const day = addDays(start, i);
    const calendars = [...new Set(eventsOn(events, day).map((e) => e.calendar))];
    return { day, inMonth: new Date(day).getMonth() === first.getMonth(), calendars };
  });
}

/** The next timed event that has not started yet (all-day events have no time to wait for). */
export function nextEvent<T extends CalendarEventLike>(events: T[], now: number): T | null {
  let best: T | null = null;
  for (const e of events) if (!e.allDay && e.start > now && (!best || e.start < best.start)) best = e;
  return best;
}

/** The event to announce: starting within `minutes`, not dismissed; the soonest first. */
export function dueEvent<T extends CalendarEventLike>(events: T[], now: number, minutes: number, dismissed: ReadonlySet<string>): T | null {
  let best: T | null = null;
  for (const e of events) {
    if (e.allDay || dismissed.has(e.id) || e.start <= now || e.start - minutes * 60_000 > now) continue;
    if (!best || e.start < best.start) best = e;
  }
  return best;
}

/** The next moment the notice or the part may change: an event's start, or `leads` (ms) before it. null when nothing is ahead. */
export function nextChange(events: CalendarEventLike[], now: number, leads: number[]): number | null {
  let next: number | null = null;
  for (const e of events) {
    if (e.allDay) continue;
    for (const lead of [0, ...leads]) {
      const at = e.start - lead;
      if (at > now && (next === null || at < next)) next = at;
    }
  }
  return next;
}

/** Hosts of the meeting services the Join button opens; anything else (and every lookalike) is no meeting. */
function isMeeting(u: URL): boolean {
  const h = u.hostname;
  if (h === "meet.google.com" || h === "teams.microsoft.com" || h === "teams.live.com") return true;
  if (h.endsWith(".zoom.us") || h.endsWith(".webex.com")) return true;
  // The bare domain also serves sign-in and marketing pages: only its meeting paths.
  return h === "zoom.us" && /^\/(j|my)\//.test(u.pathname);
}

/**
 * The first https link to a Google Meet, Zoom, Teams or Webex meeting in the event's URL, location or description, or null.
 * Angle brackets and quotes end a link (Outlook writes "Join<https://...>"); trailing punctuation is not part of it.
 */
export function meetingLink(e: { url?: string; location?: string; description?: string }): string | null {
  for (const text of [e.url, e.location, e.description]) {
    for (const [raw] of (text ?? "").matchAll(/https:\/\/[^\s<>"']+/gi)) {
      try {
        const u = new URL(raw.replace(/[.,;:!?)\]}*]+$/, ""));
        if (!u.username && !u.password && isMeeting(u)) return u.href;
      } catch {
        // Not a URL after all: try the next one.
      }
    }
  }
  return null;
}

/** "Today", "Tomorrow" or the weekday and date, for a day header. `labels` are the translated words. */
export function dayLabel(day: number, now: number, labels: { today: string; tomorrow: string }, format: (d: Date) => string): string {
  const today = startOfDay(now);
  if (day === today) return labels.today;
  if (day === addDays(today, 1)) return labels.tomorrow;
  return format(new Date(day));
}

