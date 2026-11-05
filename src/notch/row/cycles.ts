// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/ScrollCycles.cs.
// Timing of the collapsed row's scrolling parts (carousels, title) as plain functions of the seconds since a cycle began, so the row waits out the rests on a timer and animates only while something moves. Seconds, CSS px.

const GLIDE = { hold: 2.5, endHold: 2, speed: 12, fade: 0.25 } as const, MARQUEE = { rest: 1.5, speed: 24, laps: 3 } as const, LEAD = 0.05;

/** A stretch of a cycle: whether its values move in it, and when it starts and ends. */
export interface Stretch { moving: boolean; start: number; end: number }
export interface Cycle { period: number; shift(t: number): number; opacity(t: number): number; moving(t: number): boolean; stretch(t: number): Stretch }

// ((t % P) + P) % P, but a t already in [0, P) comes back untouched: adding P rounds it by an ulp, and a boundary looked up as `stretch(s.end)` then falls in the stretch before.
const wrap = (t: number, period: number) => { if (!(period > 0 && Number.isFinite(t))) return 0; const r = t % period; return r >= 0 ? r : (r + period) % period; };

const sample = (t: number, a: number, b: number) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
const slope = (t: number, a: number, b: number) => 3 * (1 - 3 * b + 3 * a) * t * t + 2 * (3 * b - 6 * a) * t + 3 * a;
/** CSS cubic-bezier(x1, y1, x2, y2): the progress at the elapsed fraction x. Newton steps on x(t), then bisection for what they leave (a flat slope near an end). */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  x = Math.min(1, Math.max(0, x));
  let t = x;
  for (let i = 0; i < 8; i++) { const s = slope(t, x1, x2); if (Math.abs(s) < 1e-6) break; t = Math.min(1, Math.max(0, t - (sample(t, x1, x2) - x) / s)); }
  if (Math.abs(sample(t, x1, x2) - x) > 1e-5) for (let lo = 0, hi = 1, i = 0; i < 30; i++) { t = (lo + hi) / 2; if (sample(t, x1, x2) < x) lo = t; else hi = t; }
  return sample(t, y1, y2);
}

/** Rings and readings: rest, glide by `travel` px, rest, fade out, jump back, fade in. */
export function glideCycle(travel: number): Cycle {
  const { hold, endHold, speed, fade } = GLIDE, glideEnd = hold + travel / speed, resetStart = glideEnd + endHold, period = resetStart + 2 * fade;
  const stretch = (t: number): Stretch => {
    const at = wrap(t, period);
    return at < hold ? { moving: false, start: 0, end: hold } : at < glideEnd ? { moving: true, start: hold, end: glideEnd }
      : at < resetStart ? { moving: false, start: glideEnd, end: resetStart } : { moving: true, start: resetStart, end: period };
  };
  return {
    period, stretch, moving: (t) => stretch(t).moving,
    shift(t) { const at = wrap(t, period); return at < hold ? 0 : at < glideEnd ? -travel * bezier(0.4, 0, 0.6, 1, (at - hold) / (glideEnd - hold)) : at < resetStart + fade ? -travel : 0; },
    opacity(t) { const at = wrap(t, period); return at < resetStart ? 1 : at < resetStart + fade ? 1 - (at - resetStart) / fade : Math.min(1, (at - resetStart - fade) / fade); },
  };
}

/** The scrolling title: rest, glide by `overflow` px, rest, start over. `done` once it has scrolled its laps, then it rests at its start until something restarts it. */
export function marqueeCycle(overflow: number): Cycle & { done(played: number): boolean } {
  const { rest, speed, laps } = MARQUEE, travel = overflow / speed, glideEnd = rest + travel, period = 2 * rest + travel;
  const stretch = (t: number): Stretch => {
    const at = wrap(t, period);
    return at < rest ? { moving: false, start: 0, end: rest } : at < glideEnd ? { moving: true, start: rest, end: glideEnd } : { moving: false, start: glideEnd, end: period };
  };
  return {
    period, stretch, moving: (t) => stretch(t).moving, opacity: () => 1,
    shift(t) { const at = wrap(t, period); return at < rest ? 0 : at < glideEnd ? -overflow * ((at - rest) / travel) : -overflow; },
    done: (played) => Number.isFinite(played) && played >= laps * period - 1e-9,
  };
}

/**
 * What a running cycle does at `at`: `now` is its stretch then, `next` the one after (taken at now.end). `into` is how far into the moving stretch (now, else next) the cycle is, negative when it starts that much later,
 * and is there only when a move is to be handed to an animation. A move is handed over `lead` early so a timer that wakes late never delays it. `wait` is how long to sleep before looking again.
 */
export function planTurn(now: Stretch, next: Stretch, at: number, lead = LEAD): { into?: number; wait: number } {
  if (now.moving) return { into: at - now.start, wait: Math.max(0, now.end - at) };
  const left = Math.max(0, now.end - at);
  if (!next.moving) return { wait: left };
  if (left <= lead) return { into: at - next.start, wait: Math.max(0, next.end - at) };
  return { wait: left - lead };
}
