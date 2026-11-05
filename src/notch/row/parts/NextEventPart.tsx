import { calendar, calendarNext } from "../../../features/calendar/store";
import { formatTime } from "../../../lib/format";
import type { CalendarEvent } from "../../../platform/services";
import { measureText } from "../measure";
import { t } from "../../../i18n";

const DOT = 6, GAP = 6, MAX = 170;

/** The next event within the horizon from the settings, null otherwise (the calendar store keeps it current). */
export function useNextEvent(): { event: CalendarEvent; color: string; text: string } | null {
  const event = calendarNext.use();
  const { data } = calendar.use();
  if (!event) return null;
  const color = data?.calendars.find((c) => c.id === event.calendar)?.color || "var(--color-link)";
  return { event, color, text: `${formatTime(event.start)} ${event.title || t("(Ohne Titel)")}` };
}

/** Room for the dot and the text, which is cut off past MAX. */
export const nextEventWidth = (text: string) => DOT + GAP + Math.min(MAX, measureText(text));

/** "14:30 Standup" behind a dot in the calendar's colour. */
export function NextEventPart({ text, color }: { text: string; color: string }) {
  return (
    <span className="flex items-center whitespace-nowrap text-footnote font-medium text-label" style={{ gap: GAP }} title={t("Nächster Termin")}>
      <span className="shrink-0 rounded-full" style={{ width: DOT, height: DOT, background: color }} />
      <span className="truncate" style={{ maxWidth: MAX }}>{text}</span>
    </span>
  );
}
