/**
 * Undo for the theme editor. Changes to the same thing that follow each other within
 * `COALESCE_MS` (dragging across the colour square) are one step, so Undo goes back to where the
 * drag began; a change to something else is always a step of its own.
 */
export const COALESCE_MS = 600;
const LIMIT = 100;

export interface History<T> {
  past: T[];
  present: T;
  /** Time and subject of the last change, for coalescing. */
  at: number;
  key: string | null;
}

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, at: -Infinity, key: null });

export function record<T>(h: History<T>, next: T, now: number, key: string): History<T> {
  if (h.past.length > 0 && key === h.key && now - h.at < COALESCE_MS) return { ...h, present: next, at: now };
  return { past: [...h.past, h.present].slice(-LIMIT), present: next, at: now, key };
}

/** One step back; the same history when there is nothing to undo. */
export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], at: -Infinity, key: null };
}

/** The state before the first change. */
export const original = <T>(h: History<T>): T => h.past[0] ?? h.present;
