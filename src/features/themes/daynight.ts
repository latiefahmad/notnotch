// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/PanelThemes.Daylight.cs.

import { THEME_DEFAULTS, type ThemeSettings } from "./themes.ts";

/** Day and night: which of two themes is due at a local time, and when the next change comes. */

/** "HH:mm" as minutes after midnight, or null. */
export function parseTime(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** The day's start and end in minutes; invalid or equal times (a day that never ends) fall back to the defaults. */
function hours(schedule: ThemeSettings["schedule"]): [number, number] {
  const day = parseTime(schedule.dayStart), night = parseTime(schedule.nightStart);
  if (day !== null && night !== null && day !== night) return [day, night];
  return [parseTime(THEME_DEFAULTS.schedule.dayStart)!, parseTime(THEME_DEFAULTS.schedule.nightStart)!];
}

/** Whether it is night at this local time. The day may run past midnight (a night shift's 20:00 to 08:00). */
export function isNight(schedule: ThemeSettings["schedule"], now: Date): boolean {
  const [day, night] = hours(schedule);
  const m = now.getHours() * 60 + now.getMinutes();
  const daytime = day < night ? m >= day && m < night : m >= day || m < night;
  return !daytime;
}

/** The next local time the theme changes, after `now`. */
export function nextChange(schedule: ThemeSettings["schedule"], now: Date): Date {
  const next = (minutes: number) => {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minutes / 60), minutes % 60);
    return t > now ? t : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, Math.floor(minutes / 60), minutes % 60);
  };
  const [a, b] = hours(schedule).map(next);
  return a < b ? a : b;
}

/** The theme due now: the chosen one, or with the schedule on the day or night theme. */
export function activeThemeId(themes: ThemeSettings, now: Date): string {
  if (!themes.schedule.on) return themes.id;
  return isNight(themes.schedule, now) ? themes.schedule.night : themes.schedule.day;
}

/** Choosing a theme: with the schedule on it takes the place of the theme due now. */
export function chooseTheme(themes: ThemeSettings, id: string, now: Date): ThemeSettings {
  if (!themes.schedule.on) return { ...themes, id };
  const slot = isNight(themes.schedule, now) ? "night" : "day";
  return { ...themes, schedule: { ...themes.schedule, [slot]: id } };
}

/** Every half hour of the day as "HH:mm", for the time menus. */
export const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
