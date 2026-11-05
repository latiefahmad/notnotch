// Recording time on screen. Rust reports the recorded time whenever the state changes (start, pause, resume);
// in between the display counts on from that report while recording and stands still while paused.

export type RecPhase = "idle" | "recording" | "paused";

export interface RecClock {
  phase: RecPhase;
  /** Recorded time at `at`, pauses left out. */
  elapsedMs: number;
  /** Local time (Date.now) of the report. */
  at: number;
}

export function elapsedAt(c: RecClock, now: number): number {
  return c.phase === "recording" ? c.elapsedMs + Math.max(0, now - c.at) : c.elapsedMs;
}

/** "0:07", "12:34", "1:02:03" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
