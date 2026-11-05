/** The last forecast fetched, kept on disk for when Open-Meteo doesn't answer. */
export interface SavedForecast<T> {
  key: string;
  at: number;
  data: T;
}

/** Older than this the current conditions say too little: the view shows its error instead. */
export const SAVED_FOR_MS = 24 * 60 * 60_000;

/**
 * The saved forecast for this place, marked with when it was fetched and without the days already past
 * (`today` as YYYY-MM-DD); null when there is none, it is for another place, or it is too old.
 */
export function savedForecast<T extends { daily: { date: string }[] }>(
  saved: SavedForecast<T> | null,
  key: string,
  now: number,
  today: string,
): (T & { savedAt: number }) | null {
  if (!saved || saved.key !== key || now - saved.at > SAVED_FOR_MS) return null;
  return { ...saved.data, daily: saved.data.daily.filter((d) => d.date >= today), savedAt: saved.at };
}
