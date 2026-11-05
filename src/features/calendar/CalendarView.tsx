import { useState } from "react";
import { motion } from "motion/react";
import { ArrowClockwise, CalendarBlank, CaretLeft, CaretRight, SlidersHorizontal, WarningCircle } from "@phosphor-icons/react";
import { content, spin } from "../../design/motion";
import { formatAgo, formatTime } from "../../lib/format";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import type { CalendarEvent } from "../../platform/services";
import { settings } from "../../settings/store";
import { Button, Empty, Skeleton } from "../../ui/controls";
import { locale, t } from "../../i18n";
import { agenda, dayLabel, meetingLink, monthGrid, startOfDay } from "./model";
import { calendar, joinMeeting, refreshCalendar, useCalendarViewer } from "./store";

const DAYS = 7;

/** Error codes from Rust (src-tauri/src/calendar.rs). */
export const calendarError: Record<string, string> = {
  "no-key": "Link oder Passwort fehlt",
  "bad-url": "Adresse ungültig",
  auth: "Anmeldung abgelehnt",
  "not-found": "Kalender nicht gefunden",
  offline: "Keine Verbindung",
  "too-large": "Kalender zu groß",
  parse: "Kalender nicht lesbar",
  "no-calendars": "Keine Kalender im Konto",
  failed: "Abruf fehlgeschlagen",
};

/** "09:30 - 10:00", or the start alone for an event without length; all-day events say so. */
export function eventTime(e: CalendarEvent): string {
  if (e.allDay) return t("Ganztägig");
  return e.end > e.start ? `${formatTime(e.start)} - ${formatTime(e.end)}` : formatTime(e.start);
}

/*
 *   TODAY · SUN 1 NOV
 *   ▍ 09:30 - 09:45   Standup
 *   ▍ 12:30 - 13:30   Lunch with Sam · Café Central
 *   TOMORROW · MON 2 NOV
 *   ▍ All day         Mum's birthday
 */
export function CalendarView() {
  useCalendarViewer();
  const sources = settings.use().calendar.sources;
  const { data, error, loading } = calendar.use();
  // The day the list starts from, picked in the month; null is today (so it moves on at midnight).
  const [picked, setPicked] = useState<number | null>(null);

  const actions = (
    <HeaderActions>
      <HeaderButton label={t("Aktualisieren")} disabled={!sources.length} onClick={() => void refreshCalendar(true)}>
        <motion.span className="flex" animate={{ rotate: loading ? 360 : 0 }} transition={loading ? spin : { duration: 0 }}>
          <ArrowClockwise size={14} weight="bold" />
        </motion.span>
      </HeaderButton>
      <HeaderButton label={t("Kalender-Einstellungen")} onClick={() => navigate("settings", "calendar")}>
        <SlidersHorizontal size={14} weight="bold" />
      </HeaderButton>
    </HeaderActions>
  );

  if (!sources.length) {
    return (
      <>
        {actions}
        <Empty
          icon={CalendarBlank}
          title={t("Kein Kalender verbunden")}
          text={t("Füge einen ICS-Link (Google, Outlook, iCloud) oder ein CalDAV-Konto hinzu. NotNotch liest nur.")}
          action={<Button onClick={() => navigate("settings", "calendar")}>{t("Kalender hinzufügen")}</Button>}
        />
      </>
    );
  }
  if (!data) {
    return (
      <>
        {actions}
        {error ? (
          <Empty icon={WarningCircle} title={t(calendarError[error] ?? "Abruf fehlgeschlagen")} action={<Button onClick={() => void refreshCalendar(true)}>{t("Erneut versuchen")}</Button>} />
        ) : (
          <div className="flex h-full flex-col gap-3 px-5 pt-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
      </>
    );
  }

  const now = Date.now();
  const colors = new Map(data.calendars.map((c) => [c.id, c.color]));
  const names = new Map(data.calendars.map((c) => [c.id, c.name]));
  const from = picked ?? startOfDay(now);
  // The picked day always shows; later days only when something is on.
  const days = agenda(data.events, from, DAYS).filter((d, i) => i === 0 || d.events.length);
  const failing = data.sources.filter((s) => s.error);
  const label = (day: number) => {
    const date = new Date(day).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });
    const word = dayLabel(day, now, { today: t("Heute"), tomorrow: t("Morgen") }, () => "");
    return word ? `${word} · ${date}` : date;
  };
  const failText = failing
    .map((f) => {
      const name = settings.get().calendar.sources.find((s) => s.id === f.id)?.name || t("Kalender");
      return `${name}: ${t(calendarError[f.error!] ?? "Abruf fehlgeschlagen")}`;
    })
    .join(" · ");

  return (
    <motion.div
      className="flex h-full flex-col px-5 pt-1 pb-2"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
    >
      {actions}
      <div className="flex min-h-0 flex-1 gap-5">
        <Month events={data.events} colors={colors} now={now} picked={from} onPick={(d) => setPicked(d === startOfDay(now) ? null : d)} />
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]" style={{ maskImage: "linear-gradient(180deg, #000 calc(100% - 20px), transparent)" }}>
          {days.map((d) => (
            <section key={d.day} className="pb-2">
              <h3 className="py-1 text-caption font-medium tracking-wide text-label-3 uppercase">{label(d.day)}</h3>
              {d.events.length === 0 && <div className="py-1 text-footnote text-label-4">{t("Keine Termine")}</div>}
              {d.events.map((e) => {
                const past = e.end <= now && !(e.end === e.start && e.start > now);
                const link = past ? null : meetingLink(e);
                return (
                  <div key={`${d.day}:${e.id}`} className={`flex items-center gap-2.5 py-[3px] ${past ? "opacity-45" : ""}`} title={names.get(e.calendar)}>
                    <span className="h-4 w-[3px] shrink-0 rounded-full" style={{ background: colors.get(e.calendar) || "var(--color-link)" }} />
                    <span className="tabular min-w-[104px] shrink-0 whitespace-nowrap text-footnote text-label-3">{eventTime(e)}</span>
                    <span className="min-w-0 flex-1 truncate text-footnote text-label">
                      {e.title || t("(Ohne Titel)")}
                      {e.location && <span className="text-label-3"> · {e.location}</span>}
                    </span>
                    {link && (
                      <button className="pressable pressable-fill shrink-0 rounded-full bg-fill-2 px-2.5 py-0.5 text-caption font-medium text-label" title={new URL(link).hostname} onClick={() => joinMeeting(e.id, link)}>
                        {t("Beitreten")}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
      <div className="truncate pt-1 text-caption text-label-4" title={failText || undefined}>
        {failing.length ? failText : formatAgo(now - data.fetchedAt)}
      </div>
    </motion.div>
  );
}

/** First day of the week for the UI language (Intl week info), Monday when the runtime cannot tell. */
function firstWeekday(): number {
  try {
    const l = new Intl.Locale(locale()) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    return info ? info.firstDay % 7 : 1;
  } catch {
    return 1;
  }
}

/*
 *   ‹  November 2026  ›
 *   M  T  W  T  F  S  S
 *   26 27 28 29 30 31  1
 *    2  3  4 ...           a dot per calendar with events that day
 */
function Month(p: { events: CalendarEvent[]; colors: Map<string, string>; now: number; picked: number; onPick: (day: number) => void }) {
  const today = startOfDay(p.now);
  // From the previous month to two ahead: the span calendar.rs fetches.
  const [shift, setShift] = useState(0);
  const anchor = new Date(today);
  anchor.setDate(1);
  anchor.setMonth(anchor.getMonth() + shift);
  const cells = monthGrid(p.events, anchor.getTime(), firstWeekday());
  const step = (by: number) => setShift((s) => Math.min(2, Math.max(-1, s + by)));
  const arrow = "pressable rounded-full p-1 text-label-3 hover:text-label-2 disabled:opacity-30";
  return (
    <div className="flex w-[212px] shrink-0 flex-col">
      <div className="flex items-center justify-between pb-1">
        <button className={arrow} aria-label={t("Zurück")} disabled={shift <= -1} onClick={() => step(-1)}>
          <CaretLeft size={12} weight="bold" className="rtl:-scale-x-100" />
        </button>
        <button
          className="pressable text-footnote font-semibold text-label capitalize"
          title={t("Heute")}
          onClick={() => {
            setShift(0);
            p.onPick(today);
          }}
        >
          {anchor.toLocaleDateString(locale(), { month: "long", year: "numeric" })}
        </button>
        <button className={arrow} aria-label={t("Weiter")} disabled={shift >= 2} onClick={() => step(1)}>
          <CaretRight size={12} weight="bold" className="rtl:-scale-x-100" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-caption text-label-4">
        {cells.slice(0, 7).map((c) => (
          <span key={c.day} className="pb-0.5">
            {new Date(c.day).toLocaleDateString(locale(), { weekday: "narrow" })}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((c) => {
          const isToday = c.day === today;
          const isPicked = c.day === p.picked;
          return (
            <button
              key={c.day}
              onClick={() => p.onPick(c.day)}
              aria-label={new Date(c.day).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" })}
              aria-pressed={isPicked}
              className={`pressable flex h-[26px] flex-col items-center justify-center rounded-[8px] ${isPicked ? "bg-fill-3" : "hover:bg-fill-1"}`}
            >
              <span
                className={`tabular flex size-[17px] items-center justify-center rounded-full text-caption leading-none ${
                  isToday ? "bg-label font-semibold text-black" : c.inMonth ? "text-label" : "text-label-4"
                }`}
              >
                {new Date(c.day).getDate()}
              </span>
              <span className="flex h-[5px] items-center gap-[2px]">
                {c.calendars.slice(0, 3).map((id) => (
                  <span key={id} className="size-[4px] rounded-full" style={{ background: p.colors.get(id) || "var(--color-link)", opacity: c.inMonth ? 1 : 0.4 }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
