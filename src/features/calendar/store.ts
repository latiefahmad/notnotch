import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { fetchCalendar, openMeetingLink, type CalendarData, type CalendarEvent } from "../../platform/services";
import { settings } from "../../settings/store";
import { dueEvent, nextChange, nextEvent } from "./model";

/** Rust caches for ten minutes; the poll asks a little more often so a change shows within a quarter hour. */
const POLL_MS = 12 * 60_000;

/** The agenda shared by the tool, the notice and the closed-row part. `error` is a code when the whole call failed. */
export const calendar = createStore<{ data: CalendarData | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });

/** The event announced in the closed notch, set by the scheduler; null while none is due or the notice or tool is off. */
export const calendarDue = createStore<CalendarEvent | null>(null);
/** The next event within the part's horizon (only while the part is on). */
export const calendarNext = createStore<CalendarEvent | null>(null);

const dismissed = new Set<string>();
let latest = 0;

const toolOn = () => settings.get().tools.some((t) => t.id === "calendar" && t.enabled);

export function refreshCalendar(force = false): Promise<void> {
  const call = ++latest;
  const sources = settings.get().calendar.sources.map(({ id, kind, url, user, name, color }) => ({ id, kind, url, user, name, color }));
  calendar.set((c) => ({ ...c, loading: true }));
  return fetchCalendar(sources, force).then(
    (data) => {
      if (call === latest) calendar.set({ data, error: null, loading: false });
    },
    (e) => {
      if (call === latest) calendar.set((c) => ({ ...c, error: String(e), loading: false }));
    },
  );
}

/** Hides the notice for this event. */
export function dismissCalendarNotice(id: string) {
  dismissed.add(id);
  schedule();
}

/** Opens the event's meeting link (from meetingLink) and hides its notice: once joined, it has done its job. */
export function joinMeeting(id: string, link: string) {
  openMeetingLink(link);
  dismissCalendarNotice(id);
}

// One timeout to the next moment the notice or the part changes (at most a minute, for standby and clock changes).
let timeout: number | undefined;
function schedule() {
  window.clearTimeout(timeout);
  const now = Date.now();
  const s = settings.get();
  const on = toolOn();
  const events = on ? (calendar.get().data?.events ?? []) : [];
  const { notice, noticeMin, horizonMin } = s.calendar;
  const due = notice ? dueEvent(events, now, noticeMin, dismissed) : null;
  if (due?.id !== calendarDue.get()?.id) calendarDue.set(due);
  const next = s.closed.parts.calendar ? nextEvent(events, now) : null;
  const shown = next && next.start - now <= horizonMin * 60_000 ? next : null;
  if (shown !== calendarNext.get()) calendarNext.set(shown);
  const at = nextChange(events, now, [noticeMin * 60_000, horizonMin * 60_000]);
  if (at !== null) timeout = window.setTimeout(schedule, Math.min(60_000, at - now) + 20);
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastSources = "";
function apply() {
  const s = settings.get();
  const key = JSON.stringify(s.calendar.sources);
  const wanted = toolOn() && s.calendar.sources.length > 0;
  if (key !== lastSources) {
    // Added, edited or removed: fetch at once (an empty list also clears Rust's cache file).
    lastSources = key;
    if (wanted || !s.calendar.sources.length) void refreshCalendar();
  }
  if (!wanted) {
    if (timer) clearInterval(timer);
    timer = null;
  } else if (!timer) {
    const { data, loading } = calendar.get();
    if (!loading && (!data || Date.now() - data.fetchedAt >= POLL_MS)) void refreshCalendar();
    timer = setInterval(() => void refreshCalendar(), POLL_MS);
  }
  schedule();
}

export function startCalendar() {
  apply();
  settings.subscribe(apply);
  calendar.subscribe(schedule);
}

/** For the tool: refreshes on open when the data is older than five minutes. */
export function useCalendarViewer() {
  useEffect(() => {
    const { data, loading } = calendar.get();
    if (!loading && settings.get().calendar.sources.length && (!data || Date.now() - data.fetchedAt >= 5 * 60_000)) void refreshCalendar();
  }, []);
}
